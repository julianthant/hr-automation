# Dashboard Redesign — shadcn Split Panel

**Date:** 2026-04-10
**Status:** Approved

## Summary

Complete frontend rewrite of the HR Dashboard. Replace HeroUI v3 with shadcn/ui, fix layout glitches, and redesign as a split-panel (queue + log stream) layout. Backend changes: run isolation, JSONL locking, 7-day retention, log deduplication.

## Motivation

- HeroUI v3 compound component API causes rendering glitches (Select, DatePicker, Calendar)
- CSS overrides (`[&_button]:!bg-transparent`) fight HeroUI's style system
- Current table layout can't show logs and entries simultaneously
- Re-running a failed workflow for the same ID bleeds old logs into the new run
- Duplicate log lines trash the log panel

## Stack

- **Remove:** `@heroui/react`, `@heroui/styles`, `framer-motion`
- **Add:** `shadcn/ui` components (installed via CLI), `sonner` (toasts), `lucide-react` (icons)
- **Keep:** React 19, Vite 8, Tailwind CSS v4, `vite-plugin-singlefile`
- **Theme:** `theme.md` (already shadcn-compatible CSS variables) copied into `index.css`
- **Fonts:** Inter (sans) + JetBrains Mono (mono) via Google Fonts

## Layout

### Top Bar
- Left: "HR Dashboard" title | divider | workflow dropdown (shadcn Select, 220px, shows name + count)
- Right: date nav (arrow buttons + date display, shadcn Popover + Calendar) | divider | Live pill (green dot + "Live") | clock (HH:MM:SS)
- No settings icon

### Queue Panel (left, 480px fixed)
- **Search:** shadcn Input with search icon
- **Stat pills:** 5 cards in a row (Total, Done, Active, Failed, Queue) — clickable as filters, active card highlighted
- **Entry list:** ScrollArea, newest first (reverse chronological by queue insertion time)
  - Each entry: name, ID/email (mono), status badge, current step (running), run number (if re-run), elapsed time (running) or duration (done), error preview (failed)
  - Selected entry: accent background + primary left border
  - No section grouping — badges distinguish status visually

### Log Panel (right, flex-1)
- **Header:** entry name (18px bold), status badge, email (mono, muted), run selector tabs (Run #1 X, Run #2)
- **Detail grid:** 4 columns (Employee, Email, Started, Elapsed) — fields vary per workflow
- **Step pipeline:** horizontal dots with connectors, completed steps show timing (e.g. "12s"), active step pulses
- **Log filter tabs:** All | Errors | Auth | Fill | Navigate | Extract
- **Log stream:** ScrollArea, mono font
  - Each line: timestamp | icon (lucide) | message | optional duplicate badge (x2, x3)
  - Current action highlighted with primary background tint
  - Hover shows "Copy" button (copies line text to clipboard)
- **Footer:** streaming dot + "Streaming" | entry count | collapsed count | auto-scroll toggle

### Toasts (sonner, bottom-right)
- **Pre-flight:** on dashboard startup — "Pre-flight checks passed: Dashboard connected, N old logs cleaned"
- **Completion:** "Jane Doe completed — Onboarding finished in 4m 12s"
- **Failure:** "Alice Wang failed — Timeout waiting for position number field"
- Auto-dismiss with progress bar (5s), closeable

### Empty States
- **No entries:** centered icon + "No entries yet — data will appear as workflows run"
- **No entry selected (right panel):** centered "Select an entry to view logs"
- **No logs:** "No logs recorded for this entry"

## Backend Changes

### Run Isolation

Add `runId` field to `TrackerEntry`:
```typescript
interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId: string;        // NEW: "{id}#{runNumber}" e.g. "jane@ucsd.edu#2"
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}
```

Add `runId` field to `LogEntry`:
```typescript
interface LogEntry {
  workflow: string;
  itemId: string;
  runId: string;        // NEW: matches TrackerEntry.runId
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}
```

`withTrackedWorkflow` computes run number by counting existing entries with the same `id` in today's JSONL file, then sets `runId = id + "#" + (count + 1)`.

### JSONL Write Locking

Wrap `appendFileSync` calls in `trackEvent` and `appendLogEntry` with a mutex (reuse the pattern from `src/tracker/locked.ts`) to prevent interleaved writes from parallel workers.

### 7-Day Retention

Add `cleanOldTrackerFiles(maxAgeDays: number = 7)` to `jsonl.ts`:
- Scans `.tracker/` directory
- Deletes JSONL files with dates older than `maxAgeDays` from filename
- Returns count of deleted files
- Called by dashboard on startup (pre-flight check)

### API Changes

Add new endpoint:
- `GET /api/runs?workflow=X&id=Y` — returns list of `{ runId, status, timestamp }` for an ID

Modify existing:
- `GET /api/logs` — add optional `runId` query param to filter by run
- `SSE /events/logs` — add optional `runId` query param
- `SSE /events` — entries already contain `runId`, no change needed

Add pre-flight endpoint:
- `GET /api/preflight` — runs checks (server alive, clean old logs), returns `{ checks: [{name, passed, detail}] }`

## Frontend Components

```
src/dashboard/
  index.html          # Dark mode HTML shell
  main.tsx            # React root
  index.css           # theme.md CSS variables + Tailwind imports
  App.tsx             # Shell: topbar + main split layout + SSE connection
  lib/utils.ts        # cn() helper for shadcn
  components/
    ui/               # shadcn components (installed via CLI)
    TopBar.tsx         # Title, workflow select, date nav, live indicator, clock
    QueuePanel.tsx     # Search, stat pills, entry list
    EntryItem.tsx      # Single queue entry (name, badge, step, time)
    LogPanel.tsx       # Header, detail grid, step pipeline, log stream, footer
    StepPipeline.tsx   # Horizontal step dots with timing
    LogStream.tsx      # Scrollable log lines with dedup + copy
    LogLine.tsx        # Single log entry (timestamp, icon, message, dup badge)
    StatPills.tsx      # 5-card stat row with filter
    RunSelector.tsx    # Tab group for switching between runs
    EmptyState.tsx     # Reusable empty state (icon + message)
    hooks/
      useSSE.ts        # Generic SSE hook (reconnects on error)
      useClock.ts      # HH:MM:SS clock, updates every second
      useEntries.ts    # SSE for entries + dedup + queue ordering
      useLogs.ts       # SSE for logs + dedup collapsing
      useElapsed.ts    # Live elapsed timer for running entries
      usePreflight.ts  # Fetch /api/preflight on mount
    types.ts           # TrackerEntry, LogEntry, WorkflowConfig, etc.
```

## Data Flow

```
Workflow (cli) → withTrackedWorkflow() → trackEvent() → .tracker/{wf}-{date}.jsonl
                                        → appendLogEntry() → .tracker/{wf}-{date}-logs.jsonl

Dashboard startup:
  1. Fetch /api/preflight → show toast with results
  2. Fetch /api/workflows → populate dropdown
  3. SSE /events?workflow=X → stream entries → dedupe by id (keep latest) → reverse chronological

User selects entry:
  4. Fetch /api/runs?workflow=X&id=Y → populate run selector tabs
  5. Fetch /api/logs?workflow=X&id=Y&runId=Z → initial log batch
  6. SSE /events/logs?workflow=X&id=Y&runId=Z → stream new logs → collapse duplicates client-side
```

## Log Deduplication (Client-Side)

When rendering logs, compare each consecutive line's message to the previous:
- If identical message: increment counter, show badge `x{count}` on the first occurrence, hide subsequent
- Reset counter when message changes
- Filter tabs apply before dedup grouping

## Queue Ordering

Entries are displayed in **reverse chronological** order — newest (most recently queued) at the top. This is the natural order for monitoring: you see what just started at the top, scroll down for history.

The sort key is `timestamp` from the first event for that ID (the `pending` event). On the frontend, after deduping by ID (keeping the latest status), sort by the timestamp of entry's first appearance descending.

## Step Pipelines Per Workflow

| Workflow | Steps |
|----------|-------|
| Onboarding | CRM Auth → Extraction → UCPath Auth → Person Search → Transaction |
| Separations | Launching → Authenticating → Kuali Extraction → Kronos Search → UCPath Job Summary → UCPath Transaction → Kuali Finalization |
| EID Lookup | UCPath Auth → Searching (→ CRM Auth → Cross-Verification) |
| Kronos Reports | Searching → Extracting → Downloading |
| Work Study | UCPath Auth → Transaction |

## Detail Grid Per Workflow

| Workflow | Field 1 | Field 2 | Field 3 | Field 4 |
|----------|---------|---------|---------|---------|
| Onboarding | Employee | Email | Started | Elapsed |
| Separations | Employee | Doc ID | Started | Elapsed |
| EID Lookup | Search Name | Empl ID | Started | Elapsed |
| Kronos Reports | Employee | ID | Started | Elapsed |
| Work Study | Employee | Empl ID | Started | Elapsed |

## Responsive Behavior

- **< 1024px:** Queue panel collapses to 320px min, log panel stays flex-1
- **< 768px:** Stack vertically — queue on top (40vh max), logs below. Log panel takes full width.
- **Mobile:** Entry list only, tap entry to navigate to full-screen log view (back button to return)

## Performance

- SSE polling: entries every 1s, logs every 500ms (same as current)
- Client-side dedup prevents React re-renders when data hasn't changed (compare JSON hash)
- ScrollArea with virtualization if entry count > 100 (use `@tanstack/react-virtual`)
- Log stream: virtualized for 1000+ lines
