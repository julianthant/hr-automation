# Dashboard — Implementation Guide

React SPA for real-time HR workflow monitoring. Split-panel layout: queue (left) + log stream (right).

## Stack

- React 19, Vite 8, Tailwind CSS v4, shadcn/ui primitives, lucide-react, sonner (toasts)
- HeroUI (`@heroui/react`, `@heroui/calendar`, `@heroui/styles`) — used for the date Calendar in `components/ui/calendar.tsx` and its global stylesheet imported from `index.css`. Other shadcn-style primitives (button, dropdown, popover, etc.) are local files in `components/ui/`.
- Theme: CSS variables from `theme.md` (root-level), pasted into `index.css`
- Fonts: Inter (sans), JetBrains Mono (mono) — loaded via Google Fonts in `index.html`
- No framer-motion

## Component Tree

```
App.tsx
├── TopBar.tsx
│   ├── Workflow dropdown (shadcn Select → popover with name + count)
│   ├── Date navigation (arrow buttons + shadcn Popover + Calendar)
│   ├── SearchBar.tsx (cross-workflow tracker entry search → SearchResults.tsx)
│   ├── Live indicator (green dot pill)
│   └── Clock (useClock hook)
├── QueuePanel.tsx
│   ├── Search input (shadcn Input)
│   ├── StatPills.tsx (5 clickable cards, doubles as status filter)
│   └── Entry list (shadcn ScrollArea)
│       └── EntryItem.tsx × N (name, badge, step, time, error)
├── LogPanel.tsx
│   ├── Header (name, badge, email, RunSelector.tsx)
│   ├── Detail grid (4 cells, varies per workflow)
│   ├── StepPipeline.tsx (horizontal dots + connectors + timing)
│   ├── LogStream.tsx (shadcn ScrollArea; 7 filter tabs: All/Errors/Auth/Fill/Navigate/Extract/Events)
│   │   └── LogLine.tsx × N (timestamp, icon, message, dup badge, copy)
│   └── Footer (streaming indicator, count, auto-scroll toggle)
└── SessionPanel.tsx (right rail, 240–320 px)
    ├── WorkflowBox.tsx × N (active workflow instances + BrowserChip.tsx per browser)
    └── SelectorWarningsPanel.tsx (selector-fallback warns, polled every 30 s)
```

## Backend Wiring (SSE API on port 3838)

The backend is `src/tracker/dashboard.ts` — a plain Node HTTP server. The Vite dev server (port 5173) proxies `/api/*` and `/events/*` to it via `vite.dashboard.config.ts`.

### Endpoints

| Endpoint | Method | Returns | Frontend Consumer |
|----------|--------|---------|-------------------|
| `/api/workflows` | GET | `string[]` — workflow names with JSONL data | `TopBar.tsx` dropdown options |
| `/api/workflow-definitions` | GET | `WorkflowMetadata[]` — registry payload (label, steps, detailFields, getName/getId hints) | `WorkflowsProvider` / `useWorkflow(name)` |
| `/api/dates?workflow=X` | GET | `string[]` — dates (desc) with entries | `TopBar.tsx` date navigator |
| `/api/entries?workflow=X` | GET | `TrackerEntry[]` — all entries for today | Initial load in `useEntries` |
| `/api/logs?workflow=X&id=Y&runId=Z` | GET | `LogEntry[]` — logs for an entry/run | Initial load in `useLogs` |
| `/api/runs?workflow=X&id=Y[&date=D]` | GET | `RunInfo[]` — `{runId, status, timestamp}` per run | `RunSelector.tsx` pills |
| `/api/screenshots?workflow=X&itemId=Y` | GET | `ScreenshotListEntry[]` matching `<workflow>-<itemId>-` prefix | `ScreenshotsPanel` grid |
| `/screenshots/<filename>` | GET | PNG bytes, path-traversal guarded via `resolveScreenshotPath` | `ScreenshotsPanel` / `ScreenshotCard` `<img>` |
| `/api/search?q=Q[&days=N]` | GET | `SearchResultRow[]` — cross-workflow tracker entry hits | `SearchBar` / `SearchResults` |
| `/api/preflight` | GET | `{checks: [{name, passed, detail}], cleanedFiles?: number}` | `usePreflight` → sonner toast |
| `/api/sharepoint-download/list` | GET | `SharePointDownloadListItem[]` — one row per registered spreadsheet (`{id, label, description?, envVar, configured}`) | `QueuePanel` Download dropdown — populates menu on mount |
| `/api/sharepoint-download/run` | POST | Body: `{ id }`. Response: `{ok, id, label, path, filename}` or `{ok:false, error}` — launches headed SharePoint download via `buildSharePointRosterDownloadHandler` (in `src/workflows/sharepoint-download/`), saves to `src/data/` | `QueuePanel` Download dropdown — fired when a menu item is picked |
| `/api/retry` | POST | Body: `{workflow, id, runId?}`. Re-enqueues using the entry's persisted `input` field. | `RetryButton` (EntryItem failed rows + LogPanel header) |
| `/api/retry-bulk` | POST | Body: `{workflow, ids[]}`. Loops `/api/retry`. | `BulkRetryBar` |
| `/api/run-with-data` | POST | Body: `{workflow, id, data}`. Re-enqueues with `prefilledData` channel; kernel merges into ctx.data + workflow's extraction gate skips. | `EditDataTab` |
| `/api/cancel-queued` | POST | Body: `{workflow, id}`. File-locked queue rewrite + synthetic failed event + tracker row with `step:"cancelled"`. 409 if claimed. | `QueueItemControls` |
| `/api/queue/bump` | POST | Body: `{workflow, id}`. Moves a queued item to head. 409 if claimed. | `QueueItemControls` |
| `/api/queue-depth` | GET | `{workflow: depth}` map (count of queued items per workflow). | `useQueueDepth` → `TopBar` queue-depth pill |
| `/api/daemons` | GET | `DaemonInfo[]` — alive daemons with pid, uptime, items processed, current item, phase. | `useDaemons` → `DaemonRow` |
| `/api/daemons/spawn` | POST | Body: `{workflow, count?}`. Fire-and-forget spawn. | `DaemonsSection` Plus button |
| `/api/daemons/stop` | POST | Body: `{workflow?, force?}`. Soft-stops one or all workflows' daemons. | `DaemonsSection` Square button + `DaemonRow` PowerOff |
| `/events/daemon-log?pid=X` | SSE | `{line, ts}` per log line, tails `.tracker/daemons/<wf>-<pid>.log`. | `DaemonLogTail` |
| `/api/selector-warnings?days=N` | GET | `SelectorWarningRow[]` grouped by label | `SelectorWarningsPanel` (right rail) |
| `/api/stats?workflow=X[&days=N]` | GET | `StatsResponse` — per-workflow/step aggregates (uncommitted scaffolding — no frontend caller yet) | _none_ |
| `/api/diff?workflow=X&id=Y&runA=A&runB=B` | GET | `DiffResponse` — side-by-side run comparison (uncommitted scaffolding — no frontend caller yet) | _none_ |
| `/events?workflow=X&date=Y` | SSE | `{entries, workflows, wfCounts}` enriched + `stepDurations` every 1s | `useEntries` hook |
| `/events/logs?workflow=X&id=Y&runId=Z&date=D` | SSE | `LogEntry[]` (new only) every 500ms | `useLogs` hook |
| `/events/run-events?workflow=X&id=Y&runId=Z&date=D` | SSE | `RunEvent[]` (delta) every 500ms | `useRunEvents` hook |
| `/events/sessions` | SSE | `SessionState` (workflow instances + browsers + duo queue) | `useSessions` → `SessionPanel` |

### Data Types (shared between backend and frontend)

```typescript
// src/tracker/jsonl.ts (backend) and src/dashboard/components/types.ts (frontend)

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
- Files older than 7 days are auto-cleaned on dashboard startup.

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

### Run Isolation

When re-running the same ID (e.g. a failed separation re-run):
- Backend assigns `runId = "{id}#2"` (counts existing entries with same ID)
- Logs are tagged with `runId`
- Frontend fetches runs via `/api/runs`, shows tabs: "Run #1 ✗" | "Run #2"
- Switching tabs re-fetches logs for that `runId`

## Workflow-Specific Configuration

All dashboard UI metadata lives on the server-side `WorkflowMetadata` registry (populated by `defineWorkflow` for kernel workflows, `defineDashboardMetadata` for legacy ones). Frontend consumes via the `WorkflowsProvider` + `useWorkflow(name)` hook (`src/dashboard/workflows-context.tsx`) backed by `/api/workflow-definitions`. The former `WF_CONFIG` constant was deleted in subsystem D — there is no frontend-side hardcoding of labels, name/id resolvers, or detailField arrays anywhere.

Current consumption:

| Workflow | Primary ID | Name Source | Steps | Detail Fields |
|----------|-----------|-------------|-------|---------------|
| `onboarding` | email | `data.firstName + data.lastName` | crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction | Employee, Email, Dept #, Position #, Wage, Eff Date, I9 Profile |
| `separations` | doc ID | `data.name \|\| data.employeeName` | launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization | Employee, EID, Doc ID |
| `eid-lookup` | search name | `data.name` | ucpath-auth → searching (→ crm-auth → cross-verification) | (no declared detailFields — see workflow CLAUDE.md) |
| `kronos-reports` | employee ID | `data.name` | searching → extracting → downloading | Employee, ID |
| `work-study` | empl ID | `data.name` | ucpath-auth → transaction | Empl ID, Effective Date |
| `emergency-contact` | `p{NN}-{emplId}` | `data.employeeName` | navigation → fill-form → save | Employee, Empl ID, Contact, Relationship |

## Hook → Component Mapping

| Hook | Component | What it does |
|------|-----------|-------------|
| `useEntries(workflow, date)` | `App.tsx` → `QueuePanel` | SSE to `/events`, dedupes, sorts newest-first |
| `useLogs(workflow, id, runId, date)` | `LogPanel` → `LogStream` | Fetch + SSE, collapses duplicates |
| `useRunEvents(workflow, id, runId, date)` | `LogPanel` → `LogStream` (Events tab) | SSE to `/events/run-events`, full history first tick + deltas |
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
```

## Adding a New Workflow to the Dashboard

The dashboard now auto-adapts — no frontend changes needed. When a new workflow lands:

1. **Kernel-based workflow** — declare `label`, `getName`, `getId`, and labeled `detailFields` inside the `defineWorkflow(...)` config. The registry + `/api/workflow-definitions` picks them up automatically; the detail grid renders whatever is declared.
2. **Legacy (non-kernel) workflow** — call `defineDashboardMetadata({ name, label, steps, systems, detailFields })` at module load in the workflow's `index.ts`. Same registry, same auto-rendering.
3. **Log icon mapping** — if the workflow introduces new log message patterns, add them to the icon mapping in `LogLine.tsx`.
4. **Test** — run `npm run dashboard`, trigger the workflow, verify entries appear and steps progress. The detail panel should populate from your declared `detailFields` via `updateData` calls in the handler.

## Lessons Learned

- **2026-04-10: Logs flash and disappear** — Race condition between initial `/api/logs` fetch and SSE `/events/logs` stream. Both return overlapping data, and when SSE reconnects or runId changes, `setRawLogs([])` clears state before new data arrives. Fix: make SSE the sole data source — backend sends full history on first tick, frontend replaces state on first message and appends on subsequent ones. No separate initial fetch needed.
- **2026-04-10: SSE lastCount mismatch** — Backend `/events/logs` tracked `lastCount` across all logs but filtered by `runId` after counting, causing the count to not match filtered array length. Fix: renamed to `sentCount`, send ALL filtered logs on first tick, then only incremental slices after.
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
- **2026-04-14: SessionPanel + DuoPanel hidden when empty** — Both panels previously `return null` when their state was empty, causing layout to jump as panels appeared/disappeared. Fix: always render; show "No active workflows" / "No pending auth" placeholders when empty. User preference is stable layout over auto-collapse for both the bottom SessionPanel and the right-side DuoPanel.
- **2026-04-14: Preflight wiped mock/demo `sessions.jsonl` on refresh** — `/api/preflight` ran on every page mount and deleted `sessions.jsonl` if no `workflow_start` PIDs were alive. Fake/demo data written manually always had dead PIDs → vaporized on refresh. Fix: age-gated deletion (>24h only) + `rebuildSessionState` now marks dead-PID workflows as `active: false` at read time (no file mutation). Crashed workflows still dim immediately without needing to delete the file.
- **2026-04-14: Session + Duo unit tests** — Added `tests/unit/session-events.test.ts` covering `emitSessionEvent`/`readSessionEvents` roundtrip, all `rebuildSessionState` state transitions (workflow_start/end, session_create, browser_launch/close, auth_start/complete, item_start/complete, dead-PID inactive enrichment), and the full duo queue lifecycle (waiting→active→resolved, positions, `duo_waiting` browser overlay). To test new session/duo behavior, extend this file — `rebuildSessionState` is exported with an optional `dir` param for temp-dir isolation.
- **2026-04-17: Per-step timing overlay.** Backend `/events` now enriches entries with `stepDurations: Record<string, number /*ms*/>`, computed from the same-run JSONL history (deltas between consecutive `running` events, capped by `done`/`failed`/`skipped`). The pure helper `computeStepDurations()` is exported from `src/tracker/dashboard.ts` for unit tests. Frontend: `StepPipeline` renders a small `font-mono` duration chip (e.g. `"12s"`, `"2m 15s"`) beneath each completed step name. Still-running final step shows no chip yet; repeated `markStep(X)` doesn't double-count X.
- **2026-04-17: Failure drill-down (superseded 2026-04-21).** Originally added `FailureDrillDown` between `StepPipeline` and `LogStream` for failed entries: classified error + last-20 logs + horizontal screenshot strip. On 2026-04-21 the component was removed — screenshots moved fully into the dedicated `ScreenshotsPanel` tab (which was added in the meantime), so the inline strip became duplicative. Backend stays: `/api/screenshots?workflow=X&itemId=Y` lists PNGs in `.screenshots/` (prefix `<workflow>-<itemId>-`, step + ts parsed from filename) and `/screenshots/<filename>` streams the PNG with `resolveScreenshotPath` path-traversal guard. Failed entries still carry `screenshotCount` so the screenshots tab can skip the round-trip when there are none.
- **2026-04-18: Selector health panel.** Backend: `/api/selector-warnings?days=N` (default 7) scans `*-logs.jsonl` files, filters `level === "warn"` entries whose message matches `/selector fallback triggered: (.+)/`, and returns an aggregated `[{ label, count, firstTs, lastTs, workflows[] }]` sorted count-desc. Factored as `buildSelectorWarningsHandler(dir)` for unit-test isolation. Frontend: `SelectorWarningsPanel` collapses under the Sessions column on the right rail. Badge shows count when > 0 (amber). Polls every 30s. Empty state reads "No selector fallback warnings in the last N days. Primary selectors are stable." The panel is purely a surface — `safeClick`/`safeFill` already emit these warns.
- **2026-04-18: Removed dashboard runner.** The "⚡ RUN" drawer + `RunnerLauncher` button + `SchemaForm` + `runner-recents` localStorage helper + `schema-form-utils` parser were deleted. The backend `src/tracker/runner.ts` (child-process registry) and its `buildSpawnHandler` / `buildCancelHandler` / `buildActiveRunsHandler` / `buildWorkflowSchemaHandler` factories in `src/tracker/dashboard.ts` are gone, along with the `/api/workflows/:name/run`, `/api/workflows/:name/schema`, `/api/runs/:runId/cancel`, and `/api/runs/active` route registrations. Workflows are launched only via the npm scripts in `package.json` (or whatever replacement launcher lands later). Session monitoring (the bottom `SessionPanel` showing live workflows + their current step + auth state) still populates from kernel-emitted `emitWorkflowStart` / `emitSessionCreate` / `emitBrowserLaunch` / `emitAuthStart` calls in `src/tracker/jsonl.ts` (called by `withTrackedWorkflow`) — verified during this removal, no runner dependency.
- **2026-04-19: Events tab in LogStream.** New filter tab merges into the existing tab system. "All" tab merges logs + RunEvents by ts; "Events" tab shows events only; existing per-category tabs (Errors/Auth/Fill/Navigate/Extract) keep log-only behavior. Backed by the new `/events/run-events` SSE; consumed via `useRunEvents` hook (twin of `useLogs`).
- **2026-04-19: Step-cache visualization in StepPipeline (removed 2026-04-23).** Originally: cached step dots rendered blue with a `❄` glyph + hover tooltip of the step's historical avg duration; footer read "N of M steps reused from cache". Backed by `entry.cacheHits` + `entry.cacheStepAvgs` enriched by `/events` SSE. Removed 2026-04-23 along with the step-cache primitive itself — no more `cache_hit` events are emitted, and the `cacheHits` / `cacheStepAvgs` fields no longer appear on enriched entries. `StepPipeline` renders all step dots in their default status-based colors again.
- **2026-04-24: Dashboard ops surfaces — retry, edit-and-resume, daemon ops.** Seven new components ship inline retry / cancel / bump / spawn / stop / log-tail / edit-data affordances, all wired into existing surfaces (`EntryItem`, `LogPanel`, `QueuePanel`, `SessionPanel`, `TopBar`) so no new top-level pages. Backend factories live in `src/tracker/dashboard-ops.ts` (matching `buildSelectorWarningsHandler` pattern). Edit-and-resume uses a kernel-level `prefilledData` channel: `splitPrefilled` strips it before Zod validation, the kernel merges via `ctx.updateData(...)` before the handler runs, and workflows opt in by gating their extraction step on `!ctx.data.X` + adding `editable: true` to relevant `detailFields` (only separations is opted in as of this date — onboarding is a deferred follow-up because EmployeeData is ~17 fields). Retry reads `entry.input` (a new TrackerEntry field set on pending rows by the kernel + enqueue-dispatch). Daemon ops read `findAliveDaemons` + the existing queue file format — itemsProcessed is computed from `claim` + `done`/`failed` events whose `claimedBy` matches the daemon's instanceId, no new daemon-pid stamping needed. Cancel-queued + queue-bump use the same `fs.mkdir` directory mutex as `claimNextItem` to serialize concurrent mutations; both return 409 if a daemon already claimed the item between click and lock. Visual spec: `docs/superpowers/specs/2026-04-24-dashboard-ops-visual-spec.md`. Design spec: `docs/superpowers/specs/2026-04-24-dashboard-operations-design.md`.
- **2026-04-22: Roster download dropdown in queue header.** The `QueuePanel` header surfaces a Radix `DropdownMenu` triggered by a Download icon (lucide-react `Download` / `Loader2` / `ChevronDown`) to the right of the search input for every workflow. On mount the panel fetches `GET /api/sharepoint-download/list` (backed by `buildSharePointListHandler` in `src/workflows/sharepoint-download/handler.ts`) and caches the result; menu items are rendered one-per-spec from the backend `SHAREPOINT_DOWNLOADS` registry, with unconfigured entries shown disabled + an `unset` hint + tooltip pointing at the env var. Clicking a configured item fires `POST /api/sharepoint-download/run` with `{ id }`, backed by `buildSharePointRosterDownloadHandler` — `dashboard.ts` just wires both factories into the HTTP routes + inline-parses the POST body. Handler reads `process.env[spec.envVar]` (missing → 400 with an actionable message), holds a module-level in-flight lock across all ids (concurrent → 409), and invokes `downloadSharePointFile` (`src/workflows/sharepoint-download/download.ts`) to save into `src/data/` (or `spec.outDir` if overridden). Frontend toasts: `loading` on click, `success` with saved path, `warning` on 409, `error` on 4xx/5xx. The handler + helper + registry live in a dedicated non-kernel workflow directory (no `defineWorkflow`, no tracker JSONL) so they stay out of the TopBar workflow dropdown — see `src/workflows/sharepoint-download/CLAUDE.md` for the full non-kernel rationale + how to add a new spreadsheet entry (one line in `registry.ts` + one `.env.example` line, no frontend or route changes needed). Deliberately does **not** reintroduce the 2026-04-18-removed runner / child-process registry — this is a single in-process helper call on the SSE server. Endpoint was renamed from the pre-registry shape (`/api/emergency-contact/download-roster`, no body, hardcoded to `ONBOARDING_ROSTER_URL`) to today's `{ /list + /run { id } }` pair in the same commit; no remaining references to the old path.
- **2026-04-19: Frontend test harness deferred.** Events-tab and StepPipeline cache tests in `tests/unit/dashboard/` were designed but not shipped — the project has no `@testing-library/react` / `jsdom` setup. Manual verification covered for v1; if frontend tests become a priority, adding those deps + a vitest-or-node-test JSDOM bootstrap would unlock the two designed tests.

## Frontend Files

```
src/dashboard/
  App.tsx                    # Top-level layout (TopBar + QueuePanel + LogPanel + SessionPanel)
  main.tsx                   # React root + WorkflowsProvider
  workflows-context.tsx      # /api/workflow-definitions consumer; useWorkflow(name)
  index.css                  # CSS variables, @import "@heroui/styles", Tailwind setup
  index.html                 # Vite entry
  components/
    TopBar.tsx, QueuePanel.tsx, EntryItem.tsx, LogPanel.tsx
    StepPipeline.tsx, LogStream.tsx, LogLine.tsx, StatPills.tsx
    RunSelector.tsx, EmptyState.tsx
    SearchBar.tsx, SearchResults.tsx
    ScreenshotsPanel.tsx, ScreenshotCard.tsx, ScreenshotLightbox.tsx
    SessionPanel.tsx, WorkflowBox.tsx, BrowserChip.tsx, SelectorWarningsPanel.tsx
    entry-display.ts (resolveEntryName / resolveEntryId)
    types.ts (TrackerEntry, LogEntry, RunInfo, AuthState, BrowserState, etc.)
    hooks/
      useClock.ts, useEntries.ts, useLogs.ts, useElapsed.ts
      usePreflight.ts, useSessions.ts
    ui/  # local shadcn-style primitives + HeroUI Calendar wrapper
      calendar.tsx, dropdown-menu.tsx, popover.tsx
  lib/utils.ts               # cn() — class merge helper
```
