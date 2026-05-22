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

Component placement rules live in `components/CLAUDE.md`. Read that file before adding, moving, or promoting files under `src/dashboard/components/`.

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

- **Lesson maintenance rule:** Before adding a dashboard lesson, search this section for the same feature or failure mode. Merge stale notes into the current rule, remove contradictions, and keep historical implementation details only when they explain a still-current gotcha.
- **Queue surfaces and actions:** Queue rendering flows through `buildTrackerQueueSurfaces` -> `WorkflowRunProjection` -> queue components. New row types should extend the classifier/projection layer and `GroupRowBase` wrappers, not add workflow-specific branches in `QueuePanel`. Projection actions must carry concrete `targets` (`workflowId`, `id`, `runId?`, `date?`, `status?`), and all row/bulk controls should dispatch through `useWorkflowActionDispatcher` so scope/source survive to `performWorkflowAction`.
- **Prep and delegation cards:** Prep/upload batch-parent rows are operator actions, so their surface kind should stay stable across review/approval. A single approved prep row with one visible child remains an `approval-delegation` card; a prep row with no visible members can render flat. Multi-file upload is intentionally N independent single-file prep runs, not one grouped parent card.
- **OCR discard and review:** OCR prep discard/cancel must travel through `/api/cancel-queued` or `/api/task/force-stop` with OCR context (`ocrSessionId`, OCR `runId`, parent row fields, `formType`, `reason`). Do not resurrect `/api/ocr/discard-prepare`. Delegated OCR review rows at `status=done` / `step=awaiting-approval` are still action-capable: keep `Needs review` plus normal retry/delete footer controls.
- **Titles:** Use queue-title metadata first for non-person rows (`__queueRootTitle`, `__queueTitle`), but person/delegated rows keep `name`, `employeeName`, `searchName`, or valid EID as the visible title. Never promote technical ids such as `ocr-oath-*`, `ocr-retry-*`, raw run ids, or parent ids to primary row text.
- **SSE:** All real-time dashboard streams use one `/events/hub` EventSource. Topic emitters live in `src/tracker/dashboard/hono/topics-emitters.ts`; frontend subscriptions use `src/dashboard/lib/sse-hub.ts`. Listener errors must be logged without killing other listeners, first-tick flags reset after SSE errors, and `useEntries` validates the shallow `{sub,data,event?}` envelope before state updates.
- **TopBar and run launchers:** `FailureBell` replaced the old approval inbox and lazy-fetches `/api/failures` only when opened while counts ride the `entries` hub payload. File-upload launchers belong in `RUN_MODAL_REGISTRY`; unknown workflow configs must not fall back silently, and the hook-order guard (`if (!config) return null` after hooks) still applies.
- **OCR review UI:** `OcrReviewPane` renders successful records and failed page cards in `sourcePage` order. Re-OCR and per-page retry clear local edits for affected pages, preserve `data-pair-index` instrumentation on successful records, and avoid nested modals that break review context.
- **Core UX conventions:** Keep workflow/date/selection in URL params, always show a run indicator when at least one run exists, use `var(--token)` directly for CSS variables that already contain `hsl(...)`, keep the session drawer visible with a "No active workflows" placeholder, and use `firstLogTs` / `lastLogTs` consistently for elapsed time.
- **Historical removals that should stay removed:** The generic dashboard runner, command palette replacement for search, inline failure drill-down strip, step-cache visualization, daemonLog topic, and `/api/preview-inbox` are gone. Do not re-add them unless there is a new explicit design.
- **Testing gap:** The dashboard still lacks a browser/component test harness (`@testing-library/react` / `jsdom`). Pure queue/projection logic has unit tests; visual/component changes still need lint, typecheck, dashboard build, and manual dashboard verification until a harness is added.

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
