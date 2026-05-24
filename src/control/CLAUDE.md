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

- The kernel's `runOneItem` constructs a per-run `AbortController`. The signal is exposed as `ctx.signal` AND auto-injected into every `signal?: AbortSignal` option of Playwright methods via the Proxy returned by `ctx.page(id)` (see `src/core/kernel/page-proxy.ts`).
- A `cancel_task` worker command (issued by `buildCancelRunningHandler` for running rows, or by `buildCancelQueuedHandler` for queued rows that get claimed mid-cancel) AND the HTTP `/cancel-current` route both abort the daemon's `state.currentRunController` in lockstep with setting `state.cancelTarget`. Any in-flight `waitForSelector` / `click` / `goto` / `fill` rejects with an AbortError within ms; the stepper's catch block sees `isCancelRequested()` is true and remaps the error to `CancelledError('cancelled')` → `step: "cancelled"` on the terminal row.
- The stepper's between-step `isCancelRequested` probe remains as the synchronous-checkpoint when no Playwright call is in flight. Both paths produce the same terminal-row shape: `status: "failed"`, `step: "cancelled"`, `error: "Cancelled by user before step 'cancelled'"`.
- **Gone (2026-05-23):** `buildForceStopTaskHandler`, the `ForceStopTaskRequest` type, the `CancelMode = "cooperative" | "force"` type, the `/api/task/force-stop` route, the daemon's `/force-current` route, `createInterruptInFlightWork`, and the dashboard's Force Stop button transport. The Page proxy makes them all redundant — cancel propagates fast enough through the signal that the about:blank navigation trick is unnecessary.
- The browser stays alive (no chrome teardown, no re-Duo on the next item). The daemon's existing post-cancel `session.reset(sysId)` loop restores each system's resetUrl before claiming the next item.

`performWorkflowAction({ action: "cancel", ... })` in `actions/perform-workflow-action.ts` dispatches by target status only: `t.status === "running"` → `buildCancelRunningHandler`; otherwise → `buildCancelQueuedHandler`. No mode switch.

## Retry contract (Contract 2 — Uniform Retry)

Retry is **uniform kernel behavior**, not a per-workflow capability:

- Every retry assigns a new `runId`, re-runs the handler from step 0, and feeds the workflow the **pristine original input** the task was first enqueued with — never accumulated state from a prior run.
- The pristine input lives in `tasks.original_input_json` (SQLite, migration 11). `enqueueTasks` writes it on INSERT and preserves it on adopt-existing via `COALESCE`. `retryTaskFromAttempt` deliberately resets `input_json ← original_input_json` so the daemon's claim path hands the handler the original payload.
- `reEnqueueEntry` (`ops/retry.ts`) reads `findOriginalInputForRunId` from the task store and errors out if it's null — historic rows that predate migration 11 were purged, so a null here is a bug, not a legacy state. It uses a raw SQLite snapshot before mapped task reads so a corrupt row with both `original_input_json` and `input_json` null returns a structured retry error instead of throwing while parsing `input_json`. `findEntryInput` + `mergeAccumulatedTrackerStrings` remains in use only for the edit-and-resume `prefilledData` path, which legitimately needs to fold previously-extracted fields into the prefill channel.
- The new pending row carries `data.__retriedFrom = <prior runId>` for dashboard provenance.

There is **no `supportsRetry` flag**, no `WorkflowDoesNotSupportRetryError`, no per-workflow gate. If a workflow's step has irreversible side effects, the workflow is responsible for probing live system state before re-executing (the standard pattern is `findExistingTerminationTransaction`-style; see `src/workflows/separations/`). Known idempotency gaps are documented per-workflow in `src/workflows/{onboarding,work-study,oath-upload,old-kronos-reports}/CLAUDE.md` → "Retry safety".

## Lessons Learned

- **2026-05-24: Retry corruption checks must avoid mapped task reads.** `TaskRow` mapping parses `tasks.input_json`, so retry control code that is classifying missing-input corruption should read the raw SQLite columns first; otherwise a row with both `original_input_json` and `input_json` null throws before the handler can return its structured operator-facing error.
- **2026-05-22: Workflow control moved out of tracker.** `src/tracker/` owns JSONL/projection/SSE observability. Operator action dispatch and low-level cancel/retry/delete/queue handlers live in `src/control/` because they mutate SQLite control state, enqueue work, issue worker commands, and also need tracker audit/projection reads. Keep future workflow control behavior in this module and leave dashboard routes as adapters.
