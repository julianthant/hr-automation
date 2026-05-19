# Delegation Behavior Map

Last checked: 2026-05-18

This is a current-state map of delegation rows, batch views, dashboard stages, and cancellation behavior. It is meant to be edited with the desired row copy/behavior before changing code.

## Source Map

- Queue surface classifier: `src/tracker/queue-surfaces.ts`
- Dashboard wrapper around classifier: `src/dashboard/components/queue-panel/queue-surface-classifier.ts`
- Queue renderer and batch-mode switch: `src/dashboard/components/queue-panel/QueuePanel.tsx`
- Group card base UI: `src/dashboard/components/queue-panel/group-row-base.tsx`
- Approval delegation card: `src/dashboard/components/ocr/DelegationRow.tsx`
- Daemon/batch card: `src/dashboard/components/queue-panel/DaemonBatchRow.tsx`
- Batch mode toolbar/member list: `src/dashboard/components/queue-panel/batch-queue-view.tsx`
- Flat queue row and per-row controls: `src/dashboard/components/queue-panel/EntryItem.tsx`
- Queued cancel/bump control: `src/dashboard/components/queue-panel/QueueItemControls.tsx`
- Running stop control: `src/dashboard/components/queue-panel/CancelRunningButton.tsx`
- Cancel backend: `src/tracker/dashboard/ops/cancel.ts`
- Daemon cancel handling: `src/core/daemon/daemon.ts`
- Parent/child dependency behavior: `src/core/task-store/child-state.ts`, `src/core/task-store/terminal.ts`
- Row archetype rules: `src/domain/row-archetype.ts`
- OCR approval fan-out: `src/tracker/dashboard/ocr/approve.ts`
- OCR discard/cancel: `src/tracker/dashboard/ocr/discard.ts`
- Oath Upload orchestration: `src/workflows/oath-upload/handler.ts`

## Vocabulary

`parentRunId` is the dashboard relationship key. If row B has `parentRunId = rowA.runId`, the dashboard can show B under A or in A's batch mode.

`data.archetype` is the current row discriminator:

| Archetype | Current meaning |
|---|---|
| `single` | One normal flat queue row. |
| `batch-parent` | Anchor row for a prep/delegating parent. OCR prep and Oath Upload root rows use this. |
| `batch-member` | Peer item under a batch parent. |
| `dispatch` | Terminal-at-enqueue row saying "I delegated to children." Currently mostly historical/diagnostic. |
| `delegate-child` | Cross-workflow child that still needs operator attention. |
| `passive-child` | Cross-workflow utility child collapsed into its parent card; not meant to hold operator attention. |

The dashboard should read `resolveRowArchetype(entry)`, not old fields such as `taskRole`, `requestRole`, or `data.mode` except for legacy fallback.

## Queue Surface Types

The queue does not render every tracker row as a separate top-level row. `buildTrackerQueueSurfaces()` produces grouped cards plus flat rows.

| Surface | Trigger now | Top-level row now | Batch view now |
|---|---|---|---|
| Approval delegation | A `batch-parent` row that is not discarded. Usually OCR prep. | `DelegationRow`, a card over the prep parent and its members. | Clicking opens one-level batch mode with normal `EntryItem` rows for members. Toolbar can show "Open prep review" for prep anchors. |
| Passive delegation | Members under a parent are `passive-child`. | `GroupRowBase` with title `parentSubject` or "Delegated utility work". | Clicking opens member list. |
| Batch | Multiple children share a `parentRunId`, or multiple delegated `batch-parent` rows share an upstream parent. | `DaemonBatchRow`, a card with count, status totals, preview children, retry-all and delete-all. | Clicking opens member list. |
| Flat row | Anything not grouped, including a single delegated child in many cases. | `EntryItem`. | No batch mode unless it is itself part of an opened parent group. |

Important current rule: Oath Signature multi-file upload is a dashboard grouping over single-file prep runs. The modal posts each PDF as its own `/api/ocr/prepare` request, with a shared `originBatchRunId` used only as the file rows' `parentRunId`. One delegated OCR file becomes a flat single row. Multiple delegated OCR files become one daemon batch row over those file rows. OCR-to-EID fan-out stays as delegation member rows, not a batch delegated row.

## What The Group Cards Show Now

All group cards use `GroupRowBase`.

Current card content:

- Header title.
- `done / total` count.
- Status totals: done, running, queued, failed.
- Progress bar segmented by status.
- Up to 3 preview child rows, sorted running > queued > done > failed.
- Footer: time, run number, secondary id, elapsed/duration, optional actions.

Current actions:

- `DelegationRow`: retry prep parent, delete prep parent.
- `DaemonBatchRow`: retry all members, delete all members.
- Passive delegation: no explicit footer actions.

## Desired Queue Row Copy

Fill these in before changing UI behavior.

| Delegation scenario | Current top-level row | What I want in the row |
|---|---|---|
| Direct OCR prep for Oath Signature | Approval delegation / prep row; title is PDF name when available. | Title is the PDF name. Footer/subtitle uses the default title: `Oath · <last 4 of run id>`. |
| Direct OCR prep for Emergency Contact | Approval delegation / prep row; title from queue title or PDF name. | TODO |
| Oath Upload root while OCR is running | Oath Upload root is `batch-parent`; OCR child is delegated with `parentRunId`. | TODO |
| Oath Upload after OCR approved, waiting on oath-signature children | Parent row updates `wait-ocr-approval`; child oath-signature rows have parent dependency rows. | Keep using the same existing row that started the run. Do not create a new row after approval; the batch view/member content changes underneath it. |
| OCR utility lookup children (`eid-lookup`, `active-check`) | Passive delegation or grouped utility card. | TODO |
| SharePoint download delegated from OCR roster download | Passive utility child under OCR prep. | TODO |
| Multiple delegated OCR prep rows under one upstream parent | Daemon batch row over delegated prep rows, titled by the inherited default title when present. | Title is default title; footer/subtitle is empty. Batch view member rows use PDF name + default title. |
| Single delegated OCR prep row under one upstream parent | Flat row, not batch card. | Single uploaded file should behave as one file delegation: canceling the file cancels the whole file's chain. |
| Normal daemon batch of multiple records | Daemon batch row. | TODO |

## Desired Batch View Copy

Batch mode is one level deep. `QueuePanel` prevents nested batch navigation while already inside a batch.

Current batch view:

- Toolbar shows back button, title, batch screenshot preview button, and sometimes "Open prep review".
- Sort toolbar remains visible.
- Member list renders normal `EntryItem` rows.
- Selecting a member opens that row in the right-side log/detail panel.
- If no member is selected but batch preview is active, the right pane shows a batch preview over the batch members.

Fill desired behavior:

| Batch view scenario | Current behavior | What I want |
|---|---|---|
| Prep batch toolbar title | Uses prep row `data.__name` override or PDF name. | For Oath Signature, use the PDF name. |
| Daemon batch toolbar title | Uses `batchDisplayOrdinal` (`Workflow 1`) or `Workflow · #abcd`. | TODO |
| Batch screenshot preview | Available from toolbar image button. | TODO |
| Member row title | Normal `EntryItem` title resolution. | TODO |
| Member row controls | Pending rows show bump/cancel; running rows show stop; done/failed rows show delete/retry where applicable. | TODO |

## Workflow: Oath Upload Delegation

Workflow: `oath-upload`

Workflow archetype: `delegating-batch`, so the root row is stamped as `batch-parent`.

Current stages:

1. `servicenow-auth`
2. `delegate-ocr`
3. `wait-ocr-approval`
4. `delegate-signatures`
5. `wait-signatures`
6. `open-hr-form`
7. `fill-form`
8. `submit`

Current behavior:

- The root row stores PDF/session/hash/upload status data.
- In full mode, it starts an OCR child with `parentRunId = oath-upload runId`.
- It does not await OCR execution directly. It waits up to 7 days for OCR approval.
- OCR approval fans out selected signer records to `oath-signature`.
- Oath Upload then waits until all expected oath-signature item ids have terminal `done` rows.
- After signatures are done, Oath Upload opens/fills/submits the ServiceNow HR inquiry.
- In upload-only mode, OCR/signature delegation is skipped.

Current dependency behavior:

- After OCR approval, `createApprovalDependencyRows()` links the Oath Upload parent task to each downstream oath-signature child task.
- Dependency policy is `onChildFailed: "block_parent"`, `cascadeCancel: true`, `resumeParentAfterChildRetry: true`.
- A child failure blocks the parent rather than letting the parent continue.
- A child cancellation marks that dependency `cancelled`; if no unsatisfied or failed dependencies remain, the parent can be released.

Desired Oath Upload behavior:

- Queue row: TODO
- Batch view: TODO
- If one signature child is cancelled: TODO
- If all signature children are cancelled: TODO
- If the Oath Upload parent is cancelled: TODO
- If daemon is stopped while parent waits: TODO

## Workflow: OCR Prep Delegation

Workflow: `ocr`

Workflow archetype: `delegating-batch`, but the orchestrator writes tracker rows manually and stamps `archetype: "batch-parent"` on prep rows.

Current stages:

1. `loading-roster`
2. `ocr`
3. `matching`
4. `disambiguating`
5. `eid-lookup`
6. `verification`
7. `awaiting-approval`

Current behavior:

- OCR prep emits a pending/running row with `data.mode = "prepare"` and `data.archetype = "batch-parent"`.
- If OCR came from an upstream workflow, the prep row carries `parentRunId`.
- If roster mode is download, OCR delegates one `sharepoint-download` child and waits for it.
- During matching/verification, OCR can fan out `eid-lookup` and `active-check` utility children.
- OCR-to-EID utility children stay as delegation member rows. They are not promoted into a batch delegated row just because they share an OCR parent.
- The Preview tab updates progressively as OCR, matching, disambiguation, lookup, and verification complete.
- Approval is operator-driven through `/api/ocr/approve-batch`.
- Discard/cancel is operator-driven through `/api/ocr/discard-prepare`.

Approval current behavior:

- Only selected records are fanned out.
- The target workflow comes from the OCR form spec, e.g. oath forms fan out to `oath-signature`, emergency contact forms fan out to `emergency-contact`.
- Child pending rows are pre-emitted before daemon auth, so operators can see them immediately.
- The OCR parent row is written `done` with `step: "approved"` after enqueue succeeds.
- If OCR had an upstream parent, that upstream parent row is updated too.

Discard current behavior:

- `/api/ocr/discard-prepare` requests in-process OCR abort.
- It deletes delegated children for the OCR run from tracker/state.
- It writes the OCR row as `failed` with `step: "discarded"`.
- If a parent workflow/run is known, it mirrors `failed` + `step: "discarded"` onto that parent row.
- Discarded prep rows are filtered out of the queue surfaces.

Desired OCR behavior:

- Queue row before approval: TODO
- Queue row after approval: TODO
- Batch view before approval: TODO
- Batch view after approval: TODO
- If OCR prep is discarded from preview pane: TODO
- If OCR prep is cancelled from queue row: TODO
- If one utility lookup child is cancelled: TODO
- If OCR is delegated from Oath Upload: TODO

## Workflow: Oath Signature

Workflow: `oath-signature`

Workflow archetype: `single`.

Current stages:

1. Synthetic `ocr` marker.
2. `ucpath-auth`
3. `transaction`

Current behavior:

- A direct daemon item is a normal single row.
- When created by OCR approval, it receives `parentRunId` and becomes a delegated child row under the upstream parent.
- The handler stamps EID/date/dry-run data immediately.
- The synthetic `ocr` marker exists so the timeline reads upload/OCR then UCPath transaction.
- If the employee already has an oath, the row is marked with skipped/existing-oath status data instead of saving a new oath.

Desired Oath Signature delegated row:

- Title: PDF name.
- Default title / secondary/footer data: `Oath · <last 4 of run id>`.
- Status tags: this means the visible queue row badge/label, not a separate feature. It should say what happened: Queued, Running, Needs review, Done, Skipped / Existing Oath, Cancelled, or Failed.
- Cancel behavior when queued: cancel the scope represented by the row. If it is the only uploaded file, cancel the whole Oath Signature chain. If multiple PDFs were uploaded, cancel only this file's chain.
- Cancel behavior when running: same scope as queued cancel. Stop this file's OCR/signature chain; do not cancel unrelated uploaded files in the same multi-file upload.
- Whether canceling one signer should affect the parent: canceling one signer/person from inside the final oath-signature child stage cancels that person and shows that person as Cancelled in the parent batch view. It should not cancel sibling signers unless the canceled row represents the whole file.

### Oath Signature Flow Spec

The desired mental model is file-first:

```
Uploaded PDF file
  -> OCR prep for that PDF
    -> EID lookup / active-check utility work for people in that PDF
    -> OCR approval for selected rows
      -> oath-signature daemon child rows for approved people
```

The queue should make the file the operator-visible unit. Person rows are members inside that file's batch/delegation view.

### Scenario: Upload One Oath PDF

Expected top-level queue:

| Stage | Row type | Title | Footer/subtitle | What appears in row |
|---|---|---|---|---|
| File just submitted / OCR starting | Oath file batch row. Current code may classify as `approval-delegation` or `batch` depending on source. | PDF name. | `Oath · <last 4 of run id>`. | Badge says Queued/Running. Progress reflects OCR prep work. |
| OCR needs operator review | Same row that started the run. | PDF name. | `Oath · <last 4 of run id>`. | Badge should say Needs review / awaiting approval. Batch/prep view opens the OCR review. |
| OCR approved and signer rows enqueued | Same row that started the run; no new top-level row. | PDF name. | `Oath · <last 4 of run id>`. | Counts show done/running/queued/failed/cancelled across signer rows. |
| UCPath oath-signature daemon running people | Same row that started the run, with member rows in batch view. | PDF name. | `Oath · <last 4 of run id>`. | Batch view lists people/signers. Each person shows Queued/Running/Done/Skipped/Cancelled/Failed. |
| Finished | Same row until filtered/archived by normal queue behavior. | PDF name. | `Oath · <last 4 of run id>`. | Done count equals total, unless some people were skipped/cancelled/failed. |

Expected batch view for the single file:

| Batch view element | Desired value |
|---|---|
| Toolbar title | PDF name. |
| Toolbar subtitle/footer | `Oath · <last 4 of run id>`. |
| Members before OCR approval | OCR prep/utility rows if useful, but the file row remains the main unit. |
| Members after OCR approval | Use the same existing member row pattern that was used to run the work. Do not create a new synthetic row just because OCR approved. |
| Person row title | Person name when known; fallback to EID. |
| Person row footer | EID, run number, and status/timing. |

Cancel rules for one uploaded PDF:

| Where cancel happens | Desired effect | Desired display |
|---|---|---|
| Main/top-level file row | Cancel the whole file chain: OCR prep, utility children, and any oath-signature signer rows for that file. | File row shows Cancelled. Batch view members show Cancelled where rows exist. |
| OCR stage / OCR prep row | Same as canceling the file. | File row shows Cancelled/Discarded consistently; child rows for that file do not keep running. |
| EID lookup / active-check utility child | Cancel only that person/lookup. | Parent file batch view shows that person/lookup as Cancelled. The rest of the file continues unless the missing lookup makes approval impossible. |
| Final oath-signature person row | Cancel only that signer/person. | Parent file batch view shows that person as Cancelled. Sibling signers continue. |
| Daemon stop for `oath-signature` | Cancels running/queued oath-signature children in that workflow only. | File row updates through child dependency state; unrelated OCR/prep rows should not be silently hidden. |

### Scenario: Upload Multiple Oath PDFs

Expected top-level queue:

| Stage | Row type | Title | Footer/subtitle | What appears |
|---|---|---|---|---|
| Multi-file upload submitted | Parent batch row over files. | Default title for the batch: `Oath · <last 4 of run id>`. | Empty. | Batch view contains normal rows for each request/file. |
| Delegates to OCR | Same parent batch row; each PDF is a normal single-file OCR prepare run grouped under it. | Default title: `Oath · <last 4 of batch id>`. | Empty. | Batch view contains normal preview rows, one per PDF. Each preview row title is PDF name and subtitle is the shared default title: `Oath · <last 4 of batch id>`. |
| Viewing file inside batch | Normal preview/file row inside the grouped batch. | PDF name. | `Oath · <last 4 of batch id>`. | Shows OCR/review/signature progress for that file only. |
| OCR approved for one file | Same existing file row; no replacement row. | PDF name. | `Oath · <last 4 of batch id>`. | Other files stay in their own OCR/review/signature state. |
| All files complete | Batch row aggregates all files. | Batch title. | Batch run id / ordinal. | Counts reflect all file members and person rows according to final design. |

Expected nested/delegated workflow chain:

| Level | Row meaning | Desired title | Desired footer/subtitle |
|---|---|---|---|
| Batch level | Multi-file upload batch. | `Oath · <last 4 of run id>`. | Empty. |
| File level | One uploaded PDF, implemented as its own single-file OCR prepare run. | PDF name. | `Oath · <last 4 of batch id>`. |
| OCR level | No separate true multi OCR workflow. The batch row is only a dashboard grouping over file-level OCR prep rows. | `Oath · <last 4 of batch id>`. | Empty; inside its batch view, each normal preview row is titled by PDF name and subtitled with the shared default title. |
| Utility level | EID lookup / active-check for one person. | Person name or EID. | Parent PDF/file context. |
| Final workflow level | `oath-signature` UCPath transaction for one person. | Person name when known; fallback to EID. | Parent PDF/file context; EID visible. Shows as a delegation member row in batch view. |

Cancel rules for multiple uploaded PDFs:

| Where cancel happens | Desired effect | Desired display |
|---|---|---|
| Main batch row | Cancel every file in the upload and all descendant OCR/utility/oath-signature work. | Batch row Cancelled; every file/member shows Cancelled or removed according to resolved-row rules. |
| One file row | Cancel only that PDF file's chain. | That file shows Cancelled. Other uploaded files continue. |
| OCR stage for one file | Same as canceling that file. | That file shows Cancelled/Discarded; other files continue. |
| EID lookup / active-check for one person | Cancel only that person/lookup. | That person shows Cancelled inside the file batch view. |
| Final oath-signature person row | Cancel only that signer/person. | That person shows Cancelled inside the file batch view. |

### Oath Signature Pages / Panels

| Page/panel | What should show for one PDF | What should show for multiple PDFs |
|---|---|---|
| Main queue | One file row titled by PDF name. | One batch row, drill-in to file rows; each file row titled by PDF name. |
| Batch view | Person/member rows for that file as they appear; toolbar title is PDF name. | First drill-in shows file rows. Selecting a file row shows that file's OCR/review/signature detail; the underlying workflow chain remains the same as a single upload. |
| OCR review / Preview tab | OCR records for the selected PDF. | OCR records for selected PDF only. |
| Log/detail panel | Selected row's timeline. File row should show OCR -> approval -> signature delegation story. Person row should show OCR marker -> UCPath auth -> transaction. | Same, scoped to selected batch/file/person row. |
| Terminal drawer / daemon cards | Workflow-scoped daemon status, not delegation-scoped. | Same; stopping a daemon is still workflow-scoped unless a new delegation-scoped stop is added. |

## Workflow: Emergency Contact

Workflow: `emergency-contact`

Workflow archetype: `batch`.

Current stages:

1. `navigation`
2. `fill-form`
3. `save`

Current behavior:

- Direct CLI/daemon batch rows are batch members.
- OCR approval fans out selected emergency-contact records into daemon queue items.
- Pending rows include employee, EID, contact, relationship, and dry-run fields.
- Each record is processed as its own queue item, while the daemon reuses/reset UCPath between records.

Desired Emergency Contact delegated row:

- Title: TODO
- Secondary/footer data: TODO
- Batch grouping: TODO
- Cancel behavior when queued: TODO
- Cancel behavior when running: TODO
- Whether canceling one record should affect the parent: TODO

## Workflow: Utility Delegations

Utility workflows include `sharepoint-download`, `eid-lookup` in utility contexts, and OCR fan-out rows for `eid-lookup` / `active-check`.

Current behavior:

- Utility workflows are not supposed to hold the main operator attention.
- Rows are grouped as passive delegation when `resolveRowArchetype()` returns `passive-child`.
- OCR utility fan-out to `eid-lookup` / `active-check` stays as delegation member rows.
- Passive group rows show aggregate counts and preview children.
- Utility child failure can block the parent depending on the dependency policy used by the caller/watcher.

Desired utility behavior:

- SharePoint download row: TODO
- EID lookup row: TODO
- Active check row: TODO
- Whether utility failures should block parent: TODO
- Whether utility cancellations should release/block parent: TODO

## Cancellation Behavior Now

There are several different cancel paths.

### Pending row cancel from queue

Frontend:

- `EntryItem` shows `QueueItemControls` when `entry.status === "pending"`.
- Normal pending rows call `/api/cancel-queued`.
- OCR prep proxy rows with `data.mode === "prepare"` plus OCR session data call `/api/ocr/discard-prepare` instead.

Backend `/api/cancel-queued`:

- Finds the SQLite control task.
- Refuses if already claimed/running; the UI should use running stop instead.
- Refuses if already terminal.
- Writes a completed `cancel_task` worker command as audit/control state.
- Marks the task and current attempt cancelled.
- Calls `markDependencyFromChildTerminal(childState: "cancelled")`.
- Writes queue failed audit and a tracker row with `status: "failed"` and `step: "cancelled"`.

Effect on the rest of a delegation:

- Canceling one queued child marks that child dependency `cancelled`.
- In current dependency release logic, `cancelled` dependencies do not count as pending/failed.
- If all remaining dependencies are `satisfied` or `cancelled`, a waiting parent can be released back to `queued`.
- This means canceling a child is not currently treated the same as a child failure.

### Running row stop from queue

Frontend:

- `EntryItem` shows `CancelRunningButton` when `entry.status === "running"` and `runId` exists.
- Normal running rows call `/api/task/force-stop`.
- OCR prep proxy rows call `/api/ocr/discard-prepare`.

Backend `/api/task/force-stop`:

- Enqueues a `cancel_task` command.
- Marks the task cancelled immediately.
- Marks dependency from child terminal as `cancelled`.
- Writes queue audit and tracker cancelled row.
- Attempts to hit daemon `/force-current`.
- It does not intentionally kill Chrome. The daemon should preserve the browser/session where possible.

Daemon behavior:

- `cancel_task` sets `state.cancelTarget` for the in-flight item.
- `runOneItem()` receives `isCancelRequested()`.
- Cancel wins over success/failure races.
- The daemon writes a cancelled tracker row (`status: "failed"`, `step: "cancelled"`).
- After a cancelled item, the daemon best-effort resets every system page before claiming the next item.

Effect on the rest of a delegation:

- Same dependency effect as queued cancel: the child dependency becomes `cancelled`.
- Sibling child rows are not automatically cancelled by canceling one child.
- Parent release depends on whether any dependency is still pending or failed.

### Stop all from queue

Frontend:

- `StopAllButton` posts `/api/cancel-active-bulk` with visible pending/running items.

Backend:

- Running items are cancelled first via `/api/cancel-running`.
- Pending items are cancelled second via `/api/cancel-queued`.
- This is per visible item; it does not inherently understand "cancel the whole parent delegation" unless every relevant child is included in the submitted item list.

### Stop daemon from terminal drawer

Frontend:

- Terminal drawer stop posts `/api/daemon/stop` with `force: true`.
- If multiple daemons for the workflow are alive, the confirmation warns that the endpoint is workflow-scoped.

Backend:

- Stops daemon/session/process/browser surfaces for the workflow.
- With force enabled, it reads that workflow's queued items and calls the queued cancel handler on each.
- Running in-flight cleanup happens in the daemon `finally`: in-flight items are marked cancelled on shutdown unless already terminal.
- If this is the last daemon and there are unclaimed queued items, those queued items are marked cancelled with reason `Daemon stopped before this item could be processed (browser closed).`

Effect on delegations:

- It only operates on one workflow at a time.
- Stopping the `oath-signature` daemon cancels oath-signature queued/running children, not the `oath-upload` or `ocr` parent rows directly.
- Dependency propagation then updates parent dependency state when child task ids are known.
- It does not automatically stop sibling workflows unless their daemon is separately stopped.

### Parent cancellation cascade in task store

There is a lower-level `requestCancelParentAndChildren()` helper:

- Marks the parent `cancelling`.
- Finds pending dependency children with `cascade_cancel = 1`.
- Cancels queued/waiting/blocked children immediately.
- Requests cancel for running children.
- Marks dependency rows cancelled.
- Marks the parent cancelled.

Important current caveat:

- The common dashboard row controls usually cancel the clicked row/task, not "the whole delegation tree".
- Parent-to-child cascade exists in the task store, but the queue row buttons documented above do not obviously route a parent card click into `requestCancelParentAndChildren()`.

## Desired Cancellation Rules

Fill this table before implementing fixes.

| Action | Current behavior | What I want |
|---|---|---|
| Cancel one queued child from batch view | Cancels that child; sibling rows remain; dependency becomes cancelled. | For Oath Signature: if the child is a person/signer, cancel only that person and show Cancelled in the parent file batch view. If the row represents the whole uploaded file, cancel that file's whole chain. |
| Stop one running child from batch view | Force-cancels that child; sibling rows remain; dependency becomes cancelled. | Same as queued cancel: person row cancels one person; file row cancels the whole file chain. |
| Cancel one OCR utility child | Child becomes cancelled; parent may release if no pending/failed deps remain. | For Oath Signature: cancel only that person/lookup; parent file batch view should show that person/lookup as Cancelled. |
| Discard OCR prep before approval | OCR row and mirrored parent row become discarded; delegated children for OCR run are deleted. | TODO |
| Cancel delegated OCR prep from queue row | Routes to OCR discard. | For Oath Signature: treat this as canceling the uploaded file. If one file was uploaded, everything is cancelled. If multiple files were uploaded, only that file's chain is cancelled. |
| Stop Oath Upload parent while waiting on children | Depends on whether clicked row maps to parent task; child cascade is not obviously wired through group card controls. | If the main parent row is cancelled, cancel everything underneath it. If a file row under the parent is cancelled, cancel only that file's descendants. |
| Stop daemon for a child workflow | Cancels queued/running items for that workflow only; parent/sibling workflows are affected only through dependency updates. | TODO |
| Stop all visible in queue | Cancels submitted visible pending/running rows; not necessarily the whole delegation tree. | TODO |

## Current Ambiguities / Fix Targets

- Group cards have retry/delete actions but no explicit "cancel whole delegation" action.
- Child cancellation is treated as dependency `cancelled`, not failure. A parent can be released when all unresolved children are cancelled/satisfied.
- Dashboard daemon stop is workflow-scoped, not delegation-scoped.
- OCR discard deletes delegated children for the OCR run, which is different from normal cancel behavior that leaves cancelled tracker rows.
- Batch mode is display-only grouping plus normal member rows; it is not a transaction boundary.
- Single delegated OCR prep rows intentionally render flat while multiple delegated OCR prep rows render as a batch over single-file rows. Multi-file Oath Signature should stay this grouped-singles model rather than adding a second true multi workflow path.

## Implementation Notes For Future Fix

Likely places to edit after desired behavior is filled in:

- Row grouping: `src/tracker/queue-surfaces.ts`
- Top-level queue rendering: `src/dashboard/components/queue-panel/QueuePanel.tsx`
- Group card content/actions: `src/dashboard/components/queue-panel/group-row-base.tsx`, `DelegationRow.tsx`, `DaemonBatchRow.tsx`
- Batch toolbar/member behavior: `src/dashboard/components/queue-panel/batch-queue-view.tsx`
- Per-row cancel routing: `QueueItemControls.tsx`, `CancelRunningButton.tsx`
- Whole-delegation cancel endpoint, if needed: `src/tracker/dashboard/ops/cancel.ts` plus Hono route wiring
- Parent/child propagation semantics: `src/core/task-store/child-state.ts`, `src/core/task-store/terminal.ts`
- OCR discard semantics: `src/tracker/dashboard/ocr/discard.ts`
- Oath Upload parent wait behavior: `src/workflows/oath-upload/handler.ts`
