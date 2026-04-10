# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the HR Dashboard frontend from HeroUI to shadcn/ui with a split-panel layout (queue + log stream), and add backend support for run isolation, JSONL locking, 7-day retention, and pre-flight checks.

**Architecture:** Split-panel React SPA. Left panel shows a queue of workflow entries (newest first, filterable by status). Right panel shows live log stream for the selected entry with run isolation, step pipeline, and log-level filtering. Backend is a Node HTTP server serving SSE + REST from `.tracker/` JSONL files. Toasts via sonner for pre-flight, completions, and failures.

**Tech Stack:** React 19, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui, lucide-react, sonner, `vite-plugin-singlefile`

**Spec:** `docs/superpowers/specs/2026-04-10-dashboard-redesign.md`
**Component guide:** `src/dashboard/CLAUDE.md`

---

### Task 1: Install Dependencies & Configure shadcn

**Files:**
- Modify: `package.json`
- Create: `src/dashboard/components.json`
- Create: `src/dashboard/lib/utils.ts`
- Modify: `src/dashboard/index.css`
- Modify: `src/dashboard/index.html`
- Modify: `vite.dashboard.config.ts`

- [ ] **Step 1: Install new dependencies**

```bash
npm install lucide-react sonner clsx tailwind-merge class-variance-authority
```

- [ ] **Step 2: Create the shadcn `cn()` utility**

Create `src/dashboard/lib/utils.ts`:

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Replace `index.css` with theme from `theme.md`**

Replace the contents of `src/dashboard/index.css`. Copy the full contents of `theme.md` (the root-level file), then remove the `@import "@heroui/styles";` line. The file should start with:

```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --background: hsl(30 28.5714% 97.2549%);
  /* ... rest of theme.md light mode vars ... */
}

.dark {
  --background: hsl(15 20.0000% 3.9216%);
  /* ... rest of theme.md dark mode vars ... */
}

@theme inline {
  /* ... rest of theme.md @theme block ... */
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

This is the entire `theme.md` file verbatim, minus `@import "@heroui/styles"` (which was never in theme.md anyway — it was in the old index.css).

- [ ] **Step 4: Update `index.html` — add Google Fonts + title**

Replace `src/dashboard/index.html`:

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HR Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body class="min-h-screen bg-background text-foreground dark">
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: Add path alias to vite config**

Modify `vite.dashboard.config.ts` — add `resolve.alias` so shadcn components can use `@/` imports:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "path";

export default defineConfig({
  root: "src/dashboard",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/dashboard"),
    },
  },
  build: {
    outDir: "../../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3838",
      "/events": "http://localhost:3838",
    },
  },
});
```

- [ ] **Step 6: Verify Vite dev server starts**

```bash
npx vite --config vite.dashboard.config.ts
```

Expected: Dev server starts on port 5173 without errors. Page may be blank (old components will break without HeroUI — that's fine).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/dashboard/lib/utils.ts src/dashboard/index.css src/dashboard/index.html vite.dashboard.config.ts
git commit -m "feat(dashboard): install shadcn deps, add theme, configure aliases"
```

---

### Task 2: Backend — Run Isolation & JSONL Locking

**Files:**
- Modify: `src/tracker/jsonl.ts`

- [ ] **Step 1: Add `runId` to TrackerEntry and LogEntry types**

In `src/tracker/jsonl.ts`, add `runId` field to both interfaces:

```typescript
export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;         // "{itemId}#{runNumber}" — isolates re-runs
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;         // "{id}#{runNumber}" — isolates re-runs
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}
```

Make `runId` optional (`?`) so existing JSONL data without it doesn't break.

- [ ] **Step 2: Add mutex locking to trackEvent and appendLogEntry**

Import `Mutex` from `async-mutex` (already a project dependency). Create a single file-level mutex and wrap both append functions:

```typescript
import { Mutex } from "async-mutex";

const writeMutex = new Mutex();

export function trackEvent(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  // Mutex protects against interleaved writes from parallel workers
  writeMutex.runExclusive(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logPath = getLogPath(entry.workflow, dir);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  });
}

export function appendLogEntry(entry: LogEntry, dir: string = DEFAULT_DIR): void {
  writeMutex.runExclusive(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logPath = getLogFilePath(entry.workflow, dir);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  });
}
```

Note: `writeMutex.runExclusive` is synchronous-safe here since `appendFileSync` is sync. The mutex serializes concurrent calls from parallel workers in the same process.

- [ ] **Step 3: Compute runId in withTrackedWorkflow**

Modify `withTrackedWorkflow` to auto-compute run number:

```typescript
export async function withTrackedWorkflow<T>(
  workflow: string,
  id: string,
  initialData: Record<string, string>,
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, string>) => void,
  ) => Promise<T>,
): Promise<T> {
  const data = { ...initialData };
  const ts = () => new Date().toISOString();

  // Compute run number: count existing entries with same id, then +1
  const existing = readEntries(workflow);
  const priorRuns = new Set(
    existing.filter((e) => e.id === id).map((e) => e.runId)
  );
  const runNumber = priorRuns.size + 1;
  const runId = `${id}#${runNumber}`;

  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    trackEvent({ workflow, timestamp: ts(), id, runId, status, data, ...extra });
  };

  emit("pending");
  try {
    const result = await fn(
      (step) => emit("running", { step }),
      (d) => Object.assign(data, d),
    );
    emit("done");
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit("failed", { error });
    throw e;
  }
}
```

- [ ] **Step 4: Add cleanOldTrackerFiles function**

Add at the end of `src/tracker/jsonl.ts`:

```typescript
/** Delete JSONL files older than maxAgeDays. Returns count of deleted files. */
export function cleanOldTrackerFiles(maxAgeDays: number = 7, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const match = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (match && match[1] < cutoffStr) {
      unlinkSync(join(dir, f));
      deleted++;
    }
  }
  return deleted;
}
```

Add `unlinkSync` to the import from `"fs"` at the top of the file.

- [ ] **Step 5: Add readRunsForId function**

Add at the end of `src/tracker/jsonl.ts`:

```typescript
/** List distinct runs for a given ID, with their latest status and timestamp. */
export function readRunsForId(
  workflow: string,
  id: string,
  dir: string = DEFAULT_DIR,
): { runId: string; status: string; timestamp: string }[] {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id);
  const runMap = new Map<string, TrackerEntry>();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    runMap.set(rid, e); // keeps latest
  }
  return [...runMap.values()]
    .map((e) => ({ runId: e.runId || `${e.id}#1`, status: e.status, timestamp: e.timestamp }))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/jsonl.ts
git commit -m "feat(tracker): add runId isolation, JSONL write locking, 7-day retention"
```

---

### Task 3: Backend — New API Endpoints

**Files:**
- Modify: `src/tracker/dashboard.ts`

- [ ] **Step 1: Add /api/runs endpoint**

In `src/tracker/dashboard.ts`, add import for `readRunsForId` and `cleanOldTrackerFiles`, then add the handler before the catch-all 404:

```typescript
import {
  readEntries,
  readLogEntries,
  listWorkflows,
  listDatesForWorkflow,
  readEntriesForDate,
  readLogEntriesForDate,
  readRunsForId,
  cleanOldTrackerFiles,
} from "./jsonl.js";
```

Add this block inside the `createServer` callback, before the 404 handler:

```typescript
    if (url.pathname === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readRunsForId(wf, id)));
      return;
    }

    if (url.pathname === "/api/preflight") {
      const deleted = cleanOldTrackerFiles(7);
      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 7 days)` },
      ];
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ checks }));
      return;
    }
```

- [ ] **Step 2: Add runId filtering to /api/logs**

Modify the existing `/api/logs` handler to accept `runId`:

```typescript
    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      let logs = readLogEntries(wf, id || undefined);
      if (runId) logs = logs.filter((l) => l.runId === runId);
      res.end(JSON.stringify(logs));
      return;
    }
```

- [ ] **Step 3: Add runId filtering to /events/logs SSE**

Modify the existing `/events/logs` handler:

```typescript
    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let lastCount = 0;
      const send = () => {
        let entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date)
          : readLogEntries(wf, id || undefined);
        if (runId) entries = entries.filter((l) => l.runId === runId);
        if (entries.length > lastCount) {
          res.write(`data: ${JSON.stringify(entries.slice(lastCount))}\n\n`);
          lastCount = entries.length;
        }
      };
      send();
      const interval = setInterval(send, 500);
      req.on("close", () => clearInterval(interval));
      return;
    }
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: No errors related to the tracker changes.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "feat(dashboard): add /api/runs, /api/preflight endpoints, runId filtering"
```

---

### Task 4: Frontend Types & Workflow Config

**Files:**
- Create: `src/dashboard/components/types.ts` (rewrite from scratch)

- [ ] **Step 1: Write the new types.ts**

Delete existing content and write:

```typescript
export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

export interface RunInfo {
  runId: string;
  status: string;
  timestamp: string;
}

export interface WorkflowConfig {
  label: string;
  steps: string[];
  detailFields: { key: string; label: string }[];
  getName: (r: TrackerEntry) => string;
  getId: (r: TrackerEntry) => string;
}

export const WF_CONFIG: Record<string, WorkflowConfig> = {
  onboarding: {
    label: "Onboarding",
    steps: ["crm-auth", "extraction", "ucpath-auth", "person-search", "transaction"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "email", label: "Email" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => [r.data?.firstName, r.data?.lastName].filter(Boolean).join(" "),
    getId: (r) => r.id,
  },
  separations: {
    label: "Separations",
    steps: ["launching", "authenticating", "kuali-extraction", "kronos-search", "ucpath-job-summary", "ucpath-transaction", "kuali-finalization"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "docId", label: "Doc ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || r.data?.employeeName || "",
    getId: (r) => r.id,
  },
  "kronos-reports": {
    label: "Kronos Reports",
    steps: ["searching", "extracting", "downloading"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "id", label: "ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
  "eid-lookup": {
    label: "EID Lookup",
    steps: ["ucpath-auth", "searching", "crm-auth", "cross-verification"],
    detailFields: [
      { key: "searchName", label: "Search Name" },
      { key: "emplId", label: "Empl ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
  "work-study": {
    label: "Work Study",
    steps: ["ucpath-auth", "transaction"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "emplId", label: "Empl ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
};

export const TAB_ORDER = ["onboarding", "separations", "kronos-reports", "eid-lookup", "work-study"];

export function getConfig(wf: string): WorkflowConfig {
  if (WF_CONFIG[wf]) return WF_CONFIG[wf];
  return {
    label: wf.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    steps: [],
    detailFields: [
      { key: "id", label: "ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: () => "",
    getId: (r) => r.id,
  };
}

/** Step name to display label */
export function formatStepName(step: string): string {
  return step
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Determine log action category from message content */
export type LogCategory = "fill" | "navigate" | "extract" | "search" | "select" | "auth" | "download" | "success" | "error" | "waiting" | "step";

export function getLogCategory(level: string, message: string): LogCategory {
  if (level === "success") return "success";
  if (level === "error") return "error";
  if (level === "waiting") return "waiting";
  const msg = (message || "").toLowerCase();
  if (msg.includes("fill") || msg.includes("comp rate") || msg.includes("compensation")) return "fill";
  if (msg.includes("click") || msg.includes("navigat")) return "navigate";
  if (msg.includes("crm field") || msg.includes("extract") || msg.includes("matched label")) return "extract";
  if (msg.includes("search") || msg.includes("found") || msg.includes("result") || msg.includes("person search")) return "search";
  if (msg.includes("select") || msg.includes("dropdown") || msg.includes("template") || msg.includes("reason")) return "select";
  if (msg.includes("sso") || msg.includes("duo") || msg.includes("auth") || msg.includes("credential") || msg.includes("login")) return "auth";
  if (msg.includes("download") || msg.includes("pdf") || msg.includes("report")) return "download";
  return "step";
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/types.ts
git commit -m "feat(dashboard): rewrite types.ts with runId, step configs, log categories"
```

---

### Task 5: Frontend Hooks

**Files:**
- Create: `src/dashboard/components/hooks/useClock.ts`
- Create: `src/dashboard/components/hooks/useElapsed.ts`
- Create: `src/dashboard/components/hooks/useEntries.ts`
- Create: `src/dashboard/components/hooks/useLogs.ts`
- Create: `src/dashboard/components/hooks/usePreflight.ts`

- [ ] **Step 1: Create hooks directory and useClock**

Create `src/dashboard/components/hooks/useClock.ts`:

```typescript
import { useState, useEffect } from "react";

export function useClock(): string {
  const fmt = () =>
    new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const [time, setTime] = useState(fmt);

  useEffect(() => {
    const id = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  return time;
}
```

- [ ] **Step 2: Create useElapsed**

Create `src/dashboard/components/hooks/useElapsed.ts`:

```typescript
import { useState, useEffect } from "react";

/** Returns a live "Xm Ys" string that counts up from startTime. */
export function useElapsed(startTime: string | null): string {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!startTime) {
      setElapsed("");
      return;
    }
    const start = new Date(startTime).getTime();
    const update = () => {
      const diff = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(`${m}m ${s.toString().padStart(2, "0")}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  return elapsed;
}

/** Format a duration in seconds to "Xm Ys" (static, no hook). */
export function formatDuration(startIso: string, endIso: string): string {
  const diff = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
```

- [ ] **Step 3: Create useEntries**

Create `src/dashboard/components/hooks/useEntries.ts`:

```typescript
import { useState, useEffect, useRef } from "react";
import type { TrackerEntry } from "../types";

interface UseEntriesResult {
  entries: TrackerEntry[];
  workflows: string[];
  connected: boolean;
  loading: boolean;
}

/**
 * SSE hook for workflow entries.
 * Dedupes by ID (keeps latest), sorts newest-first by first-seen timestamp.
 */
export function useEntries(workflow: string, date: string): UseEntriesResult {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const prevHashRef = useRef("");

  useEffect(() => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    let sseUrl = "/events?workflow=" + encodeURIComponent(workflow);
    if (date && date !== today) {
      sseUrl += "&date=" + encodeURIComponent(date);
    }

    const es = new EventSource(sseUrl);

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const { entries: raw, workflows: wfs }: { entries: TrackerEntry[]; workflows: string[] } = JSON.parse(e.data);

        // Skip if data hasn't changed (prevent unnecessary re-renders)
        const hash = JSON.stringify(raw.map((r) => `${r.id}:${r.status}:${r.step}:${r.timestamp}`));
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;

        // Dedupe by ID, keep latest entry
        const latest = new Map<string, TrackerEntry>();
        // Track first-seen timestamp per ID for sort order
        const firstSeen = new Map<string, string>();
        for (const entry of raw) {
          latest.set(entry.id, entry);
          if (!firstSeen.has(entry.id)) {
            firstSeen.set(entry.id, entry.timestamp);
          }
        }

        // Sort newest-first by first-seen timestamp
        const deduped = [...latest.values()].sort((a, b) => {
          const aFirst = firstSeen.get(a.id) || a.timestamp;
          const bFirst = firstSeen.get(b.id) || b.timestamp;
          return bFirst.localeCompare(aFirst);
        });

        setEntries(deduped);
        setWorkflows(wfs || []);
        setLoading(false);
      } catch {
        // ignore malformed
      }
    };

    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [workflow, date]);

  return { entries, workflows, connected, loading };
}
```

- [ ] **Step 4: Create useLogs**

Create `src/dashboard/components/hooks/useLogs.ts`:

```typescript
import { useState, useEffect, useRef } from "react";
import type { LogEntry } from "../types";

export interface CollapsedLogEntry extends LogEntry {
  count: number;
}

/**
 * Fetch initial logs + SSE stream for live updates.
 * Returns collapsed logs (consecutive duplicates merged with count badge).
 */
export function useLogs(
  workflow: string,
  itemId: string | null,
  runId: string | null,
  date: string,
): { logs: CollapsedLogEntry[]; loading: boolean } {
  const [rawLogs, setRawLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!itemId) {
      setRawLogs([]);
      setLoading(false);
      return;
    }
    setRawLogs([]);
    prevLenRef.current = 0;
    setLoading(true);

    // Build query params
    const params = new URLSearchParams({ workflow, id: itemId });
    if (runId) params.set("runId", runId);
    if (date) params.set("date", date);

    // Initial fetch
    fetch("/api/logs?" + params.toString())
      .then((r) => r.json())
      .then((entries: LogEntry[]) => {
        if (Array.isArray(entries) && entries.length > 0) {
          setRawLogs(entries);
          prevLenRef.current = entries.length;
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // SSE for live updates
    const es = new EventSource("/events/logs?" + params.toString());
    es.onmessage = (e) => {
      try {
        const newEntries: LogEntry[] = JSON.parse(e.data);
        if (Array.isArray(newEntries) && newEntries.length > 0) {
          setRawLogs((prev) => [...prev, ...newEntries]);
        }
      } catch {}
    };

    return () => es.close();
  }, [workflow, itemId, runId, date]);

  // Collapse consecutive duplicate messages
  const collapsed: CollapsedLogEntry[] = [];
  for (const log of rawLogs) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.message === log.message) {
      prev.count++;
    } else {
      collapsed.push({ ...log, count: 1 });
    }
  }

  return { logs: collapsed, loading };
}
```

- [ ] **Step 5: Create usePreflight**

Create `src/dashboard/components/hooks/usePreflight.ts`:

```typescript
import { useEffect, useRef } from "react";
import { toast } from "sonner";

interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Fetch /api/preflight on mount and show a toast with results. */
export function usePreflight(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    fetch("/api/preflight")
      .then((r) => r.json())
      .then(({ checks }: { checks: PreflightCheck[] }) => {
        const allPassed = checks.every((c) => c.passed);
        const desc = checks.map((c) => `${c.passed ? "\u2713" : "\u2717"} ${c.detail}`).join(" \u00b7 ");
        if (allPassed) {
          toast.info("Pre-flight checks passed", { description: desc, duration: 5000 });
        } else {
          toast.warning("Pre-flight issues", { description: desc, duration: 8000 });
        }
      })
      .catch(() => {
        // Dashboard backend not running — ignore silently
      });
  }, []);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/hooks/
git commit -m "feat(dashboard): add hooks — useEntries, useLogs, useClock, useElapsed, usePreflight"
```

---

### Task 6: UI Components — EmptyState, StatPills, EntryItem, RunSelector

**Files:**
- Create: `src/dashboard/components/EmptyState.tsx`
- Create: `src/dashboard/components/StatPills.tsx`
- Create: `src/dashboard/components/EntryItem.tsx`
- Create: `src/dashboard/components/RunSelector.tsx`

- [ ] **Step 1: Create EmptyState**

Create `src/dashboard/components/EmptyState.tsx`:

```tsx
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 text-center p-8", className)}>
      <Icon className="h-10 w-10 text-muted-foreground opacity-30" />
      <div className="text-base font-semibold text-muted-foreground">{title}</div>
      <div className="text-sm text-muted-foreground/70">{description}</div>
    </div>
  );
}
```

- [ ] **Step 2: Create StatPills**

Create `src/dashboard/components/StatPills.tsx`:

```tsx
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";

interface StatPillsProps {
  entries: TrackerEntry[];
  activeFilter: string | null;
  onFilter: (status: string | null) => void;
}

const STATS = [
  { key: null, label: "Total", color: "text-foreground" },
  { key: "done", label: "Done", color: "text-[#4ade80]" },
  { key: "running", label: "Active", color: "text-primary" },
  { key: "failed", label: "Failed", color: "text-destructive" },
  { key: "pending", label: "Queue", color: "text-[#fbbf24]" },
] as const;

export function StatPills({ entries, activeFilter, onFilter }: StatPillsProps) {
  const counts: Record<string, number> = { total: entries.length };
  for (const e of entries) {
    counts[e.status] = (counts[e.status] || 0) + 1;
  }

  return (
    <div className="flex gap-1.5 p-3.5 px-5 border-b border-border">
      {STATS.map((s) => {
        const count = s.key ? (counts[s.key] || 0) : entries.length;
        const isActive = activeFilter === s.key;
        return (
          <button
            key={s.key ?? "total"}
            onClick={() => onFilter(isActive ? null : s.key)}
            className={cn(
              "flex-1 text-center py-2.5 px-2 rounded-lg transition-all",
              "bg-secondary border border-transparent cursor-pointer",
              "hover:border-border",
              isActive && "bg-accent border-primary",
            )}
          >
            <div className={cn("text-xl font-bold font-mono leading-tight", s.color)}>
              {count}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-0.5 font-medium">
              {s.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Create EntryItem**

Create `src/dashboard/components/EntryItem.tsx`:

```tsx
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import { getConfig } from "./types";
import { useElapsed } from "./hooks/useElapsed";

interface EntryItemProps {
  entry: TrackerEntry;
  workflow: string;
  selected: boolean;
  onClick: () => void;
}

const badgeStyles: Record<string, string> = {
  running: "bg-primary/15 text-primary",
  done: "bg-[#4ade80]/12 text-[#4ade80]",
  failed: "bg-destructive/12 text-destructive",
  pending: "bg-[#fbbf24]/12 text-[#fbbf24]",
  skipped: "bg-secondary text-muted-foreground",
};

export function EntryItem({ entry, workflow, selected, onClick }: EntryItemProps) {
  const cfg = getConfig(workflow);
  const name = cfg.getName(entry);
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed";
  const isDone = entry.status === "done";
  const elapsed = useElapsed(isRunning ? entry.timestamp : null);

  // Extract run number from runId
  const runNumber = entry.runId?.split("#")[1];
  const showRun = runNumber && parseInt(runNumber) > 1;

  // Compute duration for done entries (from first timestamp to last)
  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div
      onClick={onClick}
      className={cn(
        "px-5 py-3.5 border-b border-border cursor-pointer transition-colors",
        "hover:bg-secondary",
        selected && "bg-accent border-l-[3px] border-l-primary pl-[17px]",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-[15px]">{name || entry.id}</span>
        <span className={cn("text-[11px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", badgeStyles[entry.status])}>
          {entry.status}
        </span>
      </div>

      {name && (
        <div className="font-mono text-[13px] text-muted-foreground mt-0.5">{entry.id}</div>
      )}

      {isFailed && entry.error && (
        <div className="font-mono text-xs text-destructive mt-1.5 truncate">
          ✗ {entry.error}
        </div>
      )}

      <div className="flex items-center gap-2.5 mt-2">
        {isRunning && entry.step && (
          <span className="font-mono text-xs text-accent-foreground">
            ▶ {entry.step.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          </span>
        )}
        {!isRunning && !isFailed && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
        {showRun && (
          <span className="font-mono text-[11px] text-muted-foreground bg-secondary px-2 py-0.5 rounded font-medium">
            Run #{runNumber}
          </span>
        )}
        <span className="flex-1" />
        {isRunning && elapsed && (
          <span className="font-mono text-xs text-primary">{elapsed}</span>
        )}
        {isDone && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
        {isFailed && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create RunSelector**

Create `src/dashboard/components/RunSelector.tsx`:

```tsx
import { cn } from "@/lib/utils";
import type { RunInfo } from "./types";

interface RunSelectorProps {
  runs: RunInfo[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}

export function RunSelector({ runs, activeRunId, onSelect }: RunSelectorProps) {
  if (runs.length <= 1) return null;

  return (
    <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
      {runs.map((run) => {
        const num = run.runId.split("#")[1] || "1";
        const isFailed = run.status === "failed";
        const isActive = run.runId === activeRunId;
        return (
          <button
            key={run.runId}
            onClick={() => onSelect(run.runId)}
            className={cn(
              "px-3.5 py-1 rounded text-xs font-mono font-medium transition-all cursor-pointer",
              "text-muted-foreground hover:text-foreground",
              isActive && "bg-accent text-foreground",
              isFailed && !isActive && "text-destructive",
            )}
          >
            Run #{num} {isFailed && "✗"}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/EmptyState.tsx src/dashboard/components/StatPills.tsx src/dashboard/components/EntryItem.tsx src/dashboard/components/RunSelector.tsx
git commit -m "feat(dashboard): add EmptyState, StatPills, EntryItem, RunSelector components"
```

---

### Task 7: UI Components — StepPipeline, LogLine, LogStream

**Files:**
- Create: `src/dashboard/components/StepPipeline.tsx`
- Create: `src/dashboard/components/LogLine.tsx`
- Create: `src/dashboard/components/LogStream.tsx`

- [ ] **Step 1: Create StepPipeline**

Create `src/dashboard/components/StepPipeline.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { Check, Play } from "lucide-react";
import { formatStepName } from "./types";

interface StepPipelineProps {
  steps: string[];
  currentStep: string | null;
  status: string;
}

export function StepPipeline({ steps, currentStep, status }: StepPipelineProps) {
  if (steps.length === 0) return null;

  const currentIdx = currentStep ? steps.indexOf(currentStep) : -1;
  const isDone = status === "done";
  const isFailed = status === "failed";

  return (
    <div className="flex items-center px-6 py-4 border-b border-border overflow-x-auto gap-0">
      {steps.map((step, i) => {
        const isComplete = isDone || i < currentIdx;
        const isActive = !isDone && !isFailed && i === currentIdx;
        const isPending = !isComplete && !isActive;

        return (
          <div key={step} className="flex items-center">
            {i > 0 && (
              <div className={cn(
                "w-8 h-0.5 mx-1.5 rounded-sm flex-shrink-0",
                isComplete ? "bg-[#4ade80]/30" : "bg-border",
              )} />
            )}
            <div className="flex items-center whitespace-nowrap">
              <div className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0",
                isComplete && "bg-[#4ade80]/15 text-[#4ade80]",
                isActive && "bg-primary/20 text-primary animate-pulse",
                isPending && "bg-secondary text-muted-foreground",
              )}>
                {isComplete ? <Check className="w-3 h-3" /> : isActive ? <Play className="w-3 h-3" /> : ""}
              </div>
              <div className="ml-1.5">
                <span className={cn(
                  "text-xs font-medium block",
                  isComplete && "text-[#4ade80]",
                  isActive && "text-primary font-semibold",
                  isPending && "text-muted-foreground",
                )}>
                  {formatStepName(step)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create LogLine**

Create `src/dashboard/components/LogLine.tsx`:

```tsx
import { cn } from "@/lib/utils";
import {
  Pencil, MousePointer, ArrowDownToLine, Search, ListFilter,
  KeyRound, Download, Check, X, Hourglass, ArrowRight,
} from "lucide-react";
import type { LogCategory } from "./types";
import { getLogCategory } from "./types";
import type { CollapsedLogEntry } from "./hooks/useLogs";

const ICON_MAP: Record<LogCategory, { icon: typeof Check; color: string }> = {
  fill: { icon: Pencil, color: "text-cyan-400" },
  navigate: { icon: MousePointer, color: "text-slate-400" },
  extract: { icon: ArrowDownToLine, color: "text-amber-400" },
  search: { icon: Search, color: "text-blue-400" },
  select: { icon: ListFilter, color: "text-teal-400" },
  auth: { icon: KeyRound, color: "text-purple-400" },
  download: { icon: Download, color: "text-green-400" },
  success: { icon: Check, color: "text-[#4ade80]" },
  error: { icon: X, color: "text-destructive" },
  waiting: { icon: Hourglass, color: "text-[#fbbf24]" },
  step: { icon: ArrowRight, color: "text-blue-400" },
};

interface LogLineProps {
  entry: CollapsedLogEntry;
  isCurrent: boolean;
  onCopy: (text: string) => void;
}

export function LogLine({ entry, isCurrent, onCopy }: LogLineProps) {
  const category = getLogCategory(entry.level, entry.message);
  const { icon: Icon, color } = ICON_MAP[category];
  const ts = entry.ts
    ? new Date(entry.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";

  return (
    <div
      className={cn(
        "group flex items-baseline gap-3.5 px-6 py-[3px] font-mono text-[13px] leading-relaxed cursor-pointer relative",
        "transition-colors hover:bg-foreground/[0.02]",
        isCurrent && "bg-primary/[0.05]",
      )}
      onClick={() => onCopy(`${ts} ${entry.message}`)}
    >
      <span className="text-muted-foreground text-xs whitespace-nowrap min-w-[72px]">{ts}</span>
      <Icon className={cn("w-[14px] h-[14px] flex-shrink-0 translate-y-[1px]", color)} />
      <span className={cn(
        "flex-1 break-words",
        category === "success" && "text-[#4ade80]",
        category === "error" && "text-destructive",
        isCurrent && "text-primary",
        category !== "success" && category !== "error" && !isCurrent && "text-secondary-foreground",
      )}>
        {entry.message}
      </span>
      {entry.count > 1 && (
        <span className="text-[11px] bg-accent text-accent-foreground px-1.5 py-px rounded font-semibold flex-shrink-0">
          x{entry.count}
        </span>
      )}
      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
        Copy
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Create LogStream**

Create `src/dashboard/components/LogStream.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { LogLine } from "./LogLine";
import type { CollapsedLogEntry } from "./hooks/useLogs";
import type { LogCategory } from "./types";
import { getLogCategory } from "./types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface LogStreamProps {
  logs: CollapsedLogEntry[];
  loading: boolean;
}

const FILTER_TABS: { key: string; label: string; categories: LogCategory[] }[] = [
  { key: "all", label: "All", categories: [] },
  { key: "errors", label: "Errors", categories: ["error"] },
  { key: "auth", label: "Auth", categories: ["auth"] },
  { key: "fill", label: "Fill", categories: ["fill"] },
  { key: "navigate", label: "Navigate", categories: ["navigate"] },
  { key: "extract", label: "Extract", categories: ["extract"] },
];

export function LogStream({ logs, loading }: LogStreamProps) {
  const [filter, setFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const filtered = filter === "all"
    ? logs
    : logs.filter((l) => {
        const tab = FILTER_TABS.find((t) => t.key === filter);
        return tab?.categories.includes(getLogCategory(l.level, l.message));
      });

  const collapsedCount = logs.reduce((acc, l) => acc + (l.count > 1 ? l.count - 1 : 0), 0);

  // Auto-scroll on new entries
  useEffect(() => {
    if (autoScroll && scrollRef.current && filtered.length > prevLenRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = filtered.length;
  }, [filtered.length, autoScroll]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard", { duration: 1500 });
  };

  return (
    <>
      {/* Filter tabs */}
      <div className="flex items-center gap-0.5 px-6 py-2 border-b border-border flex-shrink-0">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer",
              "text-muted-foreground hover:text-foreground hover:bg-secondary",
              filter === tab.key && "text-foreground bg-accent",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Log lines */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3">
        {loading && filtered.length === 0 ? (
          <div className="space-y-2 px-6 py-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3.5">
                <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                <div className="h-3 w-3.5 rounded bg-muted animate-pulse" />
                <div className="h-3 rounded bg-muted animate-pulse" style={{ width: `${120 + i * 40}px` }} />
              </div>
            ))}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <LogLine
              key={`${entry.ts}-${i}`}
              entry={entry}
              isCurrent={i === filtered.length - 1 && entry.level === "step"}
              onCopy={handleCopy}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-2.5 border-t border-border text-[13px] text-muted-foreground flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-[7px] h-[7px] rounded-full bg-primary animate-pulse" />
          <span>Streaming</span>
          <span className="opacity-40">·</span>
          <span>{filtered.length} entries</span>
          {collapsedCount > 0 && (
            <>
              <span className="opacity-40">·</span>
              <span>{collapsedCount} collapsed</span>
            </>
          )}
        </div>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={cn(
            "text-xs px-3 py-1 rounded-md border border-border font-medium cursor-pointer transition-all",
            "bg-secondary text-muted-foreground",
            autoScroll && "bg-accent text-accent-foreground border-primary",
          )}
        >
          ↧ Auto-scroll
        </button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/StepPipeline.tsx src/dashboard/components/LogLine.tsx src/dashboard/components/LogStream.tsx
git commit -m "feat(dashboard): add StepPipeline, LogLine, LogStream components"
```

---

### Task 8: UI Components — QueuePanel, LogPanel, TopBar

**Files:**
- Create: `src/dashboard/components/QueuePanel.tsx`
- Create: `src/dashboard/components/LogPanel.tsx`
- Create: `src/dashboard/components/TopBar.tsx`

- [ ] **Step 1: Create QueuePanel**

Create `src/dashboard/components/QueuePanel.tsx`:

```tsx
import { useState, useMemo } from "react";
import { Search, Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import type { TrackerEntry } from "./types";
import { getConfig } from "./types";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

export function QueuePanel({ entries, workflow, selectedId, onSelect, loading }: QueuePanelProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const cfg = getConfig(workflow);

  const filtered = useMemo(() => {
    let result = entries;
    if (statusFilter) {
      result = result.filter((e) =>
        statusFilter === "pending" ? e.status === "pending" || e.status === "skipped" : e.status === statusFilter,
      );
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((e) => {
        const name = (cfg.getName(e) || "").toLowerCase();
        return e.id.toLowerCase().includes(q) || name.includes(q);
      });
    }
    return result;
  }, [entries, statusFilter, search, cfg]);

  return (
    <div className="w-[480px] min-w-[380px] border-r border-border flex flex-col bg-background">
      {/* Search */}
      <div className="p-4 px-5 border-b border-border">
        <div className="flex items-center gap-2.5 bg-input border border-border rounded-lg px-3.5 py-2.5 focus-within:border-primary transition-colors">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by name, email, or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-foreground text-sm font-sans placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Stats */}
      <StatPills entries={entries} activeFilter={statusFilter} onFilter={setStatusFilter} />

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-5 py-3.5 border-b border-border">
                <div className="flex justify-between mb-2">
                  <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                </div>
                <div className="h-3 w-48 rounded bg-muted animate-pulse mt-1" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse mt-2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No entries yet"
            description="Data will appear here as workflows run"
          />
        ) : (
          filtered.map((entry) => (
            <EntryItem
              key={entry.id}
              entry={entry}
              workflow={workflow}
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create LogPanel**

Create `src/dashboard/components/LogPanel.tsx`:

```tsx
import { useState, useEffect } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { EmptyState } from "./EmptyState";
import { useLogs } from "./hooks/useLogs";
import { useElapsed } from "./hooks/useElapsed";
import { cn } from "@/lib/utils";
import type { TrackerEntry, RunInfo } from "./types";
import { getConfig } from "./types";

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
}

const badgeStyles: Record<string, string> = {
  running: "bg-primary/15 text-primary",
  done: "bg-[#4ade80]/12 text-[#4ade80]",
  failed: "bg-destructive/12 text-destructive",
  pending: "bg-[#fbbf24]/12 text-[#fbbf24]",
  skipped: "bg-secondary text-muted-foreground",
};

export function LogPanel({ entry, workflow, date }: LogPanelProps) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const cfg = getConfig(workflow);

  // Fetch runs when entry changes
  useEffect(() => {
    if (!entry) {
      setRuns([]);
      setActiveRunId(null);
      return;
    }
    fetch(`/api/runs?workflow=${encodeURIComponent(workflow)}&id=${encodeURIComponent(entry.id)}`)
      .then((r) => r.json())
      .then((data: RunInfo[]) => {
        setRuns(data);
        // Default to latest run
        setActiveRunId(data.length > 0 ? data[data.length - 1].runId : entry.runId || null);
      })
      .catch(() => setRuns([]));
  }, [entry?.id, workflow]);

  const { logs, loading: logsLoading } = useLogs(workflow, entry?.id || null, activeRunId, date);
  const elapsed = useElapsed(entry?.status === "running" ? entry.timestamp : null);

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col bg-card">
        <EmptyState
          icon={TerminalSquare}
          title="Select an entry"
          description="Click an entry in the queue to view its logs"
        />
      </div>
    );
  }

  const name = cfg.getName(entry);
  const startTime = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "";

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3.5">
          <span className="font-bold text-lg">{name || entry.id}</span>
          <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", badgeStyles[entry.status])}>
            {entry.status}
          </span>
          {name && <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>}
        </div>
        <RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} />
      </div>

      {/* Detail grid */}
      <div className="grid grid-cols-4 border-b border-border flex-shrink-0">
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            {cfg.detailFields[0]?.label || "ID"}
          </div>
          <div className="text-sm font-medium">{name || entry.id}</div>
        </div>
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            {cfg.detailFields[1]?.label || "ID"}
          </div>
          <div className="text-sm font-mono">{entry.id}</div>
        </div>
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Started</div>
          <div className="text-sm font-mono">{startTime}</div>
        </div>
        <div className="px-6 py-3.5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Elapsed</div>
          <div className={cn("text-sm font-mono", entry.status === "running" && "text-primary")}>
            {elapsed || "—"}
          </div>
        </div>
      </div>

      {/* Step pipeline */}
      <StepPipeline
        steps={cfg.steps}
        currentStep={entry.step || null}
        status={entry.status}
      />

      {/* Log stream + filters + footer */}
      <LogStream logs={logs} loading={logsLoading} />
    </div>
  );
}
```

- [ ] **Step 3: Create TopBar**

Create `src/dashboard/components/TopBar.tsx`:

```tsx
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useClock } from "./hooks/useClock";
import { cn } from "@/lib/utils";
import { TAB_ORDER, getConfig } from "./types";

interface TopBarProps {
  workflow: string;
  workflows: string[];
  onWorkflowChange: (wf: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  connected: boolean;
  entryCounts: Record<string, number>;
}

export function TopBar({
  workflow, workflows, onWorkflowChange,
  date, onDateChange, availableDates,
  connected, entryCounts,
}: TopBarProps) {
  const clock = useClock();

  const allWfs = useMemo(() => {
    const ordered = TAB_ORDER.filter((wf) => wf === workflow || workflows.includes(wf));
    workflows.forEach((wf) => {
      if (!ordered.includes(wf)) ordered.push(wf);
    });
    if (!ordered.includes(workflow)) ordered.unshift(workflow);
    return ordered;
  }, [workflow, workflows]);

  const dateDisplay = (() => {
    try {
      const d = new Date(date + "T00:00:00");
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return date;
    }
  })();

  const navigate = (dir: -1 | 1) => {
    const idx = availableDates.indexOf(date);
    const next = availableDates[idx - dir]; // dates are desc, so -dir
    if (next) onDateChange(next);
  };

  return (
    <div className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-5">
        <span className="text-base font-bold tracking-tight whitespace-nowrap">HR Dashboard</span>
        <div className="w-px h-6 bg-border" />

        {/* Workflow dropdown */}
        <div className="relative group">
          <button className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-secondary cursor-pointer w-[220px] transition-colors hover:border-primary">
            <span className="flex-1 text-left font-semibold text-sm">{getConfig(workflow).label}</span>
            <span className="text-xs text-muted-foreground font-mono font-medium">{entryCounts[workflow] || 0}</span>
            <span className="text-muted-foreground text-[10px]">▾</span>
          </button>
          <div className="absolute top-[calc(100%+6px)] left-0 w-[220px] bg-card border border-border rounded-xl shadow-xl z-50 p-1 hidden group-focus-within:block">
            {allWfs.map((wf) => (
              <button
                key={wf}
                onClick={() => onWorkflowChange(wf)}
                className={cn(
                  "flex items-center justify-between w-full px-3 py-2.5 rounded-md text-[13px] cursor-pointer transition-colors",
                  "hover:bg-accent",
                  wf === workflow && "bg-accent",
                )}
              >
                <span className={cn("font-medium", wf === workflow && "font-semibold text-primary")}>{getConfig(wf).label}</span>
                <span className={cn("font-mono text-[11px]", (entryCounts[wf] || 0) > 0 ? "text-primary font-semibold" : "text-muted-foreground")}>
                  {entryCounts[wf] || 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Date nav */}
        <div className="flex items-center gap-1">
          <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-4 py-1.5 rounded-md border border-border bg-secondary font-mono text-[13px] font-medium min-w-[120px] text-center cursor-pointer hover:bg-accent transition-colors">
            {dateDisplay}
          </div>
          <button onClick={() => navigate(1)} className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Live indicator */}
        <div className={cn(
          "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium",
          connected
            ? "bg-[#4ade80]/8 border border-[#4ade80]/20 text-[#4ade80]"
            : "bg-destructive/8 border border-destructive/20 text-destructive",
        )}>
          <div className={cn("w-[7px] h-[7px] rounded-full", connected ? "bg-[#4ade80] animate-pulse" : "bg-destructive")} />
          {connected ? "Live" : "Disconnected"}
        </div>

        <span className="font-mono text-[13px] text-muted-foreground font-medium">{clock}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/QueuePanel.tsx src/dashboard/components/LogPanel.tsx src/dashboard/components/TopBar.tsx
git commit -m "feat(dashboard): add QueuePanel, LogPanel, TopBar components"
```

---

### Task 9: App Shell & Integration

**Files:**
- Modify: `src/dashboard/App.tsx`
- Modify: `src/dashboard/main.tsx`
- Delete (after integration): `src/dashboard/components/DataTable.tsx`, `src/dashboard/components/FilterBar.tsx`, `src/dashboard/components/StatsRow.tsx`, `src/dashboard/components/ProgressBar.tsx`, `src/dashboard/components/hooks.ts` (old hooks file)

- [ ] **Step 1: Rewrite App.tsx**

Replace `src/dashboard/App.tsx` entirely:

```tsx
import { useState, useEffect, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";
import { TopBar } from "./components/TopBar";
import { QueuePanel } from "./components/QueuePanel";
import { LogPanel } from "./components/LogPanel";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { getConfig } from "./components/types";

export default function App() {
  const [workflow, setWorkflow] = useState("onboarding");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const prevStatusRef = useMemo(() => new Map<string, string>(), []);

  // Pre-flight check on mount
  usePreflight();

  // SSE entries
  const { entries, workflows, connected, loading } = useEntries(workflow, date);

  // Fetch available dates when workflow changes
  useEffect(() => {
    fetch("/api/dates?workflow=" + encodeURIComponent(workflow))
      .then((r) => r.json())
      .then((dates: string[]) => {
        setAvailableDates(dates);
        const today = new Date().toISOString().slice(0, 10);
        if (!dates.includes(date)) setDate(dates[0] || today);
      })
      .catch(() => {});
  }, [workflow]);

  // Toast on completion/failure
  useEffect(() => {
    for (const entry of entries) {
      const prevStatus = prevStatusRef.get(entry.id);
      if (prevStatus && prevStatus !== entry.status) {
        const cfg = getConfig(workflow);
        const name = cfg.getName(entry) || entry.id;
        if (entry.status === "done") {
          toast.success(`${name} completed`, {
            description: `${cfg.label} finished`,
            duration: 5000,
          });
        } else if (entry.status === "failed") {
          toast.error(`${name} failed`, {
            description: entry.error || "Unknown error",
            duration: 8000,
          });
        }
      }
      prevStatusRef.set(entry.id, entry.status);
    }
  }, [entries, workflow, prevStatusRef]);

  // Update document title
  useEffect(() => {
    const running = entries.filter((e) => e.status === "running").length;
    document.title = running > 0 ? `${running} running — HR Dashboard` : "HR Dashboard";
  }, [entries]);

  // Clear selection when switching workflows
  const handleWorkflowChange = useCallback((wf: string) => {
    setWorkflow(wf);
    setSelectedId(null);
  }, []);

  // Entry counts per workflow for dropdown badges
  const entryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const wf of workflows) counts[wf] = 0;
    // Only count current workflow's entries (we only have SSE for one at a time)
    counts[workflow] = entries.length;
    return counts;
  }, [workflows, workflow, entries.length]);

  const selectedEntry = entries.find((e) => e.id === selectedId) || null;

  return (
    <div className="flex flex-col h-screen">
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            color: "hsl(var(--foreground))",
          },
        }}
      />
      <TopBar
        workflow={workflow}
        workflows={workflows}
        onWorkflowChange={handleWorkflowChange}
        date={date}
        onDateChange={setDate}
        availableDates={availableDates}
        connected={connected}
        entryCounts={entryCounts}
      />
      <div className="flex flex-1 overflow-hidden">
        <QueuePanel
          entries={entries}
          workflow={workflow}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loading}
        />
        <LogPanel
          entry={selectedEntry}
          workflow={workflow}
          date={date}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update main.tsx to remove HeroUI provider**

The current `main.tsx` is clean (no HeroUI provider), so just verify it looks like this:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 3: Delete old component files**

```bash
rm src/dashboard/components/DataTable.tsx
rm src/dashboard/components/FilterBar.tsx
rm src/dashboard/components/StatsRow.tsx
rm src/dashboard/components/ProgressBar.tsx
rm src/dashboard/components/hooks.ts
```

- [ ] **Step 4: Verify dev server starts and renders**

```bash
npx vite --config vite.dashboard.config.ts
```

Open http://localhost:5173 — verify the split panel layout renders (it will show "No entries" and "Select an entry" empty states if the SSE backend isn't running).

- [ ] **Step 5: Commit**

```bash
git add -A src/dashboard/
git commit -m "feat(dashboard): complete split-panel rewrite with shadcn, remove HeroUI components"
```

---

### Task 10: Cleanup — Remove HeroUI Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Uninstall HeroUI and framer-motion**

```bash
npm uninstall @heroui/react @heroui/styles framer-motion
```

- [ ] **Step 2: Verify build succeeds**

```bash
npx vite build --config vite.dashboard.config.ts
```

Expected: Build completes, outputs `dist/dashboard/index.html`.

- [ ] **Step 3: Verify no remaining HeroUI imports**

```bash
grep -r "@heroui" src/dashboard/ || echo "No HeroUI imports found — clean"
grep -r "framer-motion" src/dashboard/ || echo "No framer-motion imports found — clean"
```

Expected: Both print the "clean" message.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove @heroui/react, @heroui/styles, framer-motion dependencies"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors (dashboard is excluded from main tsconfig, but verify no breakage in tracker files).

- [ ] **Step 2: Start full dashboard (backend + frontend)**

In terminal 1:
```bash
npm run dashboard
```

In terminal 2, or open browser to http://localhost:5173.

Expected: Dashboard loads with split-panel layout. Pre-flight toast appears. Live indicator shows green.

- [ ] **Step 3: Build production bundle**

```bash
npm run build:dashboard
```

Expected: Single-file HTML bundle at `dist/dashboard/index.html`.

- [ ] **Step 4: Commit any remaining fixes**

If any issues found during verification, fix and commit.
