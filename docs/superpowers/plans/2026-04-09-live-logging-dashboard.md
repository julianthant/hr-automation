# Live Per-Item Logging + Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-item log capture via AsyncLocalStorage so clicking a dashboard row streams live logs for that employee, plus fix dashboard UX (no flickering, fixed tabs, no logo).

**Architecture:** Modify `log.ts` to check AsyncLocalStorage on every log call and append to JSONL if a context is active. Add `withLogContext()` wrappers at 6 workflow entry points. Add `/events/logs` SSE endpoint and row-click log panel to dashboard. Use DOM diffing to eliminate table flickering.

**Tech Stack:** Node.js `AsyncLocalStorage`, existing JSONL tracker, Playwright (unchanged), SSE.

---

## File Structure

### Files to Create
```
tests/unit/log-context.test.ts  — Tests for withLogContext + log capture
```

### Files to Modify
```
src/utils/log.ts                             — Add AsyncLocalStorage, withLogContext, JSONL log append
src/tracker/jsonl.ts                         — Add LogEntry type + readLogEntries()
src/tracker/dashboard.ts                     — Full rewrite: DOM diffing, fixed tabs, log panel, no logo
src/workflows/onboarding/parallel.ts         — Wrap runOnboarding call with withLogContext
src/workflows/eid-lookup/workflow.ts         — Wrap searchByName calls with withLogContext
src/workflows/old-kronos-reports/parallel.ts — Wrap runKronosForEmployee call with withLogContext
src/workflows/work-study/workflow.ts         — Wrap runWorkStudy body with withLogContext
src/workflows/separations/workflow.ts        — Wrap runSeparation body with withLogContext
src/workflows/onboarding/workflow.ts         — Wrap runOnboarding body with withLogContext (single mode)
src/scripts/demo-dashboard.ts                — Add demo log entries
```

### Files to Modify (enhanced logging — ~30 new log calls)
```
src/auth/duo-poll.ts
src/auth/sso-fields.ts
src/kuali/navigate.ts
src/ucpath/transaction.ts
src/workflows/onboarding/extract.ts
src/workflows/eid-lookup/search.ts
src/workflows/separations/workflow.ts
src/old-kronos/reports.ts
```

---

## Task 1: Per-Item Log Capture System

**Files:**
- Modify: `src/utils/log.ts`
- Modify: `src/tracker/jsonl.ts`
- Create: `tests/unit/log-context.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/unit/log-context.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "fs";
import { withLogContext, log } from "../../src/utils/log.js";

const TEST_DIR = ".tracker-log-test";

describe("withLogContext", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("captures log calls inside context to JSONL", async () => {
    await withLogContext("test-wf", "item-001", async () => {
      log.step("doing something");
      log.success("it worked");
    }, TEST_DIR);

    const files = require("fs").readdirSync(TEST_DIR);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("-logs.jsonl"));

    const lines = readFileSync(`${TEST_DIR}/${files[0]}`, "utf-8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);

    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.workflow, "test-wf");
    assert.equal(entry1.itemId, "item-001");
    assert.equal(entry1.level, "step");
    assert.equal(entry1.message, "doing something");

    const entry2 = JSON.parse(lines[1]);
    assert.equal(entry2.level, "success");
  });

  it("does not capture logs outside context", async () => {
    log.step("outside context");
    // No JSONL file should be created
    assert.equal(existsSync(TEST_DIR), false);
  });

  it("handles nested contexts independently", async () => {
    await withLogContext("wf-a", "id-a", async () => {
      log.step("from A");
    }, TEST_DIR);

    await withLogContext("wf-b", "id-b", async () => {
      log.step("from B");
    }, TEST_DIR);

    const files = require("fs").readdirSync(TEST_DIR).sort();
    // Two separate log files (wf-a and wf-b)
    assert.equal(files.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/log-context.test.ts`
Expected: FAIL — `withLogContext` not exported

- [ ] **Step 3: Add LogEntry type and readLogEntries to jsonl.ts**

In `src/tracker/jsonl.ts`, add after the existing exports:

```typescript
export interface LogEntry {
  workflow: string;
  itemId: string;
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

function getLogFilePath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}-logs.jsonl`);
}

export function appendLogEntry(entry: LogEntry, dir: string = DEFAULT_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = getLogFilePath(entry.workflow, dir);
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export function readLogEntries(
  workflow: string,
  itemId?: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const logPath = getLogFilePath(workflow, dir);
  if (!existsSync(logPath)) return [];
  const all = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}
```

- [ ] **Step 4: Rewrite src/utils/log.ts with AsyncLocalStorage**

```typescript
// src/utils/log.ts
import pc from "picocolors";
import { AsyncLocalStorage } from "async_hooks";
import { appendLogEntry, type LogEntry } from "../tracker/jsonl.js";

interface LogContext {
  workflow: string;
  itemId: string;
  dir?: string;
}

const logStore = new AsyncLocalStorage<LogContext>();

function emit(
  level: LogEntry["level"],
  prefix: string,
  msg: string,
  toStderr = false,
): void {
  // Always print to console
  if (toStderr) {
    console.error(prefix + " " + msg);
  } else {
    console.log(prefix + " " + msg);
  }

  // Capture to JSONL if inside a log context
  const ctx = logStore.getStore();
  if (ctx) {
    appendLogEntry(
      {
        workflow: ctx.workflow,
        itemId: ctx.itemId,
        level,
        message: msg,
        ts: new Date().toISOString(),
      },
      ctx.dir,
    );
  }
}

export const log = {
  step: (msg: string): void => emit("step", pc.blue("->"), msg),
  success: (msg: string): void => emit("success", pc.green("\u2713"), msg),
  waiting: (msg: string): void => emit("waiting", pc.yellow("\u231B"), msg),
  error: (msg: string): void => emit("error", pc.red("\u2717"), msg, true),
};

/**
 * Run an async function with per-item log capture.
 * All log.* calls inside the function are captured to JSONL.
 */
export function withLogContext<T>(
  workflow: string,
  itemId: string,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  return logStore.run({ workflow, itemId, dir }, fn);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/unit/log-context.test.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck and all tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/utils/log.ts src/tracker/jsonl.ts tests/unit/log-context.test.ts
git commit -m "feat: add per-item log capture via AsyncLocalStorage"
```

---

## Task 2: Wire withLogContext Into All Workflows

**Files:**
- Modify: `src/workflows/onboarding/workflow.ts`
- Modify: `src/workflows/onboarding/parallel.ts`
- Modify: `src/workflows/eid-lookup/workflow.ts`
- Modify: `src/workflows/old-kronos-reports/parallel.ts`
- Modify: `src/workflows/work-study/workflow.ts`
- Modify: `src/workflows/separations/workflow.ts`

- [ ] **Step 1: Wrap onboarding single mode**

In `src/workflows/onboarding/workflow.ts`, import and wrap the function body. At the top add:
```typescript
import { withLogContext } from "../../utils/log.js";
```

Inside `runOnboarding`, wrap the main body after the prefix setup. Find the line `const p = options.logPrefix;` and wrap everything after it:
```typescript
export async function runOnboarding(email: string, options: OnboardingOptions = {}): Promise<void> {
  const p = options.logPrefix;
  const isParallel = !!p;

  await withLogContext("onboarding", email, async () => {
    // ... existing function body (indented one level)
  });
}
```

- [ ] **Step 2: Wrap onboarding parallel worker loop**

In `src/workflows/onboarding/parallel.ts`, import `withLogContext` and wrap the `runOnboarding` call inside the worker loop (around line 108):

```typescript
import { withLogContext } from "../../utils/log.js";

// Inside the while loop, wrap the runOnboarding call:
await withLogContext("onboarding", email, () =>
  runOnboarding(email, {
    dryRun: options.dryRun,
    crmPage: crmBrowser.page,
    ucpathPage,
    updateTrackerFn: lockedTracker,
    logPrefix: prefix,
  }),
);
```

- [ ] **Step 3: Wrap EID lookup workflows**

In `src/workflows/eid-lookup/workflow.ts`, import `withLogContext` and wrap:

For `lookupSingle` (around line 40): wrap the `searchByName` call and tracker updates.
For `lookupParallel` worker loop (around line 124): wrap the per-name processing block.
For `lookupWithCrm` (around line 210): wrap the entire search + cross-verify block.

```typescript
import { withLogContext } from "../../utils/log.js";

// In lookupSingle, wrap from searchByName through tracker:
const result = await withLogContext("eid-lookup", nameInput, async () => {
  return await searchByName(page, nameInput);
});

// In lookupParallel worker, wrap the per-name block:
await withLogContext("eid-lookup", nameInput, async () => {
  const result = await searchByName(workerPage, nameInput);
  // ... existing result handling + tracker writes
});

// In lookupWithCrm, wrap from UCPath search through cross-verify:
await withLogContext("eid-lookup", nameInput, async () => {
  // ... existing search + cross-verify logic
});
```

- [ ] **Step 4: Wrap kronos reports worker loop**

In `src/workflows/old-kronos-reports/parallel.ts`, around line 205:

```typescript
import { withLogContext } from "../../utils/log.js";

// Wrap the runKronosForEmployee call:
await withLogContext("kronos-reports", employeeId, () =>
  runKronosForEmployee(employeeId, {
    page,
    dateRangeSet: true,
    updateTrackerFn: lockedTracker,
    reportLock: reportMutex,
    logPrefix: prefix,
  }),
);
```

- [ ] **Step 5: Wrap work-study workflow**

In `src/workflows/work-study/workflow.ts`, wrap the body of `runWorkStudy`:

```typescript
import { withLogContext } from "../../utils/log.js";

export async function runWorkStudy(input: WorkStudyInput, options: WorkStudyOptions = {}): Promise<void> {
  startDashboard("work-study");
  await withLogContext("work-study", input.emplId, async () => {
    // ... existing function body
  });
}
```

- [ ] **Step 6: Wrap separations workflow**

In `src/workflows/separations/workflow.ts`, wrap the body of `runSeparation`:

```typescript
import { withLogContext } from "../../utils/log.js";

export async function runSeparation(docId: string, options: SeparationOptions = {}): Promise<SeparationResult> {
  return await withLogContext("separations", docId, async () => {
    // ... existing function body
  });
}
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/workflows/*/workflow.ts src/workflows/*/parallel.ts
git commit -m "feat: wire withLogContext into all workflow entry points"
```

---

## Task 3: Enhanced Logging at Decision Points

**Files:**
- Modify: `src/auth/duo-poll.ts`
- Modify: `src/auth/sso-fields.ts`
- Modify: `src/kuali/navigate.ts`
- Modify: `src/ucpath/transaction.ts`
- Modify: `src/workflows/onboarding/extract.ts`
- Modify: `src/workflows/eid-lookup/search.ts`
- Modify: `src/workflows/separations/workflow.ts`
- Modify: `src/old-kronos/reports.ts`

- [ ] **Step 1: Enhance auth logging**

In `src/auth/sso-fields.ts`, after filling credentials:
```typescript
log.step(`SSO: username field matched via "${sel.usernameLabels[0]}" label`);
```

In `src/auth/duo-poll.ts`, inside the `pollDuoApproval` loop, add after the recovery call:
```typescript
if (options.recovery) {
  log.step("Duo: checking for mid-auth recovery conditions...");
  await options.recovery(page).catch(() => {});
}
```

And after the trust button click:
```typescript
log.step('Duo: clicked "Yes, this is my device" trust button');
```

- [ ] **Step 2: Enhance Kuali logging**

In `src/kuali/navigate.ts`, read the file first, then add reasoning logs at these points:

After extracting separation data:
```typescript
log.step(`Kuali extraction: Employee="${employeeName}", EID="${eid}", SepDate="${separationDate}", Type="${terminationType}"`);
```

In `mapTerminationToUCPathReason` or where it's called:
```typescript
log.step(`Reason code: Kuali type "${terminationType}" → UCPath reason "${reasonCode}"`);
```

In department matching:
```typescript
log.step(`Department: searching for "${opts.department}" — best match: "${bestMatch || "NONE"}"`);
```

- [ ] **Step 3: Enhance UCPath transaction logging**

In `src/ucpath/transaction.ts`, read the file first, then add at key points:

After template selection:
```typescript
log.step(`Template: "${templateId}" selected for this transaction type`);
```

After reason code selection:
```typescript
log.step(`Reason: "${reasonCode}" selected from dropdown`);
```

After comp rate code fill (where fallback indices are tried):
```typescript
log.step(`Comp Rate Code: filled "${compRateCode}" at grid index ${idx}`);
```

After compensation rate fill:
```typescript
log.step(`Compensation Rate: filled "$${rate}" at grid index ${idx}`);
```

- [ ] **Step 4: Enhance onboarding extract logging**

In `src/workflows/onboarding/extract.ts`, read the file first. In the field extraction loop, after each successful extraction:
```typescript
log.step(`CRM field "${fieldKey}": matched label "${matchedLabel}" → value "${value}"`);
```

- [ ] **Step 5: Enhance EID lookup search logging**

In `src/workflows/eid-lookup/search.ts`, read the file first, then add:

After name search returns results:
```typescript
log.step(`Search: "${nameInput}" returned ${allResults.length} total → ${sdcmpResults.length} after SDCMP/HDH filter`);
```

If fallback search is triggered:
```typescript
log.step(`Search fallback: full name returned 0 — trying first-only "${firstName}"`);
```

- [ ] **Step 6: Enhance separations workflow logging**

In `src/workflows/separations/workflow.ts`, read the file first, then add:

Template selection:
```typescript
log.step(`Template: "${template}" — ${isInvoluntary ? "involuntary" : "voluntary"} termination (type: "${terminationType}")`);
```

Termination date computation:
```typescript
log.step(`Termination date: ${termDate} = separation date ${sepDate} + 1 day`);
```

Kronos date resolution (where old/new kronos dates are compared):
```typescript
log.step(`Kronos dates: Old="${oldDate || "none"}", New="${newDate || "none"}" — using ${chosen}`);
```

- [ ] **Step 7: Enhance kronos reports logging**

In `src/old-kronos/reports.ts`, read the file first, then add:

Report polling status:
```typescript
log.step(`Report: row ${trId} status "${statusText}" (attempt ${attempt}/${maxAttempts})`);
```

PDF validation:
```typescript
log.step(`PDF: ${fileSize} bytes, name check: expected "${expectedName}" vs PDF "${pdfName}" — ${match ? "MATCH" : "MISMATCH"}`);
```

Download method:
```typescript
log.step(`Download: captured via ${method} — saved to "${filePath}"`);
```

- [ ] **Step 8: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/auth/ src/kuali/ src/ucpath/ src/workflows/ src/old-kronos/
git commit -m "feat: add reasoning context to ~30 key logging decision points"
```

---

## Task 4: Dashboard Rewrite — DOM Diffing, Fixed Tabs, Log Panel

**Files:**
- Modify: `src/tracker/dashboard.ts`

This is the largest task. The dashboard HTML/CSS/JS gets a complete rewrite with three goals: no flickering (DOM diffing), fixed tab order, and a row-click log panel.

- [ ] **Step 1: Rewrite the dashboard server endpoints**

In `src/tracker/dashboard.ts`, add the log streaming endpoints. Read the current file first. Add these routes to the server `createServer` handler:

```typescript
// Add to the server handler, before the HTML route:
if (url.pathname === "/api/logs") {
  const wf = url.searchParams.get("workflow") ?? workflow;
  const id = url.searchParams.get("id") ?? "";
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(readLogEntries(wf, id || undefined)));
  return;
}

if (url.pathname === "/events/logs") {
  const wf = url.searchParams.get("workflow") ?? workflow;
  const id = url.searchParams.get("id") ?? "";
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  let lastCount = 0;
  const send = () => {
    const entries = readLogEntries(wf, id || undefined);
    if (entries.length > lastCount) {
      const newEntries = entries.slice(lastCount);
      res.write(`data: ${JSON.stringify(newEntries)}\n\n`);
      lastCount = entries.length;
    }
  };
  send();
  const interval = setInterval(send, 500);
  req.on("close", () => clearInterval(interval));
  return;
}
```

Also add `readLogEntries` to the imports from `./jsonl.js`.

- [ ] **Step 2: Rewrite the dashboard HTML with DOM diffing**

Replace the entire `getDashboardHtml` function. The key changes in the JavaScript:

**DOM Diffing** — replace `tbody.innerHTML = ...` with:
```javascript
function diffTable(rows) {
  const tbody = document.getElementById('tbody');
  const existingRows = new Map();
  for (const tr of tbody.querySelectorAll('tr[data-id]')) {
    existingRows.set(tr.dataset.id, tr);
  }

  const newIds = new Set(rows.map(r => r.id));

  // Remove rows no longer present
  for (const [id, tr] of existingRows) {
    if (!newIds.has(id)) {
      tr.style.opacity = '0';
      setTimeout(() => tr.remove(), 200);
    }
  }

  // Update or insert rows
  rows.forEach((r, i) => {
    const existing = existingRows.get(r.id);
    if (existing) {
      // Update only changed cells
      updateRowCells(existing, r);
    } else {
      // Insert new row
      const tr = createRow(r, i);
      tbody.appendChild(tr);
    }
  });
}
```

**Fixed tab order**:
```javascript
const TAB_ORDER = ['onboarding', 'separations', 'kronos-reports', 'eid-lookup', 'work-study'];

function renderTabs(workflows) {
  const ordered = TAB_ORDER.filter(w => workflows.includes(w));
  const extra = workflows.filter(w => !TAB_ORDER.includes(w));
  const all = [...ordered, ...extra];
  // render tabs in this fixed order — never reorder
}
```

**Remove logo** — replace the logo section:
```html
<div class="logo">
  <div class="logo-text">HR Automation<span>Control</span></div>
</div>
```

**Row-click log panel**:
```javascript
let expandedId = null;
let logEventSource = null;

function toggleLogPanel(rowId, workflow) {
  // Close existing panel
  const existing = document.getElementById('log-panel');
  if (existing) existing.remove();
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
  if (expandedId === rowId) { expandedId = null; return; }

  expandedId = rowId;
  const clickedRow = document.querySelector(`tr[data-id="${CSS.escape(rowId)}"]`);
  if (!clickedRow) return;

  // Create log panel row
  const panelRow = document.createElement('tr');
  panelRow.id = 'log-panel';
  panelRow.innerHTML = '<td colspan="99" class="log-panel-cell"><div class="log-panel"><div class="log-header">Logs: ' + escHtml(rowId) + '<button onclick="toggleLogPanel(\\'\\')">×</button></div><div class="log-entries" id="logEntries"></div></div></td>';
  clickedRow.after(panelRow);

  // Connect SSE for this item's logs
  logEventSource = new EventSource('/events/logs?workflow=' + encodeURIComponent(workflow) + '&id=' + encodeURIComponent(rowId));
  logEventSource.onmessage = (e) => {
    const entries = JSON.parse(e.data);
    const container = document.getElementById('logEntries');
    if (!container) return;
    for (const entry of entries) {
      const div = document.createElement('div');
      div.className = 'log-line log-' + entry.level;
      const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      div.innerHTML = '<span class="log-ts">' + time + '</span><span class="log-icon">' + levelIcon(entry.level) + '</span><span class="log-msg">' + escHtml(entry.message) + '</span>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }
  };
}
```

**Log panel CSS**:
```css
.log-panel-cell { padding: 0 !important; border-top: none !important; }
.log-panel {
  background: #0a0d13; border: 1px solid #1b2130; border-radius: 0 0 8px 8px;
  margin: 0 8px 8px; overflow: hidden;
}
.log-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; background: #0f1219;
  font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-2);
  border-bottom: 1px solid #1b2130;
}
.log-header button {
  background: none; border: none; color: var(--text-3); cursor: pointer;
  font-size: 1.1rem; padding: 2px 6px; border-radius: 4px;
}
.log-header button:hover { background: var(--bg-hover); color: var(--text-1); }
.log-entries {
  max-height: 400px; overflow-y: auto; padding: 8px 0;
  font-family: var(--font-mono); font-size: 0.76rem; line-height: 1.7;
}
.log-line {
  padding: 2px 16px; display: flex; gap: 10px; align-items: baseline;
  animation: logIn 0.15s ease both;
}
.log-line:hover { background: rgba(255,255,255,0.02); }
@keyframes logIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.log-ts { color: var(--text-3); flex-shrink: 0; font-size: 0.7rem; }
.log-icon { flex-shrink: 0; width: 16px; text-align: center; }
.log-msg { color: var(--text-2); word-break: break-word; }
.log-step .log-icon { color: #58a6ff; }
.log-success .log-icon { color: #3fb950; }
.log-success .log-msg { color: #3fb950; }
.log-error .log-icon { color: #f85149; }
.log-error .log-msg { color: #f85149; }
.log-waiting .log-icon { color: #d29922; }
.log-waiting .log-msg { color: #d29922; }
```

- [ ] **Step 3: Add clickable row handling**

Each table row gets `data-id` attribute and click handler:
```javascript
function createRow(r, i) {
  const tr = document.createElement('tr');
  tr.dataset.id = r.id;
  tr.style.cursor = 'pointer';
  tr.onclick = () => toggleLogPanel(r.id, activeWf);
  // ... populate cells
  return tr;
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts src/tracker/jsonl.ts
git commit -m "feat: dashboard rewrite — DOM diffing, fixed tabs, row-click log panel"
```

---

## Task 5: Demo Script with Log Entries

**Files:**
- Modify: `src/scripts/demo-dashboard.ts`

- [ ] **Step 1: Add demo log entries**

Read the current demo script. After the seed data section, add log entries that simulate what a real workflow run would produce:

```typescript
import { appendLogEntry } from "../tracker/jsonl.js";

// Simulate logs for the first onboarding employee
const demoLogs = [
  { level: "step" as const, message: "Authenticating to ACT CRM..." },
  { level: "step" as const, message: "SSO: username field matched via \"User name (or email address)\" label" },
  { level: "step" as const, message: "Filling SSO credentials..." },
  { level: "step" as const, message: "SSO submit clicked" },
  { level: "waiting" as const, message: "Waiting for Duo approval (approve on your phone)..." },
  { level: "success" as const, message: "Duo MFA approved — authenticated" },
  { level: "success" as const, message: "ACT CRM authenticated" },
  { level: "step" as const, message: "Searching CRM: jsmith@ucsd.edu" },
  { level: "step" as const, message: "CRM field \"positionNumber\": matched label \"Position #\" → value \"00054321\"" },
  { level: "step" as const, message: "CRM field \"firstName\": matched label \"First Name\" → value \"John\"" },
  { level: "step" as const, message: "CRM field \"lastName\": matched label \"Last Name\" → value \"Smith\"" },
  { level: "step" as const, message: "CRM field \"wage\": matched label \"Compensation Rate\" → value \"18.50\"" },
  { level: "step" as const, message: "CRM field \"effectiveDate\": matched label \"First Day of Service\" → value \"04/15/2026\"" },
  { level: "step" as const, message: "CRM field \"ssn\": matched label \"SSN (National ID)\" → value \"***-**-4567\"" },
  { level: "success" as const, message: "CRM extraction complete (14 fields)" },
  { level: "step" as const, message: "Authenticating to UCPath..." },
  { level: "waiting" as const, message: "Waiting for Duo approval (approve on your phone)..." },
  { level: "success" as const, message: "Duo MFA approved — authenticated" },
  { level: "step" as const, message: "Person search: SSN ending 4567" },
  { level: "step" as const, message: "No existing record found — new hire (not rehire)" },
  { level: "step" as const, message: "Template: \"UC_FULL_HIRE\" selected for this transaction type" },
  { level: "step" as const, message: "Effective Date: 04/15/2026" },
  { level: "step" as const, message: "Reason: \"Hire - No Prior UC Affiliation\" selected from dropdown" },
  { level: "step" as const, message: "Filling Personal Data: John Smith, DOB: 01/15/2004" },
  { level: "step" as const, message: "Phone: Mobile-Personal (555) 123-4567 — set as preferred" },
  { level: "step" as const, message: "Email: Home jsmith@ucsd.edu" },
  { level: "step" as const, message: "Comp Rate Code: filled \"UCHRLY\" at grid index 0 (hourly)" },
  { level: "step" as const, message: "Compensation Rate: filled \"$18.50\" at grid index 0" },
  { level: "step" as const, message: "Expected Job End Date: 06/30/2026" },
  { level: "success" as const, message: "Transaction saved and submitted — Transaction ID: T0084521" },
];

for (let i = 0; i < demoLogs.length; i++) {
  const entry = demoLogs[i];
  appendLogEntry({
    workflow: "onboarding",
    itemId: "jsmith@ucsd.edu",
    level: entry.level,
    message: entry.message,
    ts: new Date(Date.now() - (demoLogs.length - i) * 2000).toISOString(),
  });
}

// Add a few logs for a running employee too
const runningLogs = [
  { level: "step" as const, message: "Authenticating to ACT CRM..." },
  { level: "success" as const, message: "ACT CRM authenticated" },
  { level: "step" as const, message: "Searching CRM: fchen@ucsd.edu" },
  { level: "step" as const, message: "CRM field \"positionNumber\": matched label \"Position Number\" → value \"00067890\"" },
  { level: "step" as const, message: "CRM extraction complete (14 fields)" },
  { level: "step" as const, message: "Person search: SSN ending 8901" },
];

for (let i = 0; i < runningLogs.length; i++) {
  appendLogEntry({
    workflow: "onboarding",
    itemId: "fchen@ucsd.edu",
    level: runningLogs[i].level,
    message: runningLogs[i].message,
    ts: new Date(Date.now() - (runningLogs.length - i) * 3000).toISOString(),
  });
}

// Add logs for a failed employee
appendLogEntry({
  workflow: "onboarding",
  itemId: "epatel@ucsd.edu",
  level: "step",
  message: "Searching CRM: epatel@ucsd.edu",
  ts: ago(9),
});
appendLogEntry({
  workflow: "onboarding",
  itemId: "epatel@ucsd.edu",
  level: "error",
  message: "CRM record not found — no active onboarding record for this email",
  ts: ago(8),
});
```

- [ ] **Step 2: Run the demo**

Run: `node --import tsx/esm src/scripts/demo-dashboard.ts`
Open http://localhost:3838
Click on "jsmith@ucsd.edu" row — verify log panel opens with 30 log entries
Click on "fchen@ucsd.edu" row — verify 6 running logs
Click on "epatel@ucsd.edu" row — verify 2 logs (search + error)

- [ ] **Step 3: Commit**

```bash
git add src/scripts/demo-dashboard.ts
git commit -m "feat: demo script with realistic per-item log entries"
```

---

## Verification Plan

1. **After Task 1**: `npm run typecheck && npm test` — log context tests pass
2. **After Task 2**: `npm run typecheck` — all workflow wrappers compile
3. **After Task 3**: `npm run typecheck` — enhanced log calls compile
4. **After Task 4**: Launch demo, verify:
   - Table does NOT flicker on 1-second refresh
   - Tabs stay in fixed order when clicking between them
   - No H logo in header
   - Click any row → log panel expands below with scrollable entries
   - Click same row → panel collapses
   - Click different row → panel switches
5. **After Task 5**: Launch demo, click rows, verify realistic log streams appear
6. **Final**: Run any real workflow (dry-run), open dashboard, click a row, verify live logs stream in
