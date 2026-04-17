# Dashboard — Implementation Guide

React SPA for real-time HR workflow monitoring. Split-panel layout: queue (left) + log stream (right).

## Stack

- React 19, Vite 8, Tailwind CSS v4, shadcn/ui, lucide-react, sonner (toasts)
- Theme: CSS variables from `theme.md` (root-level), pasted into `index.css`
- Fonts: Inter (sans), JetBrains Mono (mono) — loaded via Google Fonts in `index.html`
- No HeroUI, no framer-motion

## Component Tree

```
App.tsx
├── TopBar.tsx
│   ├── Workflow dropdown (shadcn Select → popover with name + count)
│   ├── Date navigation (arrow buttons + shadcn Popover + Calendar)
│   ├── Live indicator (green dot pill)
│   └── Clock (useClock hook)
├── QueuePanel.tsx
│   ├── Search input (shadcn Input)
│   ├── StatPills.tsx (5 clickable cards, doubles as status filter)
│   └── Entry list (shadcn ScrollArea)
│       └── EntryItem.tsx × N (name, badge, step, time, error)
└── LogPanel.tsx
    ├── Header (name, badge, email, RunSelector.tsx)
    ├── Detail grid (4 cells, varies per workflow)
    ├── StepPipeline.tsx (horizontal dots + connectors + timing)
    ├── Log filter tabs (All | Errors | Auth | Fill | Navigate | Extract)
    ├── LogStream.tsx (shadcn ScrollArea)
    │   └── LogLine.tsx × N (timestamp, icon, message, dup badge, copy)
    └── Footer (streaming indicator, count, auto-scroll toggle)
```

## Backend Wiring (SSE API on port 3838)

The backend is `src/tracker/dashboard.ts` — a plain Node HTTP server. The Vite dev server (port 5173) proxies `/api/*` and `/events/*` to it via `vite.dashboard.config.ts`.

### Endpoints

| Endpoint | Method | Returns | Frontend Consumer |
|----------|--------|---------|-------------------|
| `/api/workflows` | GET | `string[]` — workflow names with JSONL data | `TopBar.tsx` dropdown options |
| `/api/dates?workflow=X` | GET | `string[]` — dates (desc) with entries | `TopBar.tsx` date navigator |
| `/api/entries?workflow=X` | GET | `TrackerEntry[]` — all entries for today | Initial load in `useEntries` |
| `/api/logs?workflow=X&id=Y&runId=Z` | GET | `LogEntry[]` — logs for an entry/run | Initial load in `useLogs` |
| `/api/runs?workflow=X&id=Y` | GET | `{runId, status, timestamp}[]` | `RunSelector.tsx` tabs |
| `/api/preflight` | GET | `{checks: [{name, passed, detail}]}` | `usePreflight` → sonner toast |
| `/events?workflow=X&date=Y` | SSE | `{entries: TrackerEntry[], workflows: string[]}` every 1s | `useEntries` hook |
| `/events/logs?workflow=X&id=Y&runId=Z&date=D` | SSE | `LogEntry[]` (new only) every 500ms | `useLogs` hook |

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
| `onboarding` | email | `data.firstName + data.lastName` | crm-auth → extraction → ucpath-auth → person-search → transaction | Employee, Email, Started, Elapsed |
| `separations` | doc ID | `data.name \|\| data.employeeName` | launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization | Employee, Doc ID, Started, Elapsed |
| `eid-lookup` | search name | `data.name` | ucpath-auth → searching (→ crm-auth → cross-verification) | Search Name, Empl ID, Started, Elapsed |
| `kronos-reports` | employee ID | `data.name` | searching → extracting → downloading | Employee, ID, Started, Elapsed |
| `work-study` | empl ID | `data.name` | ucpath-auth → transaction | Employee, Empl ID, Started, Elapsed |

## Hook → Component Mapping

| Hook | Component | What it does |
|------|-----------|-------------|
| `useEntries(workflow, date)` | `App.tsx` → `QueuePanel` | SSE to `/events`, dedupes, sorts newest-first |
| `useLogs(workflow, id, runId, date)` | `LogPanel` → `LogStream` | Fetch + SSE, collapses duplicates |
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

## Files to Modify (Backend)

| File | Change |
|------|--------|
| `src/tracker/jsonl.ts` | Add `runId` to TrackerEntry + LogEntry, add `cleanOldTrackerFiles()`, keep `trackEvent`/`appendLogEntry` synchronous (no mutex — `appendFileSync` is atomic) |
| `src/tracker/dashboard.ts` | Add `/api/runs`, `/api/preflight` endpoints, add `runId` filtering to `/api/logs` and `/events/logs` |
| `src/dashboard/components/types.ts` | Update TrackerEntry/LogEntry types (add typedData if new shape) |

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

## Files to Create (Frontend)

All new components in `src/dashboard/components/`:
- `TopBar.tsx`, `QueuePanel.tsx`, `EntryItem.tsx`, `LogPanel.tsx`
- `StepPipeline.tsx`, `LogStream.tsx`, `LogLine.tsx`, `StatPills.tsx`
- `RunSelector.tsx`, `EmptyState.tsx`
- `hooks/useSSE.ts`, `hooks/useClock.ts`, `hooks/useEntries.ts`
- `hooks/useLogs.ts`, `hooks/useElapsed.ts`, `hooks/usePreflight.ts`
- `ui/` — shadcn components (installed via `npx shadcn@latest add`)
