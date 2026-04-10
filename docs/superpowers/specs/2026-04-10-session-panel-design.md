# Session Management Visualizer & Global Duo Queue

**Date:** 2026-04-10
**Status:** Design approved

## Overview

A real-time session management panel for the HR automation dashboard that visualizes the Workflow → Session → Browser hierarchy, tracks browser auth states, and coordinates Duo MFA globally across all concurrent workflow processes via a file-based FIFO queue.

## Goals

1. **Visualize** active workflows, their sessions, and browser auth states in real time
2. **Coordinate** Duo MFA sequentially across all workflow processes (prevent collisions)
3. **Track** browser lifecycle without hardcoded data — proper event-driven registration
4. **Integrate** with the existing dashboard without disrupting the current layout

## Non-Goals

- Persisting session history (sessions are ephemeral — only current state matters)
- Replacing the existing workflow tracker (session panel supplements it)
- Managing browser windows or tiling (that stays in `src/browser/tiling.ts`)

---

## 1. UI Design

### Layout

The session panel occupies the **bottom strip of the right column** (below the LogPanel). The QueuePanel continues to span the full vertical height on the left. The session strip is split into two zones:

```
┌──────────────────────┬────────────────────────────────────────────────┐
│                      │  LogPanel (flex-1)                             │
│   QueuePanel         │  ┌─ Header, StepPipeline, LogStream          │
│   (480px, full       │  └─ ...                                       │
│    height)           ├────────────────────────────────────┬───────────┤
│                      │  Session Panel (110px height)      │ Duo Queue │
│   Each entry shows:  │  ┌─ "Sessions" header              │ (150px)   │
│   Row 1: Name+Badge  │  ├─ Scrollable horizontal area     │ Scrollable│
│   Row 2: ID+Instance │  │  [Wf Box] [Wf Box] [Wf Box]... │ vertical  │
│     e.g.             │  └─                                │           │
│     "Separation 1"   │                                    │           │
└──────────────────────┴────────────────────────────────────┴───────────┘
```

- **Session main area**: flex-1, overflow-x scrollable, shows workflow instance boxes
- **Duo Queue sidebar**: 150px fixed width, border-left, overflow-y scrollable

### Queue Panel Changes

Each `EntryItem` gains a **workflow instance label** on row 2 (right-aligned), next to the ID:

```
┌─────────────────────────────────────┐
│ Smith, John                 running │  ← row 1: name + status badge
│ DOC-2024-001          Separation 1  │  ← row 2: id + instance tag
└─────────────────────────────────────┘
```

The instance tag is a small pill (`background: #2a2a40, color: #8888aa, font-size: 8px`). Instance names follow the pattern: `{WorkflowLabel} {N}` where N is the workflow instance number (e.g., "Separation 1", "Onboarding 2", "EID Lookup 1").

### Workflow Instance Box (Nested Container)

Each active workflow instance is a bordered container:

```
┌─ Workflow Box ──────────────────────────────────────┐
│ [●] Separation 1                     DOC-2024-001   │  ← header: dot + name + current ID
│ ┌─ Session 1 ──────────┐ ┌─ Session 2 ──────────┐  │
│ │ [✓ Kuali] [✓ OldK]   │ │ [✓ UC Txn] [✓ UC Job]│  │  ← browser chips per session
│ │ [🔑 NewK]            │ │                       │  │
│ └───────────────────────┘ └───────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- **Workflow header**: green dot (active) or gray (idle), instance name on the left, current item ID on the right (mono font, purple tint)
- **Session boxes**: nested inside workflow box, labeled "Session 1", "Session 2", etc.
- **Browser chips**: colored by state:
  - **Authed** (green): `✓ SystemName` — `background: #16a34a22, color: #4ade80, border: #16a34a33`
  - **Duo waiting** (amber, glowing): `🔑 SystemName` — `background: #eab30822, color: #fbbf24`, `box-shadow` animation
  - **Idle/waiting** (gray): `⏳ SystemName` — `background: #22222a, color: #555`
- **Dimmed state**: Inactive workflow instances rendered at `opacity: 0.45` with gray dot and "waiting" as the current ID

### Duo Queue Sidebar

A vertical list inside the 150px right sidebar of the session strip:

```
┌─ 🔑 Duo Queue ──────┐
│ 1. NewKronos         │  ← amber, pulsing (active)
│    Separation 1      │
│ 2. UCPath            │  ← gray (queued)
│    Separation 1      │
│ 3. UCPath            │  ← gray (queued)
│    EID Lookup 1      │
└──────────────────────┘
```

- Active item (position 1): amber text with pulse animation, `background: #eab30812`
- Queued items: gray text, no background
- Empty state: `"No pending auth"` in gray text, border color dimmed
- Each entry shows: position number, system name, source workflow instance

---

## 2. Backend: Session Event Stream

### Event File

All session and Duo events are appended to a single JSONL file:

```
.tracker/sessions.jsonl
```

This file is **ephemeral** — cleaned up by the dashboard's preflight check when no workflow processes are active. It is not date-partitioned because sessions don't persist across days.

### Event Schema

```typescript
interface SessionEvent {
  type: SessionEventType;
  timestamp: string;              // ISO 8601
  pid: number;                    // Process ID of the emitting workflow
  workflowInstance: string;       // "Separation 1", "Onboarding 2", etc.
  sessionId?: string;             // Unique per session (e.g., "sep1-s1")
  browserId?: string;             // Unique per browser (e.g., "sep1-s1-kuali")
  system?: string;                // "Kuali", "OldKronos", "NewKronos", "UCPath", "CRM"
  currentItemId?: string;         // "DOC-2024-001", "jsmith@ucsd.edu", etc.
  duoRequestId?: string;          // Unique ID for Duo queue entries
  data?: Record<string, string>;  // Optional extra metadata
}

type SessionEventType =
  // Workflow lifecycle
  | "workflow_start"       // New workflow instance begins
  | "workflow_end"         // Workflow instance completes or fails
  // Session lifecycle
  | "session_create"       // New browser session created
  | "session_close"        // Session closed
  // Browser lifecycle
  | "browser_launch"       // Browser window opened
  | "browser_close"        // Browser window closed
  // Auth state
  | "auth_start"           // Login flow begins for a browser
  | "auth_complete"        // Successfully authenticated
  | "auth_failed"          // Auth failed
  // Duo queue
  | "duo_request"          // Enqueued for Duo (waiting)
  | "duo_start"            // Duo prompt is now active (user's turn)
  | "duo_complete"         // Duo approved, lock released
  | "duo_timeout"          // Stale Duo request (process died)
  // Item tracking
  | "item_start"           // Started processing a new item
  | "item_complete";       // Finished processing item
```

### Event Emission API

New module: `src/tracker/session-events.ts`

```typescript
// Append a session event to the JSONL file
function emitSessionEvent(event: Omit<SessionEvent, "timestamp" | "pid">): void

// Convenience helpers (thin wrappers around emitSessionEvent)
function emitWorkflowStart(instance: string): void
function emitWorkflowEnd(instance: string): void
function emitSessionCreate(instance: string, sessionId: string): void
function emitBrowserLaunch(instance: string, sessionId: string, browserId: string, system: string): void
function emitAuthComplete(instance: string, browserId: string, system: string): void
function emitItemStart(instance: string, itemId: string): void
function emitItemComplete(instance: string, itemId: string): void
// ... etc.
```

All writes use `appendFileSync` (same pattern as the existing JSONL tracker) for concurrent safety.

### Instance Naming

Each workflow process generates its instance name on startup by reading existing events:

```typescript
function generateInstanceName(workflowType: string): string {
  // Read sessions.jsonl, count active instances of this workflow type
  // Return "Separation 1", "Separation 2", etc.
  // "Active" = has workflow_start but no workflow_end
}
```

This is called once at workflow startup inside `withTrackedWorkflow()`.

**Race condition note**: Two processes starting simultaneously could both read the file before either writes, producing duplicate names (e.g., two "Separation 1" instances). This is acceptable — instances are still distinguishable by PID in events. In practice, workflows are launched seconds apart (user types commands manually), making this extremely unlikely.

---

## 3. Backend: Global Duo FIFO Queue

### Design

A file-based FIFO queue using the same `sessions.jsonl` event stream. No external dependencies, no IPC, no coordination server required.

### Algorithm

The transparent wrapper `requestDuoApproval()` replaces direct `pollDuoApproval()` calls:

```typescript
async function requestDuoApproval(
  page: Page,
  options: DuoPollOptions & {
    system: string;           // "NewKronos", "UCPath", etc.
    instance: string;         // "Separation 1"
  }
): Promise<boolean> {
  const requestId = `${options.instance}-${options.system}-${Date.now()}`;

  // 1. Enqueue: append duo_request event
  emitSessionEvent({
    type: "duo_request",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  // 2. Wait for our turn: poll until this request is first unresolved
  await waitForDuoTurn(requestId);

  // 3. Signal active: append duo_start event
  emitSessionEvent({
    type: "duo_start",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  try {
    // 4. Actually poll Duo (existing function)
    return await pollDuoApproval(page, options);
  } finally {
    // 5. Always signal complete (release queue on success, failure, or crash)
    emitSessionEvent({
      type: "duo_complete",
      workflowInstance: options.instance,
      system: options.system,
      duoRequestId: requestId,
    });
  }
}
```

### Queue Position Check

```typescript
async function waitForDuoTurn(requestId: string): Promise<void> {
  while (true) {
    const events = readSessionEvents(); // Read sessions.jsonl
    const duoEvents = events.filter(e =>
      e.type === "duo_request" || e.type === "duo_complete" || e.type === "duo_timeout"
    );

    // Build set of completed/timed-out request IDs
    const resolved = new Set(
      duoEvents
        .filter(e => e.type === "duo_complete" || e.type === "duo_timeout")
        .map(e => e.duoRequestId)
    );

    // Find the first unresolved request
    const firstUnresolved = duoEvents
      .filter(e => e.type === "duo_request" && !resolved.has(e.duoRequestId))
      .at(0);

    if (firstUnresolved?.duoRequestId === requestId) {
      return; // It's our turn
    }

    // Stale detection: if the first unresolved request's PID is dead, timeout it
    if (firstUnresolved && !isProcessAlive(firstUnresolved.pid)) {
      emitSessionEvent({
        type: "duo_timeout",
        workflowInstance: firstUnresolved.workflowInstance,
        system: firstUnresolved.system,
        duoRequestId: firstUnresolved.duoRequestId,
      });
      continue; // Re-check immediately
    }

    await sleep(500); // Poll every 500ms
  }
}
```

### Stale Detection

```typescript
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence, don't kill
    return true;
  } catch {
    return false; // Process doesn't exist
  }
}
```

If the active Duo holder crashes (browser crash, Ctrl+C without cleanup, etc.), the next process in queue detects the dead PID within 500ms and writes a `duo_timeout` event, advancing the queue.

---

## 4. Backend: SSE Server Changes

### New Endpoint

Add to `src/tracker/dashboard.ts`:

```
GET /events/sessions — SSE stream of current session state
```

### State Rebuilding

The SSE server maintains an in-memory view of current session state, rebuilt from `sessions.jsonl`:

```typescript
interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}

interface WorkflowInstanceState {
  instance: string;           // "Separation 1"
  active: boolean;            // has workflow_start but no workflow_end
  currentItemId: string | null;
  sessions: {
    sessionId: string;
    browsers: {
      browserId: string;
      system: string;
      authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
    }[];
  }[];
}

interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active" | "completed" | "timeout";
}
```

On each SSE tick (1s poll):
1. Read new lines from `sessions.jsonl` since last read
2. Apply events to in-memory state (fold new events into existing state)
3. Serialize `SessionState` and send via SSE

### Preflight Cleanup

Add to the existing `/api/preflight` check:
- If `sessions.jsonl` exists and no PIDs from any `workflow_start` event (without matching `workflow_end`) are alive, delete the file
- This prevents stale state from a previous run showing up on dashboard startup

---

## 5. Frontend: New Components

### SessionPanel.tsx

Container component for the bottom strip. Renders inside the right column below LogPanel.

```typescript
// Props
interface SessionPanelProps {
  // No props needed — subscribes to SSE directly
}
```

- Subscribes to `/events/sessions` SSE via a new `useSessions()` hook
- Renders `SessionMain` (scrollable workflow boxes) and `DuoSidebar` (queue list)
- Height: 110px fixed, with `border-top: 1px solid` separator from LogPanel
- **Auto-collapse**: When no workflows are active (empty `workflows` array), the entire strip is hidden (`display: none`). It appears automatically when the first `workflow_start` event arrives.

### useSessions() Hook

New hook in `src/dashboard/components/hooks/useSessions.ts`:

- Subscribes to `/events/sessions` SSE endpoint
- Returns `SessionState` (workflows array + duoQueue array)
- Returns `connected` boolean
- Handles reconnection on SSE drop (same pattern as `useEntries`)

### SessionMain Sub-component

Scrollable horizontal area with workflow instance boxes:

```typescript
interface SessionMainProps {
  workflows: WorkflowInstanceState[];
}
```

- Maps each workflow to a `WorkflowBox` component
- `overflow-x: auto` for horizontal scrolling when many instances active
- Inactive instances rendered at reduced opacity

### WorkflowBox Sub-component

```typescript
interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}
```

- Outer border: `1.5px solid #7c3aed44`, border-radius 8px
- Header row: active dot + instance name + current ID (right-aligned, mono font)
- Session boxes inside: border `1.5px solid #2563eb28`, border-radius 6px
- Browser chips inside sessions: colored by `authState`

### BrowserChip Sub-component

```typescript
interface BrowserChipProps {
  system: string;
  authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
}
```

State → visual mapping:
| State | Icon | Color | Border | Animation |
|-------|------|-------|--------|-----------|
| idle | ⏳ | #555 | #2a2a35 | none |
| authenticating | ⟳ | #60a5fa | #2563eb44 | spin |
| authed | ✓ | #4ade80 | #16a34a33 | none |
| duo_waiting | 🔑 | #fbbf24 | #eab30833 | glow pulse |
| failed | ✗ | #f87171 | #ef444444 | none |

### DuoSidebar Sub-component

```typescript
interface DuoSidebarProps {
  queue: DuoQueueEntry[];
}
```

- Fixed 150px width, `border-left: 1px solid`, `overflow-y: auto`
- Header: "🔑 Duo Queue" in amber
- Active entry (position 1): amber text, pulse animation, light background
- Queued entries: gray text
- Empty state: "No pending auth" in dim gray, border color dimmed

---

## 6. Workflow Integration Points

### Wrapper: withTrackedWorkflow Changes

`withTrackedWorkflow()` gains session awareness:

```typescript
// Before
await withTrackedWorkflow("separations", docId, {}, async (setStep, updateData, onCleanup) => {
  // ...
});

// After — instance name auto-generated, session events emitted automatically
await withTrackedWorkflow("separations", docId, {}, async (setStep, updateData, onCleanup, session) => {
  // session.instance = "Separation 1" (auto-generated)
  // session.registerSession(sessionId) — call when creating a session
  // session.registerBrowser(sessionId, browserId, system) — call when launching a browser
  // session.setAuthState(browserId, state) — call on auth state changes
  // session.setCurrentItem(itemId) — call when starting a new item
  // Emits workflow_start on entry, workflow_end on exit (success or failure)
});
```

### Auth Functions: requestDuoApproval Integration

Replace `pollDuoApproval()` calls with `requestDuoApproval()` in all login functions:

```typescript
// src/auth/login.ts — loginToUCPath
// Before:
await pollDuoApproval(page, { successUrlMatch: "..." });

// After:
await requestDuoApproval(page, {
  successUrlMatch: "...",
  system: "UCPath",
  instance: currentInstance, // passed from workflow context
});
```

The `instance` parameter comes from the workflow context (passed through to auth functions). Each login function in `src/auth/login.ts` gains an optional `instance` parameter. When omitted (standalone usage), Duo falls back to the existing `pollDuoApproval()` without queuing.

### Per-Workflow Session Registration

Each workflow registers its sessions and browsers after launching them:

**Separations** (4 browsers, 2 sessions):
```
Session 1: Kuali, OldKronos, NewKronos  (shared context — non-UCPath systems)
Session 2: UCPath Txn, UCPath Job       (separate context — UCPath can't share)
```

**Onboarding** (2 browsers per worker, 2 sessions each):
```
Session 1: CRM
Session 2: UCPath
```

**EID Lookup** (1-2 browsers, 1-2 sessions):
```
Session 1: UCPath
Session 2: CRM (optional, if cross-verification mode)
```

**Kronos Reports** (N browsers, 1 session with persistent cookies):
```
Session 1: W1, W2, W3, W4 (all share UKG persistent session)
```

**Work Study** (1 browser, 1 session):
```
Session 1: UCPath
```

### Session Rule Enforcement

The rule "UCPath browsers can't share sessions with non-UCPath browsers" is enforced by convention in workflow code (already the case today). The session panel simply reflects what workflows register. The `SessionRegistry` does not enforce rules — it's a passive observer.

---

## 7. File Structure

### New Files

```
src/tracker/
  session-events.ts        # Event emission API + JSONL read/write
  duo-queue.ts             # requestDuoApproval(), waitForDuoTurn(), stale detection

src/dashboard/components/
  SessionPanel.tsx          # Container: SessionMain + DuoSidebar
  WorkflowBox.tsx           # Single workflow instance visualization
  BrowserChip.tsx           # Single browser state chip
  DuoSidebar.tsx            # Duo queue vertical list
  hooks/
    useSessions.ts          # SSE subscription for /events/sessions
```

### Modified Files

```
src/tracker/dashboard.ts    # Add /events/sessions SSE endpoint + preflight cleanup
src/tracker/jsonl.ts        # Add session context to withTrackedWorkflow
src/auth/login.ts           # Replace pollDuoApproval → requestDuoApproval in all 5 login fns
src/auth/duo-poll.ts        # No changes (requestDuoApproval wraps it)
src/dashboard/App.tsx       # Add SessionPanel to right-column layout
src/dashboard/components/
  LogPanel.tsx              # Adjust flex to accommodate SessionPanel below
  EntryItem.tsx             # Add instance tag to row 2
  types.ts                  # Add session-related types
```

---

## 8. Data Flow

```
Workflow Process(es)                    Dashboard Process
┌────────────────────┐                  ┌──────────────────────┐
│ withTrackedWorkflow │                  │ SSE Server (3838)    │
│  ├─ emitSessionEvent ──(append)──→ .tracker/sessions.jsonl   │
│  │   workflow_start  │                 │  ├─ poll 1s          │
│  │   session_create  │                 │  ├─ rebuild state    │
│  │   browser_launch  │                 │  └─ stream via SSE   │
│  │   auth_complete   │                 │                      │
│  │   item_start      │                 │ GET /events/sessions │
│  │                   │                 └──────────┬───────────┘
│  ├─ requestDuoApproval                            │
│  │   ├─ duo_request ──(append)──→ sessions.jsonl  │
│  │   ├─ poll for turn (read)                      │
│  │   ├─ duo_start ────(append)──→ sessions.jsonl  │
│  │   ├─ pollDuoApproval()                         │
│  │   └─ duo_complete ─(append)──→ sessions.jsonl  │
│  │                   │                            │
│  └─ workflow_end     │               React Dashboard (5173)
└────────────────────┘               ┌──────────────────────┐
                                     │ useSessions() hook   │
                                     │  ├─ SSE subscribe    │
                                     │  └─ render:          │
                                     │     SessionPanel     │
                                     │      ├─ WorkflowBox  │
                                     │      │  └─ BrowserChip│
                                     │      └─ DuoSidebar   │
                                     └──────────────────────┘
```

---

## 9. Edge Cases

### Process crash mid-Duo
- `duo_complete` never written
- Next process in queue detects dead PID via `isProcessAlive()` within 500ms
- Writes `duo_timeout` event, queue advances

### Dashboard restart mid-workflow
- SSE server re-reads `sessions.jsonl` from disk
- Rebuilds full state from events
- Dashboard reconnects and shows current state immediately

### No dashboard running
- Workflows still coordinate Duo via `sessions.jsonl` — file-based queue works without the SSE server
- Session events still written (just not consumed until dashboard starts)

### All workflows finish
- Dashboard preflight cleans up `sessions.jsonl`
- Session panel shows empty state

### Browser closes unexpectedly
- Workflow catch block emits `browser_close` event
- SIGINT handler (existing) emits `workflow_end` event synchronously before exit
- Chip changes from authed/duo to "failed" state

### Concurrent batch + single workflow
- Instance naming handles it: "Separation 1" (batch of 3 docs) + "EID Lookup 1" (single name lookup)
- Queue entries show items from both workflows
- Duo sidebar shows the global ordering across both

### Standalone workflow usage (no dashboard, no session tracking)
- If `instance` parameter is omitted from `requestDuoApproval()`, it falls back to direct `pollDuoApproval()` — no file reads/writes, no queue coordination
- This preserves backward compatibility: `npm run test-login` and other standalone scripts work unchanged
- Session events are only emitted when workflows explicitly opt in via `withTrackedWorkflow()`
