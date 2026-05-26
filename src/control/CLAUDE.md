# Control Module

Workflow control plane handlers that sit above both the workflow kernel (`src/core/`) and tracker observability (`src/tracker/`).

Dashboard HTTP routes should stay thin: parse/validate request bodies, call this module, then map results back to route-specific response shapes. Do not put cancel/retry/delete/bump blast-radius logic in `src/tracker/dashboard/`.

## Files

- `actions/perform-workflow-action.ts` — `performWorkflowAction` dispatcher for operator cancel / retry / delete / bump.
- `actions/resolve-targets.ts` — resolves action scope into concrete targets. `tree` may walk tracker projection parent/child runs; `row`, `group`, and `visible-view` use caller-provided targets.
- `actions/types.ts` — `WorkflowActionRequest`, `WorkflowActionResult`, and related contracts.
- `ops/cancel.ts` — low-level queued/running/bulk cancel handlers.
- `ops/retry.ts` — low-level retry/re-enqueue and edit-and-resume handlers.
- `ops/delete.ts` — low-level tracker row, screenshot, and delegated-child deletion.
- `ops/emit-inherited.ts` — private helper for control-layer tracker rows that must inherit display metadata, `parentRunId`, and row archetype from a prior row.
- `ops/queue.ts` — queue bump, save-data, queue-depth, and prior-entry lookup handlers.
- `ops/worker-control.ts` — daemon/worker/browser operational controls.
- `ops/shared.ts` — shared handler helpers; keep private to `ops/`.
- `ocr/discard.ts` — OCR prep discard/cancel glue. It remains here because discard is routed through central workflow cancel and also needs delegated-child cleanup.
- `index.ts` — public barrel for routes and tests.

## Boundaries

- `src/control/` may import from `src/core/`, `src/tracker/`, `src/services/`, `src/infra/`, and workflow handlers when an existing in-process retry path requires it.
- `src/core/` must not import `src/control/`.
- Tracker Hono routes may import `src/control/` as HTTP adapters. Other tracker modules should keep observability concerns local unless there is a deliberate control-plane path.
- OCR discard was moved with the action engine instead of leaving `control/actions` dependent on the dashboard OCR barrel. The handler still imports narrow tracker OCR helpers for abort flags and parent metadata reads.

## Cancel contract (Contract 5 — Unified Cancel)

There is one cancel mechanism:

- The kernel's `runOneItem` / `runWorkflow` constructs a per-run `AbortController` and registers a `RunHandle` (with the controller + `Session`) on the module-level `runRegistry` (`src/core/run-registry.ts`); the handle unregisters in `finally`. The signal is exposed as `ctx.signal` AND auto-injected into every `signal?: AbortSignal` option of Playwright methods via the Proxy returned by `ctx.page(id)` (see `src/core/kernel/page-proxy.ts`).
- Every cancel trigger routes through `runRegistry.cancel(runId, { reason })`: the daemon `cancel_task` worker command (issued by `buildCancelRunningHandler` for running rows, or by `buildCancelQueuedHandler` for queued rows that get claimed mid-cancel), the HTTP `/cancel-current` route, the dashboard in-process cancel route (`buildCancelRunningHandler` → direct registry call when no daemon owns the task), and the browser-disconnect handler. `cancel` aborts the controller (any in-flight `waitForSelector` / `click` / `goto` / `fill` rejects with an AbortError within ms), writes the SQLite cancel audit when the handle carries in-process `control` metadata, and schedules a watchdog that hard-kills chromium after `hardKillAfterMs` (default 5000ms; daemon shutdown passes 0 to skip the watchdog) if the run hasn't unregistered by then — covers pre-handler launch hangs (e.g. stuck on Duo). The stepper's catch block sees `controller.signal.aborted` and remaps the error to `CancelledError('cancelled')` → `step: "cancelled"` on the terminal row.
- The stepper's between-step probe reads `controller.signal.aborted` as the synchronous-checkpoint when no Playwright call is in flight. Both paths produce the same terminal-row shape: `status: "failed"`, `step: "cancelled"`, `error: "Cancelled by user before step 'cancelled'"`.
- **Gone (2026-05-23):** `buildForceStopTaskHandler`, the `ForceStopTaskRequest` type, the `CancelMode = "cooperative" | "force"` type, the `/api/task/force-stop` route, the daemon's `/force-current` route, `createInterruptInFlightWork`, and the dashboard's Force Stop button transport. The Page proxy makes them all redundant — cancel propagates fast enough through the signal that the about:blank navigation trick is unnecessary.
- The browser stays alive (no chrome teardown, no re-Duo on the next item). The daemon's existing post-cancel `session.reset(sysId)` loop restores each system's resetUrl before claiming the next item.

`performWorkflowAction({ action: "cancel", ... })` in `actions/perform-workflow-action.ts` dispatches by target status only: `t.status === "running"` → `buildCancelRunningHandler`; otherwise → `buildCancelQueuedHandler`. No mode switch.

## Retry contract (Contract 2 — Uniform Retry)

Retry is **uniform kernel behavior**, not a per-workflow capability:

- Every retry assigns a new `runId`, re-runs the handler from step 0, and feeds the workflow the **pristine original input** the task was first enqueued with — never accumulated state from a prior run.
- The pristine input lives in `tasks.original_input_json` (SQLite, migration 11). `enqueueTasks` writes it on INSERT and preserves it on adopt-existing via `COALESCE`. `retryTaskFromAttempt` deliberately resets `input_json ← original_input_json` so the daemon's claim path hands the handler the original payload.
- `reEnqueueEntry` (`ops/retry.ts`) implements a three-way split for input resolution: (1) **SQLite-happy** — `findOriginalInputForRunId` returns the pristine original input, used directly; (2) **SQLite-null-original** — row exists but `original_input_json` is null, returns a structured error (bug, not legacy state, since migration 11 always stamps at enqueue); (3) **SQLite-pruned** — task record deleted by cleanup, falls back to JSONL reconstruction via `findEntryInput` + `mergeAccumulatedTrackerStrings` + `enqueueFromHttp`. `findEntryInput` is also used for edit-and-resume `prefilledData`, which legitimately needs to fold previously-extracted fields into the prefill channel. It uses a raw SQLite snapshot before mapped task reads so a corrupt row with both columns null returns a structured error instead of throwing while parsing `input_json`.
- The new pending row carries `data.__retriedFrom = <prior runId>` for dashboard provenance and uses `ops/emit-inherited.ts` to preserve prior display metadata + row archetype while emitting the fresh retry `runId`.

There is **no `supportsRetry` flag**, no `WorkflowDoesNotSupportRetryError`, no per-workflow gate. If a workflow's step has irreversible side effects, the workflow is responsible for probing live system state before re-executing (the standard pattern is `findExistingTerminationTransaction`-style; see `src/workflows/separations/`). Known idempotency gaps are documented per-workflow in `src/workflows/{onboarding,work-study,oath-upload,old-kronos-reports}/CLAUDE.md` → "Retry safety".

## Lessons Learned

- **2026-05-24: Control-layer replacement rows should use `emitInheritedRow`.** Cancel, OCR discard, and retry pending rows are replacement/status rows, not fresh workflow output. Route them through `ops/emit-inherited.ts` so they preserve prior display metadata, inherit `parentRunId` unless explicitly overridden, and keep the prior row archetype final after caller data is merged.
- **2026-05-24: Retry corruption checks must avoid mapped task reads.** `TaskRow` mapping parses `tasks.input_json`, so retry control code that is classifying missing-input corruption should read the raw SQLite columns first; otherwise a row with both `original_input_json` and `input_json` null throws before the handler can return its structured operator-facing error.
- **2026-05-22: Workflow control moved out of tracker.** `src/tracker/` owns JSONL/projection/SSE observability. Operator action dispatch and low-level cancel/retry/delete/queue handlers live in `src/control/` because they mutate SQLite control state, enqueue work, issue worker commands, and also need tracker audit/projection reads. Keep future workflow control behavior in this module and leave dashboard routes as adapters.
