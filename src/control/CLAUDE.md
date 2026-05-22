# Control Module

Workflow control plane handlers that sit above both the workflow kernel (`src/core/`) and tracker observability (`src/tracker/`).

Dashboard HTTP routes should stay thin: parse/validate request bodies, call this module, then map results back to route-specific response shapes. Do not put cancel/retry/delete/bump blast-radius logic in `src/tracker/dashboard/`.

## Files

- `actions/perform-workflow-action.ts` — `performWorkflowAction` dispatcher for operator cancel / retry / delete / bump.
- `actions/resolve-targets.ts` — resolves action scope into concrete targets. `tree` may walk tracker projection parent/child runs; `row`, `group`, and `visible-view` use caller-provided targets.
- `actions/types.ts` — `WorkflowActionRequest`, `WorkflowActionResult`, `CancelMode`, and related contracts.
- `ops/cancel.ts` — low-level queued/running/force-stop/bulk cancel handlers.
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

## Lessons Learned

- **2026-05-22: Workflow control moved out of tracker.** `src/tracker/` owns JSONL/projection/SSE observability. Operator action dispatch and low-level cancel/retry/delete/queue handlers live in `src/control/` because they mutate SQLite control state, enqueue work, issue worker commands, and also need tracker audit/projection reads. Keep future workflow control behavior in this module and leave dashboard routes as adapters.
