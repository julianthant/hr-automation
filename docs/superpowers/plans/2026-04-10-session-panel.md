# Session Panel & Global Duo Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time session management panel to the dashboard and a cross-process global Duo MFA queue so concurrent workflows never collide on Duo prompts.

**Architecture:** JSONL event stream (`.tracker/sessions.jsonl`) is the single source of truth for session state and Duo queue coordination. Workflows append events, the SSE server rebuilds in-memory state from them, and the React dashboard subscribes via a new `/events/sessions` endpoint. The Duo queue is a file-based FIFO — processes poll the JSONL to determine turn order, with stale PID detection for crash recovery.

**Tech Stack:** TypeScript, Node.js (fs), React 19, Tailwind CSS v4, Lucide icons, SSE (EventSource)

**Design spec:** `docs/superpowers/specs/2026-04-10-session-panel-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/tracker/session-events.ts` | SessionEvent types, JSONL read/write, convenience emitters, instance name generation |
| `src/tracker/duo-queue.ts` | `requestDuoApproval()` wrapper, `waitForDuoTurn()`, `isProcessAlive()` stale detection |
| `src/dashboard/components/SessionPanel.tsx` | Container: renders SessionMain + DuoSidebar, auto-collapses when empty |
| `src/dashboard/components/WorkflowBox.tsx` | Single workflow instance: header (dot + name + current ID) + session boxes with BrowserChips |
| `src/dashboard/components/BrowserChip.tsx` | Single browser pill colored by auth state (idle/authenticating/authed/duo_waiting/failed) |
| `src/dashboard/components/DuoSidebar.tsx` | Duo queue vertical list with active/queued styling |
| `src/dashboard/components/hooks/useSessions.ts` | SSE subscription to `/events/sessions`, returns `SessionState` |

### Modified Files

| File | Change |
|------|--------|
| `src/tracker/dashboard.ts` | Add `/events/sessions` SSE endpoint, add sessions.jsonl preflight cleanup |
| `src/tracker/jsonl.ts` | Export `DEFAULT_DIR` constant, add `session` context to `withTrackedWorkflow` callback |
| `src/auth/login.ts` | Add optional `instance` param to all 5 login functions, swap `pollDuoApproval` → `requestDuoApproval` when `instance` provided |
| `src/dashboard/App.tsx` | Import SessionPanel, restructure right column to stack LogPanel + SessionPanel |
| `src/dashboard/components/EntryItem.tsx` | Add workflow instance tag pill to row 2 |
| `src/dashboard/components/types.ts` | Add `SessionState`, `WorkflowInstanceState`, `DuoQueueEntry`, `AuthState` types |

---

## Task 1: Session Event Types & JSONL Emission

**Files:**
- Create: `src/tracker/session-events.ts`
- Modify: `src/tracker/jsonl.ts` (export `DEFAULT_DIR`)

- [ ] **Step 1: Export DEFAULT_DIR from jsonl.ts**

In `src/tracker/jsonl.ts`, change line 10 from:

```typescript
const DEFAULT_DIR = ".tracker";
```

to:

```typescript
export const DEFAULT_DIR = ".tracker";
```

- [ ] **Step 2: Create session-events.ts**

Create `src/tracker/session-events.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_DIR } from "./jsonl.js";

// ── Types ──────────────────────────────────────────────

export type SessionEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete";

export interface SessionEvent {
  type: SessionEventType;
  timestamp: string;
  pid: number;
  workflowInstance: string;
  sessionId?: string;
  browserId?: string;
  system?: string;
  currentItemId?: string;
  duoRequestId?: string;
  data?: Record<string, string>;
}

// ── File path ──────────────────────────────────────────

const SESSIONS_FILE = "sessions.jsonl";

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return join(dir, SESSIONS_FILE);
}

// ── Read / Write ───────────────────────────────────────

export function emitSessionEvent(
  event: Omit<SessionEvent, "timestamp" | "pid">,
  dir: string = DEFAULT_DIR,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full: SessionEvent = {
    ...event,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
  appendFileSync(getSessionsFilePath(dir), JSON.stringify(full) + "\n");
}

export function readSessionEvents(dir: string = DEFAULT_DIR): SessionEvent[] {
  const path = getSessionsFilePath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

// ── Convenience helpers ────────────────────────────────

export function emitWorkflowStart(instance: string): void {
  emitSessionEvent({ type: "workflow_start", workflowInstance: instance });
}

export function emitWorkflowEnd(instance: string): void {
  emitSessionEvent({ type: "workflow_end", workflowInstance: instance });
}

export function emitSessionCreate(instance: string, sessionId: string): void {
  emitSessionEvent({ type: "session_create", workflowInstance: instance, sessionId });
}

export function emitSessionClose(instance: string, sessionId: string): void {
  emitSessionEvent({ type: "session_close", workflowInstance: instance, sessionId });
}

export function emitBrowserLaunch(
  instance: string, sessionId: string, browserId: string, system: string,
): void {
  emitSessionEvent({ type: "browser_launch", workflowInstance: instance, sessionId, browserId, system });
}

export function emitBrowserClose(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "browser_close", workflowInstance: instance, browserId, system });
}

export function emitAuthStart(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_start", workflowInstance: instance, browserId, system });
}

export function emitAuthComplete(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_complete", workflowInstance: instance, browserId, system });
}

export function emitAuthFailed(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_failed", workflowInstance: instance, browserId, system });
}

export function emitItemStart(instance: string, itemId: string): void {
  emitSessionEvent({ type: "item_start", workflowInstance: instance, currentItemId: itemId });
}

export function emitItemComplete(instance: string, itemId: string): void {
  emitSessionEvent({ type: "item_complete", workflowInstance: instance, currentItemId: itemId });
}

// ── Instance naming ────────────────────────────────────

/** Generate a unique instance name like "Separation 1", "Separation 2", etc. */
export function generateInstanceName(workflowType: string): string {
  // Map workflow key to display label
  const labels: Record<string, string> = {
    onboarding: "Onboarding",
    separations: "Separation",
    "eid-lookup": "EID Lookup",
    "kronos-reports": "Kronos",
    "work-study": "Work Study",
  };
  const label = labels[workflowType] || workflowType;

  const events = readSessionEvents();
  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const e of events) {
    if (e.type === "workflow_start") starts.add(e.workflowInstance);
    if (e.type === "workflow_end") ends.add(e.workflowInstance);
  }

  // Count active instances of this workflow type
  let n = 1;
  while (starts.has(`${label} ${n}`) && !ends.has(`${label} ${n}`)) {
    n++;
  }
  return `${label} ${n}`;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

Expected: No errors related to `session-events.ts`

- [ ] **Step 4: Commit**

```bash
git add src/tracker/session-events.ts src/tracker/jsonl.ts
git commit -m "feat(tracker): add session event types and JSONL emission API"
```

---

## Task 2: Global Duo Queue

**Files:**
- Create: `src/tracker/duo-queue.ts`

- [ ] **Step 1: Create duo-queue.ts**

Create `src/tracker/duo-queue.ts`:

```typescript
import type { Page } from "playwright";
import { pollDuoApproval, type DuoPollOptions } from "../auth/duo-poll.js";
import { emitSessionEvent, readSessionEvents } from "./session-events.js";
import { log } from "../utils/log.js";

/** Options for requestDuoApproval — extends DuoPollOptions with queue metadata. */
export interface DuoQueueOptions extends DuoPollOptions {
  system: string;     // "UCPath", "Kuali", "OldKronos", "NewKronos", "CRM"
  instance: string;   // "Separation 1", "Onboarding 2", etc.
}

/**
 * Request Duo MFA approval through the global FIFO queue.
 *
 * 1. Enqueue (duo_request)
 * 2. Wait for turn (poll sessions.jsonl until first unresolved)
 * 3. Signal active (duo_start)
 * 4. Call pollDuoApproval()
 * 5. Signal complete (duo_complete) — always, via try/finally
 *
 * If `instance` is not provided, falls back to direct pollDuoApproval (no queue).
 */
export async function requestDuoApproval(
  page: Page,
  options: DuoQueueOptions,
): Promise<boolean> {
  const requestId = `${options.instance}-${options.system}-${Date.now()}`;

  log.step(`[Duo Queue] Enqueuing: ${options.system} for ${options.instance}`);
  emitSessionEvent({
    type: "duo_request",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  await waitForDuoTurn(requestId, options.instance, options.system);

  log.step(`[Duo Queue] Active: ${options.system} for ${options.instance}`);
  emitSessionEvent({
    type: "duo_start",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  try {
    return await pollDuoApproval(page, options);
  } finally {
    log.step(`[Duo Queue] Complete: ${options.system} for ${options.instance}`);
    emitSessionEvent({
      type: "duo_complete",
      workflowInstance: options.instance,
      system: options.system,
      duoRequestId: requestId,
    });
  }
}

// ── Internal helpers ───────────────────────────────────

async function waitForDuoTurn(
  requestId: string,
  instance: string,
  system: string,
): Promise<void> {
  let logged = false;
  while (true) {
    const events = readSessionEvents();
    const duoEvents = events.filter(
      (e) => e.type === "duo_request" || e.type === "duo_complete" || e.type === "duo_timeout",
    );

    // Build set of resolved request IDs
    const resolved = new Set(
      duoEvents
        .filter((e) => e.type === "duo_complete" || e.type === "duo_timeout")
        .map((e) => e.duoRequestId),
    );

    // Find the first unresolved request
    const firstUnresolved = duoEvents
      .filter((e) => e.type === "duo_request" && !resolved.has(e.duoRequestId))
      .at(0);

    if (firstUnresolved?.duoRequestId === requestId) {
      return; // Our turn
    }

    // Stale detection: if the holder's process is dead, write timeout
    if (firstUnresolved && !isProcessAlive(firstUnresolved.pid)) {
      log.step(
        `[Duo Queue] Stale request detected (PID ${firstUnresolved.pid} dead) — advancing queue`,
      );
      emitSessionEvent({
        type: "duo_timeout",
        workflowInstance: firstUnresolved.workflowInstance ?? "",
        system: firstUnresolved.system ?? "",
        duoRequestId: firstUnresolved.duoRequestId ?? "",
      });
      continue; // Re-check immediately
    }

    if (!logged) {
      log.waiting(
        `[Duo Queue] Waiting — ${firstUnresolved?.system} (${firstUnresolved?.workflowInstance}) is using Duo`,
      );
      logged = true;
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence without killing
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

Expected: No errors related to `duo-queue.ts`

- [ ] **Step 3: Commit**

```bash
git add src/tracker/duo-queue.ts
git commit -m "feat(tracker): add global Duo FIFO queue with stale PID detection"
```

---

## Task 3: SSE Server — /events/sessions Endpoint

**Files:**
- Modify: `src/tracker/dashboard.ts`

- [ ] **Step 1: Add session state rebuilder and SSE endpoint**

In `src/tracker/dashboard.ts`, add the import at the top (after existing imports):

```typescript
import {
  readSessionEvents,
  getSessionsFilePath,
  type SessionEvent,
} from "./session-events.js";
```

Then add the following two blocks:

**Block 1** — Add the `rebuildSessionState` function **before** the `startDashboard` function:

```typescript
// ── Session state rebuilding from JSONL events ──────────

export interface BrowserState {
  browserId: string;
  system: string;
  authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  active: boolean;
  currentItemId: string | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}

function rebuildSessionState(): SessionState {
  const events = readSessionEvents();

  // Build workflow states
  const wfMap = new Map<string, WorkflowInstanceState>();
  for (const e of events) {
    const inst = e.workflowInstance;
    if (!inst) continue;

    if (e.type === "workflow_start") {
      wfMap.set(inst, { instance: inst, active: true, currentItemId: null, sessions: [] });
    }
    if (e.type === "workflow_end") {
      const wf = wfMap.get(inst);
      if (wf) wf.active = false;
    }
    if (e.type === "session_create" && e.sessionId) {
      const wf = wfMap.get(inst);
      if (wf && !wf.sessions.find((s) => s.sessionId === e.sessionId)) {
        wf.sessions.push({ sessionId: e.sessionId!, browsers: [] });
      }
    }
    if (e.type === "browser_launch" && e.sessionId && e.browserId && e.system) {
      const wf = wfMap.get(inst);
      const sess = wf?.sessions.find((s) => s.sessionId === e.sessionId);
      if (sess && !sess.browsers.find((b) => b.browserId === e.browserId)) {
        sess.browsers.push({ browserId: e.browserId!, system: e.system!, authState: "idle" });
      }
    }
    if (e.type === "browser_close" && e.browserId) {
      const wf = wfMap.get(inst);
      if (wf) {
        for (const sess of wf.sessions) {
          sess.browsers = sess.browsers.filter((b) => b.browserId !== e.browserId);
        }
      }
    }
    if (e.type === "auth_start" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authenticating";
    }
    if (e.type === "auth_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authed";
    }
    if (e.type === "auth_failed" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "failed";
    }
    if (e.type === "duo_request" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "duo_waiting";
    }
    if (e.type === "duo_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b && b.authState === "duo_waiting") b.authState = "authed";
    }
    if (e.type === "item_start" && e.currentItemId) {
      const wf = wfMap.get(inst);
      if (wf) wf.currentItemId = e.currentItemId!;
    }
    if (e.type === "item_complete") {
      const wf = wfMap.get(inst);
      if (wf) wf.currentItemId = null;
    }
  }

  // Build Duo queue (unresolved requests only)
  const resolved = new Set<string>();
  for (const e of events) {
    if ((e.type === "duo_complete" || e.type === "duo_timeout") && e.duoRequestId) {
      resolved.add(e.duoRequestId);
    }
  }
  const duoQueue: DuoQueueEntry[] = [];
  let pos = 1;
  for (const e of events) {
    if (e.type === "duo_request" && e.duoRequestId && !resolved.has(e.duoRequestId)) {
      // Check if there's a duo_start for this request (= active)
      const started = events.some(
        (s) => s.type === "duo_start" && s.duoRequestId === e.duoRequestId,
      );
      duoQueue.push({
        position: pos++,
        requestId: e.duoRequestId,
        system: e.system || "",
        instance: e.workflowInstance,
        state: started ? "active" : "waiting",
      });
    }
  }

  // Overlay duo_waiting state: if a browser's system has a pending Duo request
  // for the same workflow instance, show it as duo_waiting instead of authenticating
  const workflows = [...wfMap.values()];
  for (const wf of workflows) {
    for (const sess of wf.sessions) {
      for (const b of sess.browsers) {
        const hasPendingDuo = duoQueue.some(
          (d) => d.instance === wf.instance && d.system === b.system,
        );
        if (hasPendingDuo && (b.authState === "authenticating" || b.authState === "idle")) {
          b.authState = "duo_waiting";
        }
      }
    }
  }

  return { workflows, duoQueue };
}

function findBrowser(
  wfMap: Map<string, WorkflowInstanceState>,
  instance: string,
  browserId: string,
): BrowserState | undefined {
  const wf = wfMap.get(instance);
  if (!wf) return undefined;
  for (const sess of wf.sessions) {
    const b = sess.browsers.find((b) => b.browserId === browserId);
    if (b) return b;
  }
  return undefined;
}
```

**Block 2** — Add the `/events/sessions` SSE endpoint inside the `createServer` callback, **before** the existing `/events` block (around line 113). Insert it right after the `/events/logs` block:

```typescript
    if (url.pathname === "/events/sessions") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        const state = rebuildSessionState();
        res.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }
```

- [ ] **Step 2: Add sessions.jsonl cleanup to preflight**

In `src/tracker/dashboard.ts`, update the `/api/preflight` handler. Replace the existing preflight block with:

```typescript
    if (url.pathname === "/api/preflight") {
      const deleted = cleanOldTrackerFiles(7);

      // Clean stale sessions.jsonl if no active workflow processes
      let sessionsCleaned = false;
      const sessPath = getSessionsFilePath();
      if (existsSync(sessPath)) {
        const events = readSessionEvents();
        const activePids = new Set<number>();
        for (const e of events) {
          if (e.type === "workflow_start") activePids.add(e.pid);
          if (e.type === "workflow_end") activePids.delete(e.pid);
        }
        const anyAlive = [...activePids].some((pid) => {
          try { process.kill(pid, 0); return true; } catch { return false; }
        });
        if (!anyAlive) {
          unlinkSync(sessPath);
          sessionsCleaned = true;
        }
      }

      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 7 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
      ];
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ checks }));
      return;
    }
```

Add `unlinkSync` to the existing `fs` import at the top of the file:

```typescript
import { readFileSync, existsSync, unlinkSync } from "fs";
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "feat(dashboard): add /events/sessions SSE endpoint with session state rebuilder"
```

---

## Task 4: Frontend Types

**Files:**
- Modify: `src/dashboard/components/types.ts`

- [ ] **Step 1: Add session-related types**

At the bottom of `src/dashboard/components/types.ts`, add:

```typescript
// ── Session Panel Types ────────────────────────────────

export type AuthState = "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";

export interface BrowserState {
  browserId: string;
  system: string;
  authState: AuthState;
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  active: boolean;
  currentItemId: string | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/types.ts
git commit -m "feat(dashboard): add session panel frontend types"
```

---

## Task 5: useSessions Hook

**Files:**
- Create: `src/dashboard/components/hooks/useSessions.ts`

- [ ] **Step 1: Create the hook**

Create `src/dashboard/components/hooks/useSessions.ts`:

```typescript
import { useState, useEffect, useRef } from "react";
import type { SessionState } from "../types";

const EMPTY_STATE: SessionState = { workflows: [], duoQueue: [] };

export function useSessions(): { state: SessionState; connected: boolean } {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const prevHashRef = useRef<string>("");

  useEffect(() => {
    const es = new EventSource("/events/sessions");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const data: SessionState = JSON.parse(e.data);

        // Skip if unchanged
        const hash = JSON.stringify(data);
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;

        setState(data);
      } catch {
        // Ignore malformed
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { state, connected };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/hooks/useSessions.ts
git commit -m "feat(dashboard): add useSessions SSE hook"
```

---

## Task 6: BrowserChip Component

**Files:**
- Create: `src/dashboard/components/BrowserChip.tsx`

- [ ] **Step 1: Create BrowserChip**

Create `src/dashboard/components/BrowserChip.tsx`:

```typescript
import { cn } from "@/lib/utils";
import { Check, X, KeyRound, Loader2, Hourglass } from "lucide-react";
import type { AuthState } from "./types";

interface BrowserChipProps {
  system: string;
  authState: AuthState;
}

const chipStyles: Record<AuthState, string> = {
  idle: "bg-[#22222a] text-[#555] border-[#2a2a35]",
  authenticating: "bg-[#2563eb22] text-[#60a5fa] border-[#2563eb44]",
  authed: "bg-[#16a34a22] text-[#4ade80] border-[#16a34a33]",
  duo_waiting: "bg-[#eab30822] text-[#fbbf24] border-[#eab30833] animate-duo-glow",
  failed: "bg-[#ef444422] text-[#f87171] border-[#ef444444]",
};

const chipIcons: Record<AuthState, React.ReactNode> = {
  idle: <Hourglass className="w-3 h-3" />,
  authenticating: <Loader2 className="w-3 h-3 animate-spin" />,
  authed: <Check className="w-3 h-3" />,
  duo_waiting: <KeyRound className="w-3 h-3" />,
  failed: <X className="w-3 h-3" />,
};

export function BrowserChip({ system, authState }: BrowserChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border",
        chipStyles[authState],
      )}
    >
      {chipIcons[authState]}
      {system}
    </span>
  );
}
```

- [ ] **Step 2: Add the duo-glow animation to index.css**

In `src/dashboard/index.css`, add at the bottom (after the existing `@theme` block):

```css
@keyframes duo-glow {
  0%, 100% { box-shadow: 0 0 4px rgba(251, 191, 36, 0.2); }
  50% { box-shadow: 0 0 10px rgba(251, 191, 36, 0.5); }
}

.animate-duo-glow {
  animation: duo-glow 2s ease-in-out infinite;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/BrowserChip.tsx src/dashboard/index.css
git commit -m "feat(dashboard): add BrowserChip component with auth state visuals"
```

---

## Task 7: WorkflowBox Component

**Files:**
- Create: `src/dashboard/components/WorkflowBox.tsx`

- [ ] **Step 1: Create WorkflowBox**

Create `src/dashboard/components/WorkflowBox.tsx`:

```typescript
import { cn } from "@/lib/utils";
import { BrowserChip } from "./BrowserChip";
import type { WorkflowInstanceState } from "./types";

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}

export function WorkflowBox({ workflow }: WorkflowBoxProps) {
  const { instance, active, currentItemId, sessions } = workflow;

  return (
    <div
      className={cn(
        "flex-shrink-0 border-[1.5px] rounded-lg p-1.5 transition-opacity",
        active
          ? "border-[#7c3aed44] bg-[#7c3aed08]"
          : "border-[#7c3aed22] bg-[#7c3aed04] opacity-45",
      )}
    >
      {/* Header: dot + instance name + current item ID */}
      <div className="flex items-center gap-1 mb-1 px-0.5">
        <span
          className={cn(
            "w-[5px] h-[5px] rounded-full flex-shrink-0",
            active ? "bg-[#4ade80]" : "bg-[#444]",
          )}
        />
        <span className="text-[11px] font-semibold text-[#c4b5fd]">{instance}</span>
        <span className="flex-1" />
        {currentItemId ? (
          <span className="text-[10px] font-mono text-[#a78bfa] bg-[#7c3aed15] px-1.5 rounded">
            {currentItemId}
          </span>
        ) : !active ? (
          <span className="text-[10px] font-mono text-[#555] italic">waiting</span>
        ) : null}
      </div>

      {/* Session boxes */}
      <div className="flex gap-1">
        {sessions.map((sess) => (
          <div
            key={sess.sessionId}
            className="border-[1.5px] border-[#2563eb28] rounded-md p-1 bg-[#2563eb06]"
          >
            <div className="text-[9px] text-[#60a5fa] font-medium mb-1">{sess.sessionId}</div>
            <div className="flex gap-0.5 flex-wrap">
              {sess.browsers.map((b) => (
                <BrowserChip key={b.browserId} system={b.system} authState={b.authState} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/WorkflowBox.tsx
git commit -m "feat(dashboard): add WorkflowBox component for session visualization"
```

---

## Task 8: DuoSidebar Component

**Files:**
- Create: `src/dashboard/components/DuoSidebar.tsx`

- [ ] **Step 1: Create DuoSidebar**

Create `src/dashboard/components/DuoSidebar.tsx`:

```typescript
import { cn } from "@/lib/utils";
import { KeyRound } from "lucide-react";
import type { DuoQueueEntry } from "./types";

interface DuoSidebarProps {
  queue: DuoQueueEntry[];
}

export function DuoSidebar({ queue }: DuoSidebarProps) {
  const isEmpty = queue.length === 0;

  return (
    <div
      className={cn(
        "w-[150px] flex-shrink-0 border-l border-border p-2 overflow-y-auto",
        isEmpty ? "bg-card" : "bg-[#12121a]",
      )}
    >
      <div
        className={cn(
          "text-[10px] uppercase tracking-wider font-semibold mb-1.5 flex items-center gap-1",
          isEmpty ? "text-muted-foreground" : "text-[#fbbf24]",
        )}
      >
        <KeyRound className="w-3 h-3" />
        Duo Queue
      </div>

      {isEmpty ? (
        <div className="text-[11px] text-muted-foreground">No pending auth</div>
      ) : (
        <div className="flex flex-col gap-1">
          {queue.map((entry) => (
            <div
              key={entry.requestId}
              className={cn(
                "flex items-center gap-1.5 px-1.5 py-1 rounded",
                entry.state === "active" && "bg-[#eab30812]",
              )}
            >
              <span
                className={cn(
                  "text-[11px] font-semibold font-mono min-w-[14px]",
                  entry.state === "active" ? "text-[#fbbf24]" : "text-[#444]",
                )}
              >
                {entry.position}.
              </span>
              <div className="min-w-0">
                <div
                  className={cn(
                    "text-[11px] font-medium truncate",
                    entry.state === "active"
                      ? "text-[#fbbf24] animate-pulse"
                      : "text-[#555]",
                  )}
                >
                  {entry.system}
                </div>
                <div className="text-[9px] text-muted-foreground truncate">{entry.instance}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/DuoSidebar.tsx
git commit -m "feat(dashboard): add DuoSidebar component for Duo queue visualization"
```

---

## Task 9: SessionPanel Container

**Files:**
- Create: `src/dashboard/components/SessionPanel.tsx`

- [ ] **Step 1: Create SessionPanel**

Create `src/dashboard/components/SessionPanel.tsx`:

```typescript
import { Monitor } from "lucide-react";
import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";
import { DuoSidebar } from "./DuoSidebar";

export function SessionPanel() {
  const { state } = useSessions();

  // Auto-collapse when no workflows active
  if (state.workflows.length === 0 && state.duoQueue.length === 0) {
    return null;
  }

  return (
    <div className="h-[110px] flex-shrink-0 border-t border-border bg-card flex overflow-hidden">
      {/* Session main area — horizontal scroll */}
      <div className="flex-1 p-2 overflow-x-auto overflow-y-hidden min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
          <Monitor className="w-3 h-3 text-[#4ade80]" />
          Sessions
        </div>
        <div className="flex gap-2 items-start">
          {state.workflows.map((wf) => (
            <WorkflowBox key={wf.instance} workflow={wf} />
          ))}
        </div>
      </div>

      {/* Duo Queue sidebar */}
      <DuoSidebar queue={state.duoQueue} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/SessionPanel.tsx
git commit -m "feat(dashboard): add SessionPanel container with auto-collapse"
```

---

## Task 10: Dashboard Layout Integration

**Files:**
- Modify: `src/dashboard/App.tsx`
- Modify: `src/dashboard/components/EntryItem.tsx`

- [ ] **Step 1: Add SessionPanel to App.tsx layout**

In `src/dashboard/App.tsx`, add the import:

```typescript
import { SessionPanel } from "./components/SessionPanel";
```

Then replace the right-side `<LogPanel ... />` (line 131-134) with:

```typescript
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <LogPanel
            entry={selectedEntry}
            workflow={workflow}
            date={date}
          />
          <SessionPanel />
        </div>
```

The full `<div className="flex flex-1 overflow-hidden">` block should now be:

```typescript
      <div className="flex flex-1 overflow-hidden">
        <QueuePanel
          entries={entries}
          workflow={workflow}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loading}
        />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <LogPanel
            entry={selectedEntry}
            workflow={workflow}
            date={date}
          />
          <SessionPanel />
        </div>
      </div>
```

- [ ] **Step 2: Add instance tag to EntryItem.tsx**

In `src/dashboard/components/EntryItem.tsx`, modify the Row 2 section. Replace the current Row 2 block (lines 58-61):

```typescript
      {/* Row 2: Doc ID (only if name is shown, otherwise row 1 already shows ID) */}
      {name && (
        <div className="font-mono text-[13px] text-muted-foreground mt-0.5">{entry.id}</div>
      )}
```

With:

```typescript
      {/* Row 2: Doc ID + workflow instance tag */}
      {name && (
        <div className="flex items-center justify-between mt-0.5">
          <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>
          {entry.data?.instance && (
            <span className="text-[10px] px-1.5 py-px rounded bg-secondary text-muted-foreground font-medium flex-shrink-0 ml-2">
              {entry.data.instance}
            </span>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify the dashboard starts and renders without errors**

Run: `npm run dashboard`

Expected: Dashboard starts on port 3838 + 5173. Session panel is hidden (no active workflows). No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/App.tsx src/dashboard/components/EntryItem.tsx
git commit -m "feat(dashboard): integrate SessionPanel into layout, add instance tag to EntryItem"
```

---

## Task 11: withTrackedWorkflow Session Context

**Files:**
- Modify: `src/tracker/jsonl.ts`

- [ ] **Step 1: Add SessionContext type and extend withTrackedWorkflow callback**

In `src/tracker/jsonl.ts`, add the import at the top:

```typescript
import {
  generateInstanceName,
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitBrowserClose,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
  emitItemStart,
  emitItemComplete,
  type SessionEventType,
} from "./session-events.js";
```

Add the `SessionContext` interface before `withTrackedWorkflow`:

```typescript
/** Session context passed to workflow callbacks for registering sessions/browsers. */
export interface SessionContext {
  /** Auto-generated instance name, e.g. "Separation 1" */
  instance: string;
  registerSession(sessionId: string): void;
  registerBrowser(sessionId: string, browserId: string, system: string): void;
  closeBrowser(browserId: string, system: string): void;
  setAuthState(browserId: string, system: string, state: "start" | "complete" | "failed"): void;
  setCurrentItem(itemId: string): void;
  completeItem(itemId: string): void;
}
```

Then update the `withTrackedWorkflow` function signature to add `session` as the 4th callback parameter. Change the `fn` parameter type from:

```typescript
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, string>) => void,
    onCleanup: (cb: () => void) => void,
  ) => Promise<T>,
```

to:

```typescript
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, string>) => void,
    onCleanup: (cb: () => void) => void,
    session: SessionContext,
  ) => Promise<T>,
```

Inside the function body, after the `if (!preAssignedRunId) emit("pending");` line, add the session context setup:

```typescript
  // Session tracking context
  const instanceName = generateInstanceName(workflow);
  emitWorkflowStart(instanceName);
  // Store instance name in tracker data so EntryItem can show it
  data.instance = instanceName;

  const session: SessionContext = {
    instance: instanceName,
    registerSession: (sessionId) => emitSessionCreate(instanceName, sessionId),
    registerBrowser: (sessionId, browserId, system) => emitBrowserLaunch(instanceName, sessionId, browserId, system),
    closeBrowser: (browserId, system) => emitBrowserClose(instanceName, browserId, system),
    setAuthState: (browserId, system, state) => {
      if (state === "start") emitAuthStart(instanceName, browserId, system);
      else if (state === "complete") emitAuthComplete(instanceName, browserId, system);
      else emitAuthFailed(instanceName, browserId, system);
    },
    setCurrentItem: (itemId) => emitItemStart(instanceName, itemId),
    completeItem: (itemId) => emitItemComplete(instanceName, itemId),
  };
```

Add `emitWorkflowEnd` to the cleanup. In the `onSignal` handler (the SIGINT/SIGTERM handler), add before `const error = ...`:

```typescript
    emitWorkflowEnd(instanceName);
```

In the `try/catch/finally` block, add `emitWorkflowEnd` to both success and failure paths. After `emit("done");` add:

```typescript
    emitWorkflowEnd(instanceName);
```

And after `emit("failed", { error });` add:

```typescript
    emitWorkflowEnd(instanceName);
```

Update the `fn` call to pass `session`:

```typescript
    const result = await fn(
      (step) => emit("running", { step }),
      (d) => Object.assign(data, d),
      (cb) => cleanupFns.push(cb),
      session,
    );
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: Existing workflow files may show errors because they don't accept the 4th `session` parameter yet — that's expected and will be fixed in task 12. The `jsonl.ts` file itself should compile cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/tracker/jsonl.ts
git commit -m "feat(tracker): add SessionContext to withTrackedWorkflow callback"
```

---

## Task 12: Update Workflow Callbacks to Accept Session Parameter

All 5 workflows call `withTrackedWorkflow` and their callback functions need to accept the new 4th `session` parameter, even if they don't use it yet. This makes TypeScript happy.

**Files:**
- Modify: All workflow files that call `withTrackedWorkflow`

- [ ] **Step 1: Find all withTrackedWorkflow callsites**

Run: `grep -rn "withTrackedWorkflow" src/workflows/ --include="*.ts" -l`

For each file found, update the callback signature to accept `session` as the 4th parameter. The pattern is:

```typescript
// Before:
async (setStep, updateData, onCleanup) => {

// After:
async (setStep, updateData, onCleanup, session) => {
```

Do this for every file that calls `withTrackedWorkflow`. If the file destructures only `setStep` and `updateData` (no `onCleanup`), add both:

```typescript
// Before:
async (setStep, updateData) => {

// After:
async (setStep, updateData, onCleanup, session) => {
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/workflows/
git commit -m "refactor: accept session parameter in all workflow callbacks"
```

---

## Task 13: Auth Login Functions — requestDuoApproval Integration

**Files:**
- Modify: `src/auth/login.ts`

- [ ] **Step 1: Add import and optional instance parameter**

In `src/auth/login.ts`, add the import:

```typescript
import { requestDuoApproval } from "../tracker/duo-queue.js";
```

- [ ] **Step 2: Update loginToUCPath**

Add optional `instance` parameter to the function signature:

```typescript
export async function loginToUCPath(page: Page, instance?: string): Promise<boolean>
```

Replace the `pollDuoApproval` call with:

```typescript
const duoApproved = instance
  ? await requestDuoApproval(page, { ...duoOptions, system: "UCPath", instance })
  : await pollDuoApproval(page, duoOptions);
```

Where `duoOptions` is the existing options object that was passed to `pollDuoApproval`. Extract it to a variable if needed.

- [ ] **Step 3: Update loginToACTCrm**

Add optional `instance` parameter:

```typescript
export async function loginToACTCrm(page: Page, instance?: string): Promise<boolean>
```

Replace the `pollDuoApproval` call similarly:

```typescript
const duoApproved = instance
  ? await requestDuoApproval(page, { ...duoOptions, system: "CRM", instance })
  : await pollDuoApproval(page, duoOptions);
```

- [ ] **Step 4: Update ukgSubmitAndWaitForDuo**

Add optional `instance` parameter:

```typescript
export async function ukgSubmitAndWaitForDuo(page: Page, instance?: string): Promise<boolean>
```

Replace the `pollDuoApproval` call:

```typescript
const duoApproved = instance
  ? await requestDuoApproval(page, { ...duoOptions, system: "OldKronos", instance })
  : await pollDuoApproval(page, duoOptions);
```

- [ ] **Step 5: Update loginToKuali**

Add optional `instance` parameter:

```typescript
export async function loginToKuali(page: Page, url: string, instance?: string): Promise<boolean>
```

Replace the `pollDuoApproval` call:

```typescript
const duoApproved = instance
  ? await requestDuoApproval(page, { ...duoOptions, system: "Kuali", instance })
  : await pollDuoApproval(page, duoOptions);
```

- [ ] **Step 6: Update loginToNewKronos**

Add optional `instance` parameter:

```typescript
export async function loginToNewKronos(page: Page, instance?: string): Promise<boolean>
```

Replace the `pollDuoApproval` call:

```typescript
const duoApproved = instance
  ? await requestDuoApproval(page, { ...duoOptions, system: "NewKronos", instance })
  : await pollDuoApproval(page, duoOptions);
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

Expected: No errors. The `instance` param is optional so existing callers are unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/auth/login.ts
git commit -m "feat(auth): integrate requestDuoApproval into all 5 login functions"
```

---

## Task 14: Manual Integration Test

- [ ] **Step 1: Start the dashboard**

Run in one terminal: `npm run dashboard`

Verify both servers start (port 3838 + 5173). Open http://localhost:5173.

- [ ] **Step 2: Verify session panel is hidden when no workflows running**

The bottom strip should not be visible. The existing queue + log panel layout should be unchanged.

- [ ] **Step 3: Verify /events/sessions endpoint**

In a new terminal:

```bash
curl -N http://localhost:3838/events/sessions
```

Expected: SSE stream emitting `data: {"workflows":[],"duoQueue":[]}\n\n` every 1 second.

- [ ] **Step 4: Test session event emission manually**

In a new terminal, append a test event to `.tracker/sessions.jsonl`:

```bash
echo '{"type":"workflow_start","timestamp":"2026-04-10T14:00:00Z","pid":99999,"workflowInstance":"Test 1"}' >> .tracker/sessions.jsonl
echo '{"type":"session_create","timestamp":"2026-04-10T14:00:01Z","pid":99999,"workflowInstance":"Test 1","sessionId":"Session 1"}' >> .tracker/sessions.jsonl
echo '{"type":"browser_launch","timestamp":"2026-04-10T14:00:02Z","pid":99999,"workflowInstance":"Test 1","sessionId":"Session 1","browserId":"test-kuali","system":"Kuali"}' >> .tracker/sessions.jsonl
```

Expected: The session panel should appear in the dashboard showing "Test 1" with a "Kuali" browser chip in idle state.

- [ ] **Step 5: Clean up test data**

```bash
rm .tracker/sessions.jsonl
```

- [ ] **Step 6: Final commit with any fixes**

If any issues found during testing, fix and commit.
