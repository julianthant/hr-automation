# Dashboard API Reference

Full reference companion to `src/dashboard/CLAUDE.md`. Contains the complete API surface, data types, JSONL format, frontend processing rules, workflow configuration, component hooks, icon/toast/styling conventions, and the frontend file tree.

## Endpoints

| Endpoint | Method | Returns | Frontend Consumer |
|----------|--------|---------|-------------------|
| `/api/workflows` | GET | `string[]` — workflow names with JSONL data | `TopBar.tsx` dropdown options |
| `/api/workflow-definitions` | GET | `WorkflowMetadata[]` — registry payload (label, steps, detailFields, getName/getId hints) | `WorkflowsProvider` / `useWorkflow(name)` |
| `/api/dates?workflow=X` | GET | `string[]` — dates (desc) with entries | `TopBar.tsx` date navigator |
| `/api/entries?workflow=X` | GET | `TrackerEntry[]` — all entries for today (or date) | Debug / non-SSE consumers; live queue uses hub topic `entries` via `useEntries` |
| `/api/logs?workflow=X&id=Y&runId=Z` | GET | `LogEntry[]` — logs for an entry/run | Debug / non-SSE consumers; `useLogs` uses hub topic `logs` (`useSseHistoryStream`) |
| `/api/runs?workflow=X&id=Y[&date=D]` | GET | `RunInfo[]` — `{runId, status, timestamp}` per run | `RunSelector.tsx` pills |
| `/api/screenshots?workflow=X&itemId=Y` | GET | `ScreenshotListEntry[]` matching `<workflow>-<itemId>-` prefix | `ScreenshotsPanel` grid |
| `/screenshots/<filename>` | GET | PNG bytes, path-traversal guarded via `resolveScreenshotPath` | `ScreenshotsPanel` / `ScreenshotCard` `<img>` |
| `/api/search?q=Q[&days=N]` | GET | `SearchResultRow[]` — cross-workflow tracker entry hits | `SearchBar` / `SearchResults` |
| `/api/preflight` | GET | `{checks: [{name, passed, detail}], cleanedFiles?: number}` | `usePreflight` → sonner toast |
| `/api/rosters` | GET | `RosterListing[]` — xlsx files in `.tracker/rosters/` + `.tracker/sharepoint/`, newest first | `RunModal` (emergency-contact prep) |
| `/api/ocr/prepare` | POST (multipart) | `{ok, sessionId, pdfPath}` — fires `runWorkflow(ocrWorkflow)` in the dashboard process | `RunModal` (OCR prep upload) |
| `/api/ocr/approve-batch` | POST | Body: `{sessionId, records[]}`. Expands to N kernel queue items via `enqueueFromHttp` for the downstream form-type daemon. Marks the OCR parent row `done` step `approved`. | `OcrReviewPane` Approve button |
| `/api/ocr/discard-prepare` | POST | Body: `{sessionId, reason?}`. Emits `failed` step `discarded`; best-effort unlinks the PDF. | `OcrReviewPane` Discard button |
| `/api/ocr/reocr-whole-pdf` | POST | Body: `{sessionId}`. Re-runs OCR for every page (clears prior failed pages). | `OcrReviewPane` Re-OCR whole PDF dialog |
| `/api/ocr/retry-page` | POST | Body: `{sessionId, pageNumber}`. Retries one OCR page in isolation. | `FailedPageCard` Retry button |
| `/api/ocr/force-research` | POST | Body: `{sessionId, records[]}`. Re-dispatches Person Lookup for a subset of records flagged for forced research. | `OcrReviewPane` Force Research action |
| `/api/sharepoint-download/list` | GET | `SharePointDownloadListItem[]` — one row per registered spreadsheet (`{id, label, description?, envVar, configured}`) | `QueuePanel` Download dropdown — populates menu on mount |
| `/api/sharepoint-download/run` | POST | Body: `{ id }`. Response: `{ok, id, label, path, filename}` or `{ok:false, error}` — launches headed SharePoint download via `buildSharePointRosterDownloadHandler` (in `src/workflows/sharepoint-download/`), saves to `.tracker/sharepoint/` | `QueuePanel` Download dropdown — fired when a menu item is picked |
| `/api/enqueue` | POST | Body: `{workflow, input}`. Validates input against the workflow schema and inserts a task row into the SQLite task store; auto-spawns a daemon if none is alive. Returns `{ok, runId}`. | `InputRunPanel` (typed input runs) |
| `/api/retry` | POST | Body: `{workflow, id, runId?, date?, parentRunId?}`. Re-enqueues using the entry's persisted `input` field. | `RetryButton` (EntryItem failed rows + LogPanel header) via `useWorkflowActionDispatcher` |
| `/api/retry-bulk` | POST | Body: `{workflow, ids?[], items?:[{workflowId?, id, runId?, date?}], date?, parentRunId?, source?, scope?}`. Batch footer sends `source:"batch-view"` + `scope:"visible-view"` with resolved visible targets; legacy callers default to queue-panel/group. | `BulkRetryBar`, `BatchFooterActions` via `useWorkflowActionDispatcher` |
| `/api/cancel-active-bulk` | POST | Body: `{workflow, items:[{id, status, runId?}]}` — `status` must be `pending` or `running`; bulk cancel queued + cooperative cancel running. | `StopAllButton` |
| `/api/delete-bulk` | POST | Body: `{workflow, date, ids?[], items?:[{workflowId?, id, runId?, date?}], source?, scope?}` — delete many tracker rows + scoped screenshots. Batch footer sends `source:"batch-view"` + `scope:"visible-view"` with resolved visible targets; legacy callers default to queue-panel/group. | `DeleteAllButton`, `BatchFooterActions` via `useWorkflowActionDispatcher` |
| `/api/run-with-data` | POST | Body: `{workflow, id, data}`. Re-enqueues with `prefilledData` channel; kernel merges into ctx.data + workflow's extraction gate skips. | `EditDataTab` |
| `/api/cancel-queued` | POST | Body: `{workflow, id, runId?, scope?, ocrSessionId?, parentRunId?, parentWorkflow?, parentItemId?, formType?, reason?}`. Normal queued rows cancel the SQLite task/attempt, write completed `worker_commands.cancel_task`, emit JSONL audit + tracker `failed` with `step:"cancelled"`, and return 409 if claimed. OCR prep rows set `ocrSessionId` and route through central action dispatch to OCR discard instead. | `RowCancelButton` via `useWorkflowActionDispatcher` |
| `/api/cancel-running` | POST | Body: `{workflow, id, runId}`. Queues `worker_commands.cancel_task` for the owning worker; cooperative cancel happens at the next kernel step boundary. | `RowCancelButton` via `useWorkflowActionDispatcher` |
| `/api/browser/kill` | POST | Body: `{browserProcessId}` or `{pid}`. Kills only the recorded browser process row and records a `kill_browser` command. | _no React consumer today_ — prefer row cancel or daemon stop controls |
| `/api/worker/drain` | POST | Body: `{workerId}`. Queues `drain_worker`; worker stops after the current item without failing queued work. | _no React consumer today_ |
| `/api/worker/stop` | POST | Body: `{workerId}`. Queues `stop_worker`; worker shuts down and hard-kills its active browser only on this explicit stop path. | _no React consumer today_ |
| `/api/queue/bump` | POST | Body: `{workflow, id, runId?}`. Bumps a queued SQLite task priority so it is claimed next; legacy JSONL rewrite only applies when no task row exists. 409 if claimed. | `BumpButton` via `useWorkflowActionDispatcher` |
| `/api/queue-depth` | GET | `{workflow: depth}` map (count of queued SQLite tasks per workflow, legacy JSONL fallback when no task rows exist). | `useQueueDepth` → `TopBar` queue-depth pill |
| `/api/daemons` | GET | `DaemonInfo[]` — SQLite workers plus lockfile fallback, heartbeat age, current item/run, and scoped browser processes. | `useDaemons` (Overview / debug) |
| `/api/daemons/spawn` | POST | Body: `{workflow, count?}`. Fire-and-forget spawn. | _no React consumer today_ |
| `/api/daemons/stop` | POST | Body: `{workflow?, force?}`. Workflow-level multi-daemon stop / drain. | _no React consumer today_ |
| `/api/daemon/stop` | POST | Body: `{workflow, force?}`. Workflow-scoped stop — tears down EVERY daemon for the workflow and fails its in-flight items. | queue toolbar `StopAllButton` |
| `/api/daemon/stop-instance` | POST | Body: `{workflow, instance, force?}`. Per-instance stop — stops ONE daemon (resolved from the instance's `workflow_start.pid`); the daemon reassigns its in-flight item to a surviving peer (`reassign: true`) or fails it if it was the last. Returns `{ok, daemonStopped, browsersKilled, reassignable}`. | `WorkflowBox` `StopPill` |
| `/api/selector-warnings?days=N` | GET | `SelectorWarningRow[]` grouped by label | `SelectorWarningsPanel` (right rail) |
| `/api/failures` | GET | `FailureRow[]` — `failed` entries on the active date across all workflows, latest run per `(workflow,id)` | `NotificationBell` (lazy-fetched on popover open, merged with the live notification feed) |
| `/events/hub?subs=<encoded JSON>` | SSE | `{sub, data, event?}` envelopes per subscription | `lib/sse-hub.ts` — all real-time hooks use `sseHub.subscribe(topic, …)`; registry in `topics.ts`, emitters in `topics-emitters.ts` |

## Data Types (shared between backend and frontend)

```typescript
// src/tracker/jsonl.ts (backend) and src/dashboard/components/shared/types.ts (frontend)

interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;            // email, doc ID, employee ID, search name
  runId: string;         // "{id}#{runNumber}" — isolates re-runs
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

interface LogEntry {
  workflow: string;
  itemId: string;        // matches TrackerEntry.id
  runId: string;         // matches TrackerEntry.runId
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  ts: string;
}
```

## JSONL Files (`.tracker/`)

```
.tracker/rows/{workflow}-{YYYY-MM-DD}.jsonl  ← TrackerEntry lines
.tracker/logs/{workflow}-{YYYY-MM-DD}.jsonl  ← LogEntry lines
.tracker/sessions/{YYYY-MM-DD}.jsonl         ← SessionEvent lines
```

- Append-only. One line per event.
- Multiple entries per ID (status changes emit new lines).
- Frontend dedupes by ID (keeps latest entry per ID).
- **Tracker JSONL** older than **30 days** (by filename date) is pruned on dashboard startup and throttled on each `GET /api/preflight` (same threshold). Screenshot cleanup is lifecycle-tied through `sweepStaleRunScreenshots` on dashboard startup and interval; `npm run clean:tracker` remains the manual cleanup path (default **7** days, optional `--screenshots-only`).

## How Frontend Processes Data

### Entry Deduplication & Ordering

```
Raw JSONL entries (may have multiple per ID from status changes)
  → Map by ID, keep latest (highest timestamp) per ID
  → Sort descending by first-seen timestamp (the "pending" event time)
  → Result: newest entries at top of queue
```

### Log Deduplication (consecutive duplicates)

```
Raw log entries for a run
  → Walk array sequentially
  → If current.message === previous.message: increment counter
  → Else: emit previous with count badge if count > 1, reset
  → Result: "Extracted field data x4" instead of 4 identical lines
```

Dashboard display strips one leading bracketed source prefix from each log message (for example `[ocr]` or `[oath/match]`) while leaving the stored JSONL message untouched. Keep new operator-facing phase context in plain text (`Phase: matching`) rather than relying on repeated source tags.

### Run Isolation

When re-running the same ID (e.g. a failed separation re-run):
- Backend assigns `runId = "{id}#2"` (counts existing entries with same ID)
- Logs are tagged with `runId`
- Frontend fetches runs via `/api/runs`, shows tabs: "Run #1 ✗" | "Run #2"
- Switching tabs re-fetches logs for that `runId`

## Workflow-Specific Configuration

All dashboard UI metadata lives on the server-side `WorkflowMetadata` registry (every shipped workflow registers via `defineWorkflow`). Frontend consumes via the `WorkflowsProvider` + `useWorkflow(name)` hook (`src/dashboard/lib/workflows-context.tsx`) backed by `/api/workflow-definitions`. The former `WF_CONFIG` constant was deleted in subsystem D — there is no frontend-side hardcoding of labels, name/id resolvers, or detailField arrays anywhere.

Current consumption:

| Workflow | Archetype | Primary ID | Name Source | Steps | Detail Fields |
|----------|-----------|-----------|-------------|-------|---------------|
| `onboarding` | `batch` | email | `data.firstName + data.lastName` | crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction | Employee, Email, Dept #, Position #, Wage, Eff Date, I9 Profile |
| `separations` | `single` | doc ID | `data.name \|\| data.employeeName` | launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization | Employee, EID, Doc ID |
| `person-lookup` | `single` | name or EID | `data.searchName` | auth:ucpath → auth:crm → searching → cross-verification → active-status | Search, EID, Dept, HR Status, Start Date, End Date |
| `kronos-reports` | `batch` | employee ID | `data.name` | searching → extracting → downloading | Employee, ID |
| `work-study` | `single` | empl ID | `data.name` | ucpath-auth → transaction | Empl ID, Effective Date |
| `emergency-contact` | `batch` | `p{NN}-{emplId}` | `data.employeeName` | navigation → fill-form → save | Employee, Empl ID, Contact, Relationship |
| `oath-signature` | `single` | empl ID | `data.name` | ocr → ucpath-auth → transaction | Employee, Empl ID, Signature Date |
| `oath-upload` | `single` | session ID | (PDF filename / hash) | delegate-signatures → servicenow-auth → open-hr-form → fill-form → submit | PDF, Signers, HR ticket #, Filed, Status |
| `ocr` | `preview` | session ID | (PDF filename) | upload → ocr → matching → disambiguating → awaiting-approval → approved/discarded | PDF, Form type, Pages, Records |
| `crm-doc-download` | `single` | email or doc ID | `data.name` | crm-auth → download | Employee, Email, Doc URL |
| `onbase` | `batch` | (session/PDF) | (PDF filename) | ocr → import | PDF, Doc Type, Pages, Status |
| `sharepoint-download` | `single` | URL or label | (file label) | login → download | Label, Output path |
| `i9-lookup` | `single` | person name | `data.signerName` | auth:i9 → lookup | Signed By, I-9 Status |

`person-lookup` and delegated-only `i9-lookup` are registered under the dashboard category `Utils`. For Person Lookup date fields, display `data.startDate` as **Start Date** (UCPath Last Hire / first day of service); keep assignment `effectiveDate` / EFFDT as backend matching context, not the operator-facing start date.

## Hook → Component Mapping

| Hook | Component | What it does |
|------|-----------|-------------|
| `useEntries(workflow, date)` | `App.tsx` → `QueuePanel` | `sseHub.subscribe("entries", { workflow, date? })` — multiplexed `/events/hub`; dedupes, sorts newest-first; receives backend-authoritative `wfCounts` / `failureCounts` |
| `useLogs(...)` | `LogPanel` → `LogStream` | `useSseHistoryStream("logs", …)` — hub topic `logs`, full history on first tick + deltas; collapses consecutive duplicates |
| `useRunEvents(...)` | `LogPanel` → `LogStream` (Events tab) | `useSseHistoryStream("runEvents", …)` — same delta semantics as logs |
| `useSessions()` | `TerminalDrawer` | `sseHub.subscribe("sessions", {})` — live `SessionState` for workflow cards |
| `useDaemons()` | Overview / debug surfaces | Polls `GET /api/daemons` — live worker inventory. (No longer used by `WorkflowBox`/`StopPill` — per-instance stop sends the card's `instance` label directly.) |
| `useClock()` | `TopBar` | Updates HH:MM:SS every second |
| `useElapsed(startTime)` | `EntryItem`, `LogPanel` | Live "1m 22s" counter for running entries |
| `usePreflight()` | `App.tsx` | Fetches `/api/preflight` on mount, fires sonner toast |

## Log Icon Mapping (lucide-react)

| Log message pattern | Icon | Color | Category |
|---------------------|------|-------|----------|
| "fill", "comp rate", "compensation" | `Pencil` | cyan-400 | fill |
| "click", "navigat" | `MousePointer` | slate-400 | navigate |
| "extract", "crm field", "matched label" | `ArrowDownToLine` | amber-400 | extract |
| "search", "found", "result", "person search" | `Search` | blue-400 | search |
| "select", "dropdown", "template", "reason" | `ListFilter` | teal-400 | select |
| "sso", "duo", "auth", "credential", "login" | `KeyRound` | purple-400 | auth |
| "download", "pdf", "report" | `Download` | green-400 | download |
| level === "success" | `Check` | success | success |
| level === "error" | `X` | destructive | error |
| level === "waiting" | `Hourglass` | warning | waiting |
| default | `ArrowRight` | blue-400 | step |

## Toast Events

| Trigger | Type | Title | Description |
|---------|------|-------|-------------|
| Dashboard mount | info | "Pre-flight checks passed" | "Dashboard connected · N old logs cleaned" |
| Entry status → "done" | success | "{name} completed" | "{workflow} finished in {duration}" |
| Entry status → "failed" | error | "{name} failed" | Error message (truncated) |
| SSE disconnect | warning | "Connection lost" | "Reconnecting..." |
| SSE reconnect | success | "Reconnected" | "Live updates resumed" |

## Styling Rules

- All colors via CSS variables (`--background`, `--primary`, etc.) — never hardcode hex
- Status colors: running = `--primary`, done = `--success` (#4ade80), failed = `--destructive`, pending = `--warning` (#fbbf24)
- Badge style: subtle tinted background (e.g. `hsl(29.3 41.9% 58.8% / 0.15)`) + colored text
- Mono font for: timestamps, IDs, emails, step names, log messages, stat numbers
- Sans font for: names, labels, titles, descriptions
- Border radius: `--radius` (0.5rem)
- No emojis in UI — use lucide-react icons only

## Frontend Files

```
src/dashboard/
  App.tsx                    # Top-level layout (TopBar + QueuePanel + LogPanel + TerminalDrawer)
  main.tsx                   # React root + WorkflowsProvider
  index.css                  # CSS variables, @import "@heroui/styles", Tailwind setup
  index.html                 # Vite entry
  components/
    capture/                 # capture lightbox, photo tiles, modal chrome/state
    hooks/                   # useEntries (topic `entries`), useLogs / useRunEvents → useSseHistoryStream (`logs`, `runEvents`), useSessions, useDaemons, …
    log-panel/               # LogPanel, LogStream/LogLine, RunSelector, StepPipeline, screenshots, edit-data tab
    navigation/              # TopBar, WorkflowRail, SearchBar/SearchResults, NotificationBell, input-run/capture buttons
    oath-upload/             # duplicate-banner helpers
    ocr/                     # OCR review pane, record views, preview pairs, delegation rows
    queue-panel/             # QueuePanel, EntryItem, daemon/batch rows, bulk controls, sort/status/surface helpers
    run-modal/               # RunModal + SharePointDownloadButton
    shared/                  # reusable buttons, empty state, PDF preview, selector warnings, entry display/types/status styles
    terminal-drawer/         # TerminalDrawer, WorkflowBox, BrowserChip, LiveIndicator
    ui/                      # local shadcn-style primitives + HeroUI Calendar wrapper
  lib/
    ocr-downstream-registry.ts
    input-run-registry.ts
    run-modal-registry.ts
    sse-hub.ts
    utils.ts                 # cn() — class merge helper
    workflow-icons.ts
    workflows-context.tsx    # /api/workflow-definitions consumer; useWorkflow(name)
```
