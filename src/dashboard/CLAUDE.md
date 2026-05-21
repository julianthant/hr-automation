# Dashboard — Implementation Guide

React SPA for real-time HR workflow monitoring. Split-panel layout: queue (left) + log stream (right).

## Stack

- React 19, Vite 8, Tailwind CSS v4, shadcn/ui primitives, lucide-react, sonner (toasts)
- HeroUI (`@heroui/react`, `@heroui/calendar`, `@heroui/styles`) — used for the date Calendar in `components/ui/calendar.tsx` and its global stylesheet imported from `index.css`. Other shadcn-style primitives (button, dropdown, popover, etc.) are local files in `components/ui/`.
- Theme: CSS variables and Tailwind v4 setup live in `index.css` (no root-level `theme.md` in this repo)
- Fonts: Inter (sans), JetBrains Mono (mono) — loaded via Google Fonts in `index.html`
- No framer-motion

## Operator text conventions

Dashboard toasts, queue actions, delegation batch rows, and batch member rows should render the shared operator subject first (`data.__subject`). Do not display raw run ids/session ids as primary text unless no subject exists; keep those ids as fallback or debug detail.

Dashboard controls mutate the SQLite control plane first (`tasks`, `task_attempts`, `worker_commands`, `browser_processes`) and let workers observe those commands. JSONL tracker/queue writes are audit/history, not live coordination. Browser force-stop controls must target a recorded `browser_processes` row; do not add a control that kills all Chromium processes or only flips local React state.

## Component Tree

Component placement rules live in `components/AGENTS.md`. Read that file before adding, moving, or promoting files under `src/dashboard/components/`.

```
App.tsx
├── navigation/TopBar.tsx
│   ├── Workflow dropdown (shadcn Select → popover with name + count)
│   ├── Date navigation (arrow buttons + shadcn Popover + Calendar)
│   ├── SearchBar.tsx (cross-workflow tracker entry search → SearchResults.tsx)
│   ├── FailureBell.tsx (red badge with read-state — failed entries on the active date, persists read status via localStorage)
│   ├── Live indicator (green dot pill)
│   └── Clock (useClock hook)
├── queue-panel/QueuePanel.tsx
│   ├── StatPills.tsx (5 clickable cards — hidden in batch queue mode)
│   ├── batch-queue-view `BatchQueueToolbar` — back link + batch title (batch queue mode only)
│   └── Entry list (scroll)
│       ├── ocr `DelegationRow` — approved prep delegation summary; click → batch queue mode
│       ├── batch-queue-view `BatchQueueMemberList` — scoped member `EntryItem` rows (batch queue mode)
│       └── `EntryItem.tsx` — main queue rows (name, badge, step, time, error)
├── log-panel/LogPanel.tsx
│   ├── Header (name, badge, email, RunSelector.tsx)
│   ├── Detail grid (4 cells, varies per workflow)
│   ├── StepPipeline.tsx (horizontal dots + connectors + timing)
│   ├── LogStream.tsx (shadcn ScrollArea; filter tabs + debug-log visibility toggle)
│   │   └── LogLine.tsx × N (timestamp, icon, message, dup badge, copy)
│   └── Footer (streaming indicator, count, auto-scroll toggle)
└── terminal-drawer/TerminalDrawer.tsx (bottom bar + horizontal session cards)
    └── WorkflowBox.tsx × N — **`StopPill`** → `POST /api/daemon/stop` (workflow-wide, after confirm). **`BrowserChip`** tiles are auth-state labels only (`useDaemons` + `/api/daemons` inform copy, not per-chip kill).
```

## Backend Wiring (SSE API on port 3838)

The HTTP server is created in `src/tracker/dashboard/server.ts` (`createDashboardServer`); routing is Hono under `src/tracker/dashboard/hono/`. Public imports often go through `src/tracker/dashboard.ts` (barrel). The Vite dev server (port 5173) proxies `/api/*` and `/events/*` via `vite.dashboard.config.ts`; `dashboard --prod` serves `dist/dashboard/index.html` from the same Hono server.

### Endpoints

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
| `/api/rosters` | GET | `RosterListing[]` — xlsx files in `.tracker/rosters/` + `src/data/`, newest first | `RunModal` (emergency-contact prep) |
| `/api/ocr/prepare` | POST (multipart) | `{ok, sessionId, pdfPath}` — fires `runWorkflow(ocrWorkflow)` in the dashboard process | `RunModal` (OCR prep upload) |
| `/api/ocr/approve-batch` | POST | Body: `{sessionId, records[]}`. Expands to N kernel queue items via `enqueueFromHttp` for the downstream form-type daemon. Marks the OCR parent row `done` step `approved`. | `OcrReviewPane` Approve button |
| `/api/ocr/discard` | POST | Body: `{sessionId, reason?}`. Emits `failed` step `discarded`; best-effort unlinks the PDF. | `OcrReviewPane` Discard button |
| `/api/ocr/reocr-whole-pdf` | POST | Body: `{sessionId}`. Re-runs OCR for every page (clears prior failed pages). | `OcrReviewPane` Re-OCR whole PDF dialog |
| `/api/ocr/retry-page` | POST | Body: `{sessionId, pageNumber}`. Retries one OCR page in isolation. | `FailedPageCard` Retry button |
| `/api/ocr/force-research` | POST | Body: `{sessionId, records[]}`. Re-dispatches eid-lookup for a subset of records flagged for forced research. | `OcrReviewPane` Force Research action |
| `/api/sharepoint-download/list` | GET | `SharePointDownloadListItem[]` — one row per registered spreadsheet (`{id, label, description?, envVar, configured}`) | `QueuePanel` Download dropdown — populates menu on mount |
| `/api/sharepoint-download/run` | POST | Body: `{ id }`. Response: `{ok, id, label, path, filename}` or `{ok:false, error}` — launches headed SharePoint download via `buildSharePointRosterDownloadHandler` (in `src/workflows/sharepoint-download/`), saves to `src/data/` | `QueuePanel` Download dropdown — fired when a menu item is picked |
| `/api/retry` | POST | Body: `{workflow, id, runId?, date?, parentRunId?}`. Re-enqueues using the entry's persisted `input` field. | `RetryButton` (EntryItem failed rows + LogPanel header) via `useWorkflowActionDispatcher` |
| `/api/retry-bulk` | POST | Body: `{workflow, ids?[], items?:[{workflowId?, id, runId?, date?}], date?, parentRunId?, source?, scope?}`. Batch footer sends `source:"batch-view"` + `scope:"visible-view"` with resolved visible targets; legacy callers default to queue-panel/group. | `BulkRetryBar`, `BatchFooterActions` via `useWorkflowActionDispatcher` |
| `/api/cancel-active-bulk` | POST | Body: `{workflow, items:[{id, status, runId?}]}` — `status` must be `pending` or `running`; bulk cancel queued + cooperative cancel running. | `StopAllButton` |
| `/api/delete-bulk` | POST | Body: `{workflow, date, ids?[], items?:[{workflowId?, id, runId?, date?}], source?, scope?}` — delete many tracker rows + scoped screenshots. Batch footer sends `source:"batch-view"` + `scope:"visible-view"` with resolved visible targets; legacy callers default to queue-panel/group. | `DeleteAllButton`, `BatchFooterActions` via `useWorkflowActionDispatcher` |
| `/api/run-with-data` | POST | Body: `{workflow, id, data}`. Re-enqueues with `prefilledData` channel; kernel merges into ctx.data + workflow's extraction gate skips. | `EditDataTab` |
| `/api/cancel-queued` | POST | Body: `{workflow, id, runId?, scope?, ocrSessionId?, parentRunId?, parentWorkflow?, parentItemId?, formType?, reason?}`. Normal queued rows cancel the SQLite task/attempt, write completed `worker_commands.cancel_task`, emit JSONL audit + tracker `failed` with `step:"cancelled"`, and return 409 if claimed. OCR prep rows set `ocrSessionId` and route through central action dispatch to OCR discard instead. | `QueueItemControls` via `useWorkflowActionDispatcher` |
| `/api/cancel-running` | POST | Body: `{workflow, id, runId}`. Queues `worker_commands.cancel_task` for the owning worker; cooperative cancel happens at the next kernel step boundary. | `CancelRunningButton` |
| `/api/task/force-stop` | POST | Body: `{workflow, id, runId?, scope?, ocrSessionId?, parentRunId?, parentWorkflow?, parentItemId?, formType?, reason?}`. Normal running rows write `force_stop_task` plus scoped `kill_browser` commands for browser rows attached to that task. OCR prep rows set `ocrSessionId` and route through central action dispatch to OCR discard instead. | `CancelRunningButton` via `useWorkflowActionDispatcher` |
| `/api/browser/kill` | POST | Body: `{browserProcessId}` or `{pid}`. Kills only the recorded browser process row and records a `kill_browser` command. | _no React consumer today_ — prefer `/api/task/force-stop` from queue controls |
| `/api/worker/drain` | POST | Body: `{workerId}`. Queues `drain_worker`; worker stops after the current item without failing queued work. | _no React consumer today_ |
| `/api/worker/stop` | POST | Body: `{workerId}`. Queues `stop_worker`; worker shuts down and hard-kills its active browser only on this explicit stop path. | _no React consumer today_ |
| `/api/queue/bump` | POST | Body: `{workflow, id, runId?}`. Bumps a queued SQLite task priority so it is claimed next; legacy JSONL rewrite only applies when no task row exists. 409 if claimed. | `QueueItemControls` |
| `/api/queue-depth` | GET | `{workflow: depth}` map (count of queued SQLite tasks per workflow, legacy JSONL fallback when no task rows exist). | `useQueueDepth` → `TopBar` queue-depth pill |
| `/api/daemons` | GET | `DaemonInfo[]` — SQLite workers plus lockfile fallback, heartbeat age, current item/run, and scoped browser processes. | `useDaemons` → `WorkflowBox` / `StopPill` context |
| `/api/daemons/spawn` | POST | Body: `{workflow, count?}`. Fire-and-forget spawn. | _no React consumer today_ |
| `/api/daemons/stop` | POST | Body: `{workflow?, force?}`. Workflow-level multi-daemon stop / drain. | _no React consumer today_ |
| `/api/daemon/stop` | POST | Workflow-scoped stop for the selected automation (used after operator confirm). | `WorkflowBox` `StopPill` |
| `/api/selector-warnings?days=N` | GET | `SelectorWarningRow[]` grouped by label | `SelectorWarningsPanel` (right rail) |
| `/api/failures` | GET | `FailureRow[]` — `failed` entries on the active date across all workflows, latest run per `(workflow,id)` | `FailureBell` (lazy-fetched on popover open) |
| `/events/hub?subs=<encoded JSON>` | SSE | `{sub, data, event?}` envelopes per subscription | `lib/sse-hub.ts` — all real-time hooks use `sseHub.subscribe(topic, …)`; registry in `topics.ts`, emitters in `topics-emitters.ts` |

### Data Types (shared between backend and frontend)

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
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}
```

### JSONL Files (`.tracker/`)

```
.tracker/{workflow}-{YYYY-MM-DD}.jsonl       ← TrackerEntry lines
.tracker/{workflow}-{YYYY-MM-DD}-logs.jsonl  ← LogEntry lines
```

- Append-only. One line per event.
- Multiple entries per ID (status changes emit new lines).
- Frontend dedupes by ID (keeps latest entry per ID).
- **Tracker JSONL** older than **30 days** (by filename date) is pruned on dashboard startup and throttled on each `GET /api/preflight` (same threshold). **Screenshots are not pruned** on that cadence — use **`npm run clean:tracker`** (default **7** days, optional `--screenshots-only`) or a future lifecycle hook.

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
| `onboarding` | `single` | email | `data.firstName + data.lastName` | crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction | Employee, Email, Dept #, Position #, Wage, Eff Date, I9 Profile |
| `separations` | `delegating` | doc ID | `data.name \|\| data.employeeName` | launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization | Employee, EID, Doc ID |
| `eid-lookup` | `utility` | search name | `data.name` | ucpath-auth → searching (→ crm-auth → cross-verification) | (no declared detailFields — see workflow CLAUDE.md) |
| `active-check` | `single` | name or EID | `data.name` | ucpath-auth → check | Name, EID, Status |
| `old-kronos-reports` | `single` | employee ID | `data.name` | searching → extracting → downloading | Employee, ID |
| `work-study` | `single` | empl ID | `data.name` | ucpath-auth → transaction | Empl ID, Effective Date |
| `emergency-contact` | `batch` | `p{NN}-{emplId}` | `data.employeeName` | navigation → fill-form → save | Employee, Empl ID, Contact, Relationship |
| `oath-signature` | `single` | empl ID | `data.name` | ocr → ucpath-auth → transaction | Employee, Empl ID, Signature Date |
| `oath-upload` | `delegating-batch` | session ID | (PDF filename / hash) | servicenow-auth → delegate-ocr → wait-ocr-approval → delegate-signatures → wait-signatures → open-hr-form → fill-form → submit | PDF, OCR session, Signers, HR ticket #, Filed, Status |
| `ocr` | `delegating-batch` | session ID | (PDF filename) | upload → ocr → matching → disambiguating → awaiting-approval → approved/discarded | PDF, Form type, Pages, Records |
| `crm-doc-download` | `delegating` | email or doc ID | `data.name` | crm-auth → download | Employee, Email, Doc URL |
| `sharepoint-download` | `single` | URL or label | (file label) | login → download | Label, Output path |

## Hook → Component Mapping

| Hook | Component | What it does |
|------|-----------|-------------|
| `useEntries(workflow, date)` | `App.tsx` → `QueuePanel` | `sseHub.subscribe("entries", { workflow, date? })` — multiplexed `/events/hub`; dedupes, sorts newest-first; receives `wfCounts` / `failureCounts` |
| `useLogs(...)` | `LogPanel` → `LogStream` | `useSseHistoryStream("logs", …)` — hub topic `logs`, full history on first tick + deltas; collapses consecutive duplicates |
| `useRunEvents(...)` | `LogPanel` → `LogStream` (Events tab) | `useSseHistoryStream("runEvents", …)` — same delta semantics as logs |
| `useSessions()` | `TerminalDrawer` | `sseHub.subscribe("sessions", {})` — live `SessionState` for workflow cards |
| `useDaemons()` | `WorkflowBox` (`StopPill`) | Polls `GET /api/daemons` — blast-radius / worker counts for stop confirm |
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

## Build

```bash
npm run dev:dashboard     # Vite dev on :5173, proxies /api + /events to :3838
npm run build:dashboard   # Single-file HTML to dist/dashboard/index.html
npm run dashboard         # Starts SSE backend (:3838) + Vite dev (:5173)
npm run dashboard:watch   # Same as dashboard, but tsx watch restarts SSE backend on src/ changes (full restart, not HMR)
npm run dashboard:prod    # Serve pre-built dashboard from SSE only (no Vite)
npm run dashboard:tunneled  # Dashboard with tunnel support (expose SSE to external clients)
```

## Adding a New Workflow to the Dashboard

The dashboard now auto-adapts — no frontend changes needed. When a new workflow lands:

1. **Kernel workflow** — declare `label`, `getName`, `getId`, and labeled `detailFields` inside the `defineWorkflow(...)` config. The registry + `/api/workflow-definitions` picks them up automatically; the detail grid renders whatever is declared.
2. **Log icon mapping** — if the workflow introduces new log message patterns, add them to the icon mapping in `LogLine.tsx`.
3. **Test** — run `npm run dashboard`, trigger the workflow, verify entries appear and steps progress. The detail panel should populate from your declared `detailFields` via `updateData` calls in the handler.

## Lessons Learned

- **2026-05-21: OCR prep discard uses central cancel context.** `QueueItemControls` and `CancelRunningButton` must not POST directly to `/api/ocr/discard-prepare`; build `/api/cancel-queued` or `/api/task/force-stop` requests through `useWorkflowActionDispatcher` with `ocrSessionId`, OCR `runId`, and parent row context (`parentWorkflow`, `parentRunId`, `parentItemId`, `formType`, `reason`). The server action engine detects `cancel + ocrSessionId`, skips normal task resolution, and routes to OCR discard so the parent row mirror and delegated child cleanup still happen.
- **2026-05-21: Row action buttons use one client dispatcher.** `RetryButton`, `DeleteButton`, `QueueItemControls`, and `CancelRunningButton` should build legacy-compatible `/api/retry`, `/api/delete-entry`, `/api/cancel-queued`, and `/api/task/force-stop` bodies through `src/dashboard/components/hooks/useWorkflowActionDispatcher.ts`. Pass the resolved `WorkflowActionDescriptor` when available so target-level `workflowId`, `date`, `runId`, and non-row cancel `scope` survive; use the explicit row props only as fallback.
- **2026-05-21: Batch footer retry/delete actions are explicit visible-view requests.** `BatchFooterActions` uses `dispatchBulkWorkflowAction` / `buildBulkWorkflowActionRequest` from `src/dashboard/components/hooks/useWorkflowActionDispatcher.ts` for `/api/retry-bulk` and `/api/delete-bulk`. It must pass only `selectEntriesForWorkflowAction(...)` results and force `source:"batch-view"` + `scope:"visible-view"` so descriptor targets never fall back to the whole batch or expand to hidden rows.
- **2026-05-21: Projection actions carry concrete targets, not policy run ids.** Runtime policies declare static `WorkflowActionPolicy` capability/config only; `buildWorkflowRunProjection` / `buildProjectionFromQueueSurface` materialize resolved `WorkflowActionDescriptor.targets` with `{ workflowId, id, runId?, status? }`. Batch footer retry/delete filtering must match both `workflowId` and `runId` so cross-workflow delegation members do not collapse onto same-run-id rows from another workflow.
- **2026-05-20: Queue rows render from workflow runtime projections.** `QueuePanel` builds `WorkflowRunProjection` rows from the queue-surface classifier and passes projection titles, subtitles, row labels, batch members, and action descriptors into queue components. Batch footer retry/delete targets come from projection action `targets`. Shared action gating lives in `src/dashboard/lib/workflow-action-utils.ts`; `RetryButton` / `DeleteButton` / `QueueItemControls` / `CancelRunningButton` honor projection `actions` before POSTing to the legacy-compatible `/api/*` routes (which wrap `performWorkflowAction` on the server).
- **2026-05-17: LogPanel read-site discriminators migrated to `resolveRowArchetype`.** Three legacy checks retired: (1) `taskRole === "delegator"` fallback in `deriveQueueRowTypeLabel` default branch — oath-upload rows now hit `case "batch-parent":` directly; (2) `effectiveWorkflow === "ocr"` step filter — replaced by `resolveRowArchetype(entry) === "batch-parent"` (OCR batch-parent rows filter out `awaiting-approval`; OCR delegate-children from oath-upload show it); (3) `logSourceWorkflow === "ocr" || requestRole === "delegation-dispatch"` for `hideDetailGrid` — replaced by `Boolean(previewAvailable) || resolveRowArchetype(entry) === "dispatch"`. `/api/preview-inbox` endpoint was also removed (backend route gone since `ApprovalInbox` was removed 2026-05-06).
- **2026-05-18: Oath-signature delegation row titles follow file/person/default-title split.** Oath upload prep titles now use `Oath · <last4>` without `#`; file/prep rows use the PDF name as the title and the Oath default title as the footer/subtitle. Final oath-signature person rows and OCR utility lookup rows keep the person name/EID as their title even when they carry `parentSubject`; the inherited Oath title is context, not the row title. OCR-to-EID fan-out stays as delegation member rows, not a daemon batch card.
- **2026-05-18: Multi-file Oath Signature upload is a grouped set of single-file prep runs.** `RunModal` allows multiple PDFs only for `oath-signature`; it posts each PDF separately to `/api/ocr/prepare` and sends a shared `originBatchRunId` / `originBatchSubject` (`Oath · <last4>`). `buildOcrPrepareHandler` keeps a unique file-level prep `runId` for each PDF and stamps the shared id as that prep row's `parentRunId`, so the existing queue surface groups the files into one batch card while OCR, EID lookup, and final oath-signature rows still behave like normal single-file chains.
- **2026-05-19: Cancelled delegated lookup rows keep person/EID titles.** Queue rows and batch previews must not promote technical OCR retry ids (`ocr-oath-*`, `ocr-retry-*`) to the visible title after daemon cancellation. `EntryItem` should keep using `resolveEntryName`, and `pickPreviewChildren` should prefer `name` / `searchName` / valid EID before `__subject`, `__name`, or raw id. Daemon/passive batch cards should omit the parent run id in the footer; OCR approval delegation rows still show the Oath default title (`Oath · <last4>`) beside the run number.
- **2026-05-19: OCR preview footer single/batch is file-count based.** `LogPanel` row-type labels for OCR prep rows must not use `recordCount` or EID lookup child count; a single PDF with multiple people is still `Single delegation · Preview`. Only multiple OCR prep rows sharing the same uploaded-file batch parent should show `Batch delegation · Preview`.
- **2026-05-20: Delegated OCR review rows keep normal footer controls.** `EntryItem` treats delegated OCR `status=done` / `step=awaiting-approval` rows as action-capable, not terminal done rows: keep the `Needs review` badge, but still render static duration plus Retry and Delete controls in the footer. Regression coverage lives in `tests/unit/dashboard/entry-item.test.ts`.
- **2026-05-20: Passive delegation batch cards need the same footer actions.** EID Lookup cards that group OCR-origin lookup children render through the `passive-delegation` `GroupRowBase` branch, not `DaemonBatchRow`. Keep retry/delete controls in `BatchFooterActions` and share them across daemon and passive delegation cards so failed grouped lookup rows can be retried or deleted from the footer.
- **2026-05-14: Queue row titles use the global queue-title primitive.** Dashboard title resolution prefers `data.__queueRootTitle` / `data.__queueTitle` before legacy `__name` for non-person rows. Delegated person rows with `name`, `employeeName`, or `searchName` keep that person title instead of inheriting the parent queue title. Single rows use person-linked titles, and batch prep rows use form-specific titles like `Oath · 1234` or `Emergency Contact · #1234`.
- **2026-05-14: Prep-mode rows are batch anchors for their own approval surface.** `queue-surface-classifier` classifies tracker rows with `data.mode === "prepare"` as persistent batch parents (predicate: `isPrepBatchAnchor`) for direct approval surfaces, regardless of approval state and even when the batch has zero or one child. Delegated prepare rows with an upstream `parentRunId` are first grouped by the upstream parent (see 2026-05-18 lesson). Delegated daemon batch cards can receive an inherited title via `resolveDaemonBatchQueueTitle`'s optional `titleOverride` parameter, threaded from `QueuePanel.tsx` to `DaemonBatchRow`.
- **2026-05-13: Queue surfaces for delegation and batches.** Queue grouping now flows through `queue-surface-classifier.ts`, which emits explicit `approval-delegation`, `passive-delegation`, and `batch` surfaces. `DelegationRow` and `DaemonBatchRow` are thin wrappers over `GroupRowBase`; future delegation row types should extend the classifier and wrapper layer, not add new hardcoded branches in `QueuePanel`.
- **2026-05-11: `DelegationRow` + batch queue shell.** Renamed `ParentChildRow` → `DelegationRow` and `parent-child-helpers` → `delegation-row-helpers`. Extracted `BatchQueueToolbar` + `BatchQueueMemberList` from `queue-panel/batch-queue-view.tsx` as the reusable “batch queue mode” surface (toolbar fixed, members scroll). `QueuePanel` props: `batchQueueParentRunId`, `onEnterBatchQueue`, `onExitBatchQueue`. Today the anchor is always an approved OCR prep row; the same components can host future daemon batch groupings by supplying a tracker anchor + member list + optional `titleOverride` / omitting `onOpenPrepReview`.
- **2026-05-08: daemonLog topic removed — no frontend consumer.** `DaemonLogTail` was built in 8745b684, then explicitly deleted in c5df7639 ("remove Daemons UI"). The `daemonLog` hub topic was added during the SSE migration without noticing the component was gone. Removed the topic from `topics-emitters.ts` and its tests. If a new daemon log tail UI is ever needed, re-add the topic emitter (it was well-tested; the deletion commit has the full implementation) and add a `DaemonLogTail` component in `terminal-drawer/`.
- **2026-05-08: SseHub listener errors no longer silently swallowed.** Split the single `try/catch` in `SseHub.onmessage` into two layers: JSON parse errors → `console.warn` + return (malformed envelope ignored); listener errors → `console.error("SseHub listener threw for topic '<topic>':", err)` + continue (other listeners still fire). Without this split, a listener throwing on a bad shape killed delivery to all other topics on the same hub without any log output.
- **2026-05-18: Entries SSE payloads validate their shallow envelope before state updates.** `SseHub` now warns when a parsed hub payload is not `{sub: string, data, event?}`; `useEntries` then guards the topic payload shape (`entries` and `workflows` must be arrays) before touching React state. Per-row validation belongs in tracker/SQLite mappers, not this hook. Malformed entries payloads log `console.error` and fire a sonner error toast instead of throwing inside the hub listener and silently freezing queue updates.
- **2026-05-08: useLogs / useRunEvents reset first-tick flag on SSE error.** Both hooks now reset `gotSseData = false` in their `onError` callback. Browser EventSource auto-reconnects after network blips; the backend sends full history on the new connection's first tick. Without the reset, that snapshot arrived into the delta-append branch and duplicated every prior log/event line.
- **2026-05-08: SSE multiplexed onto a single `/events/hub` endpoint.** Six dashboard SSE streams (entries, logs, runEvents, sessions, telegram, captureSessions) share one EventSource connection per client. A seventh `daemonLog` topic was registered at migration time but had no frontend consumer — `DaemonLogTail` was removed in c5df7639 before this migration; the topic was deleted in the post-migration review cleanup (see lesson below). Topic emitters live in `src/tracker/dashboard/hono/topics-emitters.ts` and register against `topicRegistry` in `topics.ts`. The frontend `SseHub` (singleton in `src/dashboard/lib/sse-hub.ts`) batches subscription changes via `queueMicrotask` so a single render tick produces at most one reconnect. Why this exists: Chrome's HTTP/1.1 6-per-origin connection limit was being saturated by the previous architecture (6+ EventSources at once), causing reload to hang in Chrome only. Adding new real-time features no longer requires triaging "which SSE can we drop?" — multiplexed.
- **2026-05-06: FailureBell read-state via localStorage.** Removed `ApprovalInbox` (amber badge, preview-row notifications) from TopBar. `FailureBell` (red badge) now tracks read state: when popover opens, the current failure count is persisted to localStorage (`failure-bell-read-count`), and the badge only displays `unreadCount = total - readCount`. This prevents the badge from perpetually showing stale counts. The read state persists across page reloads and date changes. Pair this pattern with lazy-fetched data (popover-open triggers `/api/failures` fetch) to avoid polling for failure lists until needed. No tests exist for the checkbox component; manual verification covered.
- **2026-05-01: RunModal driven by `RUN_MODAL_REGISTRY` (`src/dashboard/lib/run-modal-registry.ts`).** `RunModal.tsx` previously had ~10 scattered `workflow === "ocr"` / `isOathUpload` ternaries (title, description, submit URL, section visibility, success-toast shape) plus a silent `workflow = "emergency-contact"` default that hid misconfigured callers. All of it now collapses to a per-workflow registry entry declaring `title`, `description`, `submitUrl`, `sections: { roster?, formType?, duplicateCheck? }`, and `buildSuccessToast`. `TopBarRunButton` derives visibility from `isRunModalEnabled(workflow)` — single source of truth, no more hardcoded `RUN_ENABLED_WORKFLOWS` array. Adding a new file-upload workflow is one entry in the registry; `RunModal.tsx` is not touched. Unknown workflow now logs to console + returns null instead of falling back. **Hook-order gotcha:** the `if (!config) return null` early-return must sit AFTER all `useState`/`useEffect` calls, never before — React's Rules of Hooks require stable hook order across renders. **Workflow-delegation gotcha:** when a workflow delegates to OCR (e.g. `oath-upload` → `ocr` → `oath-signature`), its registry entry MUST enable the `roster` section — the operator picks "use latest" vs "download fresh" once at the parent level, and the choice has to thread through to the delegated OCR. The first oath-upload ship (2026-05-01) hardcoded `rosterMode: "download"` in the handler and was fixed the same day; see `src/workflows/oath-upload/CLAUDE.md`.
- **2026-05-01: OCR per-page retry surfaced inline.** `OcrReviewPane` now renders one of two card types per page in `sourcePage` order: a successful page's records (`PrepReviewPair` / `PrepReviewMultiPair`) or a `FailedPageCard` (page that OCR failed). Backed by new `data.failedPages: FailedPage[]` and `data.pageStatusSummary: {total, succeeded, failed}` on the awaiting-approval tracker row (parsers in `components/ocr/types.ts` JSON-parse them with `?? []` fallback for pre-feature rows). `FailedPageCard` shows attempted-provider chips (deduped by family prefix), an attempt count, and `Retry page` (POSTs `/api/ocr/retry-page`) + local-only `Skip page` buttons. A `Re-OCR whole PDF` confirm dialog (Radix `Dialog`) appears next to Cancel when `failedPages.length > 0`; on success it POSTs `/api/ocr/reocr-whole-pdf`, clears `localEdits` via parent callback, and removes the localStorage edits key. Toast UX matches the rest of the dashboard (`sonner`). The `data-pair-index` IntersectionObserver instrumentation is preserved on records branches; failed cards have no `data-pair-index` and are skipped by the observer.
- **2026-04-29: Navbar add-ons — inbox + bell (palette reverted).** TopBar grew two new affordances: `ApprovalInbox` (amber badge popover) and `FailureBell` (red badge popover). A `CommandPalette` (⌘K, `> token args` syntax) was built and shipped alongside as a SearchBar replacement, but the operator decided the command syntax wasn't wanted and it was reverted the same day — `SearchBar.tsx` is restored at its pre-deletion shape and the palette directory + `useCommandPalette` hook are gone. **Universal preview-row "ready for review" rule** (replaces the per-workflow discriminator table the spec drafts went through): `data.mode === "prepare" && status === "done" && step !== "approved" && step !== "discarded"`. `ApprovalInbox` polls `/api/preview-inbox` every 5 s but pauses while its own popover is open (otherwise the re-render closes the menu). `FailureBell` uses two data sources by design: the badge count comes from `failureCounts` on the **`entries` hub** payload (via `useEntries`, zero extra HTTP), but the popover *list* is lazy-fetched from `/api/failures` only on open — same date-scoping logic, full row payload only when needed. Both endpoints dedupe to **latest run per `(workflow, id)`** — the same two-pass aggregation pattern the search-results dedup fix shipped earlier on 2026-04-29. Bundle: 1,099.12 kB raw / 241.72 kB gzip (was 1,031 kB / 227 kB pre-add-ons; +68 kB raw / +14 kB gzip for the two components + their backend wiring).
- **2026-04-29: Search-results dedup — `(workflow, id)` not `(workflow, id, runId)`.** The `/api/search` backend was keying by `(workflow, id, runId)`, so re-running a failed item produced two rows in the cross-workflow search dropdown. Fix: collapse by `(workflow, id)` and keep the highest-runId entry (which is also the latest). The same two-pass aggregation pattern is now used in `buildPreviewInboxHandler` and `buildFailuresHandler`.
- **2026-04-28: Emergency-contact PreviewRow is parent-of-N.** A new row shape lives at the top of the QueuePanel for any tracker entry with `data.mode === "prepare"`. Pinned above the regular entry list (rendered outside the search/filter pipeline so it stays visible regardless of the operator's status filter). Two states: in-progress (4-stage progress strip + Discard) and ready-for-review (records summary + Review & approve that expands an inline list of `PreviewRecordRow`s). Approve fans out N kernel queue items via `enqueueFromHttp` — the prep row itself is marked `done` step `approved` and filtered out of the panel after that. Per-record edits are mirrored to `localStorage["ec-prep-edits:<parentRunId>"]` so a reload restores in-progress edits; cleared on Approve / Discard. The edit form is **inline** (not a nested modal) — stacking modals on top of the review list would break spatial context. Frontend bundles types from `preview-types.ts` (plain TS interfaces, not Zod) so Zod's runtime stays out of the bundle; validation lives server-side. New shadcn primitives added: `ui/dialog.tsx` (Radix Dialog) + `ui/checkbox.tsx` (Radix Checkbox). Bundle now 1031 KB raw / 227 KB gzip (was 907 KB raw / ~210 KB gzip); the +30 KB gzip is mostly Radix Dialog runtime.
- **2026-04-10: Logs flash and disappear** — Race condition between initial `/api/logs` fetch and the multiplexed **`logs`** hub stream. Both return overlapping data, and when SSE reconnects or runId changes, `setRawLogs([])` clears state before new data arrives. Fix: make SSE the sole data source — backend sends full history on first tick, frontend replaces state on first message and appends on subsequent ones. No separate initial fetch needed.
- **2026-04-10: SSE lastCount mismatch** — Backend `logs` topic tracked `lastCount` across all logs but filtered by `runId` after counting, causing the count to not match filtered array length. Fix: renamed to `sentCount`, send ALL filtered logs on first tick, then only incremental slices after.
- **2026-04-10: RunSelector hidden for single runs** — `runs.length <= 1` returned `null`, so first-run entries never showed "Run #1". Fix: changed to `runs.length === 0` — now always shows run indicator when at least one run exists.
- **2026-04-10: Page refresh loses selection** — Workflow, selected entry, and date were only in React state. Fix: sync to URL search params (`?wf=...&id=...&date=...`) via `history.replaceState` on every state change, read from URL on mount.
- **2026-04-10: Logs empty despite JSONL file having data** — Log entries emitted by `withLogContext` don't have `runId` field, but the dashboard filtered `logs.filter(l => l.runId === runId)` which excluded all logs without `runId`. Fix: changed filter to `!l.runId || l.runId === runId` — logs without `runId` belong to all runs.
- **2026-04-10: Stale "running" entries after process kill** — When user Ctrl+C's a workflow, `withTrackedWorkflow` catch block never runs, so the entry stays "running" forever. Original fix (`markStaleRunningEntries`) was removed because it produced false positives. Proper fix: SIGINT handler in `withTrackedWorkflow` writes `failed` entry synchronously before exit.
- **2026-04-10: Toast notifications transparent** — CSS vars `--card`, `--border`, `--foreground` already contain full `hsl(...)` values, so wrapping in `hsl(var(...))` produces invalid CSS like `hsl(hsl(...))`. Browser falls back to transparent. Fix: use `var(--card)` directly, not `hsl(var(--card))`.
- **2026-04-10: StepPipeline failed step display** — StepPipeline now shows a red X icon on the step where the workflow failed, making it visually clear which phase had the error.
- **2026-04-10: RunSelector redesigned** — Replaced tab-style RunSelector with pill-based design for better density.
- **2026-04-10: EntryItem redesigned** — 4-row layout: name+badge, doc ID, running log or error message, time+run+elapsed. Sorted by running start time (`firstLogTs`), pending entries at bottom.
- **2026-04-10: LogPanel derives step/status from active run** — LogPanel now derives the current step and status from the active run's data, not the global deduped entry. This prevents stale data when switching between runs.
- **2026-04-10: Skeleton loaders** — Added skeleton loaders to LogPanel header, detail grid, step pipeline, and log stream for better loading UX.
- **2026-04-10: LogStream scroll snap** — `useLayoutEffect` snaps scroll to bottom before paint, preventing visual flicker when new logs arrive.
- **2026-04-10: Elapsed time** — Live stopwatch while running, static duration when done/failed. Both EntryItem and LogPanel use the same `firstLogTs`/`lastLogTs` source for consistency.
- **2026-04-10: formatStepName abbreviations** — `formatStepName` handles common abbreviations (UCPath, Kuali, Kronos, CRM, SSO, UKG) to display properly cased step names in the pipeline.
- **2026-04-14: QUEUE stat pill clipped at 1366px** — Base StatPills padding (`px-5 gap-1.5`) left ~51px per pill at 320px queue panel width, too narrow for "QUEUE" with tracking-wider. Fix: tightened base tier to `px-3 gap-1` + `text-[10px]` labels + `min-w-0` on pills; restored wider values at `min-[1440px]`. Also narrowed QueuePanel search padding to match.
- **2026-04-14: RunSelector only showed latest runs** — `readRunsForId` called `readEntries(workflow)` which only reads today's JSONL. Viewing a past date returned no runs. Fix: added optional `date` param and thread it through `/api/runs` + `LogPanel` fetch. See tracker CLAUDE.md for details.
- **2026-04-14 / 2026-05-05: Session drawer empty states** — The session surface should always render; show a **"No active workflows"** placeholder when empty. User preference is stable layout over auto-collapse for the bottom session drawer.
- **2026-04-14: Preflight wiped mock/demo `sessions.jsonl` on refresh** — `/api/preflight` ran on every page mount and deleted `sessions.jsonl` if no `workflow_start` PIDs were alive. Fake/demo data written manually always had dead PIDs → vaporized on refresh. Fix: age-gated deletion (>24h only) + `rebuildSessionState` now marks dead-PID workflows as `active: false` at read time (no file mutation). Crashed workflows still dim immediately without needing to delete the file.
- **2026-04-14: Session + Duo unit tests** — Added `tests/unit/session-events.test.ts` covering `emitSessionEvent`/`readSessionEvents` roundtrip, all `rebuildSessionState` state transitions (workflow_start/end, session_create, browser_launch/close, auth_start/complete, item_start/complete, dead-PID inactive enrichment), and the full duo queue lifecycle (waiting→active→resolved, positions, `duo_waiting` browser overlay). To test new session/duo behavior, extend this file — `rebuildSessionState` is exported with an optional `dir` param for temp-dir isolation.
- **2026-04-17: Per-step timing overlay.** The **`entries` hub** payload enriches rows with `stepDurations: Record<string, number /*ms*/>`, computed from the same-run JSONL history (deltas between consecutive `running` events, capped by `done`/`failed`/`skipped`). The pure helper `computeStepDurations()` is exported from `src/tracker/dashboard.ts` for unit tests. Frontend: `StepPipeline` renders a small `font-mono` duration chip (e.g. `"12s"`, `"2m 15s"`) beneath each completed step name. Still-running final step shows no chip yet; repeated `markStep(X)` doesn't double-count X.
- **2026-04-17: Failure drill-down (superseded 2026-04-21).** Originally added `FailureDrillDown` between `StepPipeline` and `LogStream` for failed entries: classified error + last-20 logs + horizontal screenshot strip. On 2026-04-21 the component was removed — screenshots moved fully into the dedicated `ScreenshotsPanel` tab (which was added in the meantime), so the inline strip became duplicative. Backend stays: `/api/screenshots?workflow=X&itemId=Y` lists PNGs in `.screenshots/` (prefix `<workflow>-<itemId>-`, step + ts parsed from filename) and `/screenshots/<filename>` streams the PNG with `resolveScreenshotPath` path-traversal guard. Failed entries still carry `screenshotCount` so the screenshots tab can skip the round-trip when there are none.
- **2026-04-18: Selector health panel.** Backend: `/api/selector-warnings?days=N` (default 7) scans `*-logs.jsonl` files, filters `level === "warn"` entries whose message matches `/selector fallback triggered: (.+)/`, and returns an aggregated `[{ label, count, firstTs, lastTs, workflows[] }]` sorted count-desc. Factored as `buildSelectorWarningsHandler(dir)` for unit-test isolation. Frontend: `SelectorWarningsPanel` collapses under the Sessions column on the right rail. Badge shows count when > 0 (amber). Polls every 30s. Empty state reads "No selector fallback warnings in the last N days. Primary selectors are stable." The panel is purely a surface — `safeClick`/`safeFill` already emit these warns.
- **2026-04-18: Removed dashboard runner.** The "⚡ RUN" drawer + `RunnerLauncher` button + `SchemaForm` + `runner-recents` localStorage helper + `schema-form-utils` parser were deleted. The backend `src/tracker/runner.ts` (child-process registry) and its `buildSpawnHandler` / `buildCancelHandler` / `buildActiveRunsHandler` / `buildWorkflowSchemaHandler` factories in `src/tracker/dashboard.ts` are gone, along with the `/api/workflows/:name/run`, `/api/workflows/:name/schema`, `/api/runs/:runId/cancel`, and `/api/runs/active` route registrations. **Daemon and composable workflows** still start from CLI `npm run …`; the dashboard later added **targeted** in-process starters (OCR `/api/ocr/prepare`, emergency-contact prep, SharePoint download, etc.) without restoring the generic spawn registry. Session monitoring (the bottom `TerminalDrawer`) still populates from kernel-emitted `emitWorkflowStart` / `emitSessionCreate` / `emitBrowserLaunch` / `emitAuthStart` calls in `src/tracker/jsonl.ts` (via `withTrackedWorkflow`).
- **2026-04-19: Events tab in LogStream.** New filter tab merges into the existing tab system. "All" tab merges logs + RunEvents by ts; "Events" tab shows events only; existing per-category tabs (Errors/Auth/Fill/Navigate/Extract) keep log-only behavior. Consumed via `useRunEvents` → hub topic `runEvents` (`useSseHistoryStream`).
- **2026-04-19: Step-cache visualization in StepPipeline (removed 2026-04-23).** Originally: cached step dots rendered blue with a `❄` glyph + hover tooltip of the step's historical avg duration; footer read "N of M steps reused from cache". Backed by `entry.cacheHits` + `entry.cacheStepAvgs` on the live **`entries`** stream. Removed 2026-04-23 along with the step-cache primitive itself — no more `cache_hit` events are emitted, and the `cacheHits` / `cacheStepAvgs` fields no longer appear on enriched entries. `StepPipeline` renders all step dots in their default status-based colors again.
- **2026-04-24 / 2026-05-05: Dashboard ops surfaces — retry, edit-and-resume, daemon ops.** Seven components ship inline retry / cancel / bump / spawn / stop / log-tail / edit-data affordances, all wired into existing surfaces (`EntryItem`, `LogPanel`, `QueuePanel`, `TerminalDrawer`, `TopBar`) so no new top-level pages. Backend factories live in `src/tracker/dashboard-ops.ts` (matching `buildSelectorWarningsHandler` pattern). Edit-and-resume uses a kernel-level `prefilledData` channel: `splitPrefilled` strips it before Zod validation, the kernel merges via `ctx.updateData(...)` before the handler runs, and workflows opt in by gating their extraction step on `!ctx.data.X` + adding `editable: true` to relevant `detailFields` (only separations is opted in as of this date — onboarding is a deferred follow-up because EmployeeData is ~17 fields). Retry reads SQLite task input first, then tracker `entry.input`/`data` fallback. Daemon controls mutate SQLite `tasks`, `worker_commands`, and scoped `browser_processes`; JSONL queue files are audit/history plus migration fallback. Cancel-queued cancels the SQLite task/attempt and emits a tracker cancel row. Queue-bump updates SQLite task priority so claim order actually changes under the default backend. Visual spec: `docs/superpowers/specs/2026-04-24-dashboard-ops-visual-spec.md`. Design spec: `docs/superpowers/specs/2026-04-24-dashboard-operations-design.md`.
- **2026-04-22: Roster download dropdown in queue header.** The `QueuePanel` header surfaces a Radix `DropdownMenu` triggered by a Download icon (lucide-react `Download` / `Loader2` / `ChevronDown`) to the right of the search input for every workflow. On mount the panel fetches `GET /api/sharepoint-download/list` (backed by `buildSharePointListHandler` in `src/workflows/sharepoint-download/handler.ts`) and caches the result; menu items are rendered one-per-spec from the backend `SHAREPOINT_DOWNLOADS` registry, with unconfigured entries shown disabled + an `unset` hint + tooltip pointing at the env var. Clicking a configured item fires `POST /api/sharepoint-download/run` with `{ id }`, backed by `buildSharePointRosterDownloadHandler` — `dashboard.ts` just wires both factories into the HTTP routes + inline-parses the POST body. Handler reads `process.env[spec.envVar]` (missing → 400 with an actionable message), holds a module-level in-flight lock across all ids (concurrent → 409), and invokes `downloadSharePointFile` (`src/workflows/sharepoint-download/download.ts`) to save into `src/data/` (or `spec.outDir` if overridden). Frontend toasts: `loading` on click, `success` with saved path, `warning` on 409, `error` on 4xx/5xx. The handler + helper + registry live in a dedicated non-kernel workflow directory (no `defineWorkflow`, no tracker JSONL) so they stay out of the TopBar workflow dropdown — see `src/workflows/sharepoint-download/CLAUDE.md` for the full non-kernel rationale + how to add a new spreadsheet entry (one line in `registry.ts` + one `.env.example` line, no frontend or route changes needed). Deliberately does **not** reintroduce the 2026-04-18-removed runner / child-process registry — this is a single in-process helper call on the SSE server. Endpoint was renamed from the pre-registry shape (`/api/emergency-contact/download-roster`, no body, hardcoded to `ONBOARDING_ROSTER_URL`) to today's `{ /list + /run { id } }` pair in the same commit; no remaining references to the old path.
- **2026-04-19: Frontend test harness deferred.** Events-tab and StepPipeline cache tests in `tests/unit/dashboard/` were designed but not shipped — the project has no `@testing-library/react` / `jsdom` setup. Manual verification covered for v1; if frontend tests become a priority, adding those deps + a vitest-or-node-test JSDOM bootstrap would unlock the two designed tests.

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
    navigation/              # TopBar, WorkflowRail, SearchBar/SearchResults, FailureBell, quick-run/capture buttons
    oath-upload/             # duplicate-banner helpers
    ocr/                     # OCR review pane, record views, preview pairs, delegation rows
    queue-panel/             # QueuePanel, EntryItem, daemon/batch rows, bulk controls, sort/status/surface helpers
    run-modal/               # RunModal + SharePointDownloadButton
    shared/                  # reusable buttons, empty state, PDF preview, selector warnings, entry display/types/status styles
    terminal-drawer/         # TerminalDrawer, WorkflowBox, BrowserChip, LiveIndicator
    ui/                      # local shadcn-style primitives + HeroUI Calendar wrapper
  lib/
    ocr-downstream-registry.ts
    quick-run-registry.ts
    run-modal-registry.ts
    sse-hub.ts
    utils.ts                 # cn() — class merge helper
    workflow-icons.ts
    workflows-context.tsx    # /api/workflow-definitions consumer; useWorkflow(name)
```
