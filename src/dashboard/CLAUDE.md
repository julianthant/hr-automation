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

Defined in `types.ts` as `WF_CONFIG`:

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
| `src/tracker/jsonl.ts` | Add `runId` to TrackerEntry + LogEntry, add `cleanOldTrackerFiles()`, add mutex locking to `trackEvent`/`appendLogEntry` |
| `src/tracker/dashboard.ts` | Add `/api/runs`, `/api/preflight` endpoints, add `runId` filtering to `/api/logs` and `/events/logs` |
| `src/dashboard/components/types.ts` | Update TrackerEntry/LogEntry types, update WF_CONFIG |

## Files to Create (Frontend)

All new components in `src/dashboard/components/`:
- `TopBar.tsx`, `QueuePanel.tsx`, `EntryItem.tsx`, `LogPanel.tsx`
- `StepPipeline.tsx`, `LogStream.tsx`, `LogLine.tsx`, `StatPills.tsx`
- `RunSelector.tsx`, `EmptyState.tsx`
- `hooks/useSSE.ts`, `hooks/useClock.ts`, `hooks/useEntries.ts`
- `hooks/useLogs.ts`, `hooks/useElapsed.ts`, `hooks/usePreflight.ts`
- `ui/` — shadcn components (installed via `npx shadcn@latest add`)
