# Logging Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add targeted, structured logs at the failure points that ate time during today's runs (2026-04-20) so future breakages self-diagnose.

**Architecture:** Stay on the existing `src/utils/log.ts` API (`log.step`, `log.success`, `log.waiting`, `log.warn`, `log.error`) — **extended with a new `log.debug`** (Phase 0). Additions are at specific code sites where observability is missing. One new shared helper: `classifyPlaywrightError` in `src/utils/errors.ts`. Each task is one commit.

**Tech Stack:** TypeScript, existing `log` helper from `src/utils/log.ts`, AsyncLocalStorage-backed runId.

**Reference spec:** (this plan is standalone; it does not have a brainstorming-produced spec — the rationale is in the README section below.)

**Related plan:** `docs/superpowers/plans/2026-04-21-stability-polish-plan.md` — some behavioral fixes in that plan pair with logging additions here. Order: land stability-polish first where there's overlap (e.g. `waitForSaveEnabled` already adds Save-state logging), then this plan fills the remaining gaps.

---

## Why these additions (not "log more everywhere")

Rules of thumb applied:

1. **Log decisions, not narration.** "Clicking Save" isn't useful — we know we clicked Save. "Save enabled after 2 tab visits, 3.2 s wait" is useful.
2. **Log state at boundaries, not inside loops.** Dump the relevant state once at the step boundary; don't re-log every iteration.
3. **Prefer structured prefixes over prose.** `[Kuali fill] field=lastDayWorked value=04/15/2026 verified=true` beats "Filled last day worked with the value 04/15/2026 which was verified on readback."
4. **`log.debug` for diagnostic detail, `log.step` for user-visible progress.** Debug lands on disk; step shows in the dashboard.
5. **Never log SSNs or DOBs when redaction is active** — currently it isn't (user disabled), so this is moot, but new code should still use the `maskSsn`/`maskDob` pass-throughs for contract stability.

## Scope boundaries

**Out of scope:**
- Log aggregation / JSON log format changes
- External log sinks (Datadog, Loki, etc.)
- Adding log-level filters to the dashboard UI
- Retrofitting logs into every workflow — focus on separations, onboarding, ucpath, i9, kernel

**Covered in this plan:** 11 tasks across 5 phases.

---

## File Structure

### Modified
- `src/utils/log.ts` — add `log.debug` (Phase 0)
- `src/tracker/jsonl.ts` — extend `LogEntry["level"]` to include `"debug"` (Phase 0)
- `src/dashboard/components/types.ts` — mirror the type extension (Phase 0)
- `src/dashboard/components/LogLine.tsx` — render `"debug"` level with a dimmed prefix (Phase 0)
- `src/utils/errors.ts` — add `classifyPlaywrightError` (Phase 1)
- `src/systems/common/selector-helpers.ts` (or wherever `safeClick` / `safeFill` live) — log WHICH fallback matched (Phase 2)
- `src/systems/i9/create.ts` + `src/systems/i9/search.ts` — modal inventory log (Phase 3)
- `src/systems/ucpath/transaction.ts` — tab-walk state + Save readiness (Phase 3)
- `src/systems/ucpath/job-summary.ts` — pre-click page health (Phase 3)
- `src/workflows/separations/workflow.ts` — Phase 1 task boundary + data handoff logs (Phase 4)
- `src/workflows/onboarding/workflow.ts` — same (Phase 4)
- `src/core/session.ts` — auth attempt + launchFn error detail (Phase 5)
- `src/core/step-cache.ts` — miss context (Phase 5)

### Created
- `tests/unit/utils/log-debug.test.ts`
- `tests/unit/utils/classify-playwright-error.test.ts`
- `tests/unit/systems/common/selector-fallback-logging.test.ts`

---

## Phase 0 — Add `log.debug` + extend LogEntry level

`log.debug` doesn't exist yet. The current `log` API is `step / success / waiting / warn / error` (see `src/utils/log.ts:42-48`). Add it as a quiet level that always writes to JSONL but only prints to console when the `DEBUG` env var is set. This keeps CI-style runs uncluttered while giving diagnostic logs to post-mortem analysis.

### Task 0.1: Extend `LogEntry["level"]` to include `"debug"`

**Files:**
- Modify: `src/tracker/jsonl.ts` (LogEntry type)
- Modify: `src/dashboard/components/types.ts` (frontend mirror of LogEntry)

- [x] **Step 1: Find the LogEntry type definition in tracker**

Run: `grep -n "level:" src/tracker/jsonl.ts | head -10`

Find the `LogEntry` interface. Its `level` field is currently a union of string literals: `"step" | "success" | "error" | "waiting" | "warn"`.

- [x] **Step 2: Add `"debug"` to the union**

In `src/tracker/jsonl.ts`, extend the union:

```ts
export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  ts: string;
}
```

- [x] **Step 3: Mirror in dashboard types**

In `src/dashboard/components/types.ts`, apply the same extension to the `LogEntry` interface.

- [x] **Step 4: Typecheck**

Run: `npm run typecheck:all`

Expected: PASS. If any existing code asserts an exhaustive switch over `level`, it will need a `case "debug":` added — do that inline.

- [x] **Step 5: Commit (bundled with 0.2)**

Do not commit yet — bundled with Task 0.2's commit.

### Task 0.2: Implement `log.debug` with DEBUG env gating

**Files:**
- Modify: `src/utils/log.ts`
- Create: `tests/unit/utils/log-debug.test.ts`

- [x] **Step 1: Write failing test**

Create `tests/unit/utils/log-debug.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, withLogContext } from "../../../src/utils/log.js";

describe("log.debug", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "log-debug-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes to JSONL with level='debug' when inside a log context", async () => {
    await withLogContext("test-wf", "item-1", async () => {
      log.debug("hello debug");
    }, dir);

    const file = join(dir, "test-wf-" + new Date().toISOString().slice(0, 10) + "-logs.jsonl");
    assert.ok(existsSync(file), `expected JSONL file at ${file}`);
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const debugLines = parsed.filter((p) => p.level === "debug");
    assert.strictEqual(debugLines.length, 1);
    assert.strictEqual(debugLines[0].message, "hello debug");
  });

  it("does not throw when called outside a log context", () => {
    // No context set — should be a no-op for JSONL, just console
    assert.doesNotThrow(() => log.debug("no context"));
  });
});
```

- [x] **Step 2: Run test**

Run: `npm run test -- tests/unit/utils/log-debug.test.ts`

Expected: FAIL — `log.debug` not defined.

- [x] **Step 3: Implement `log.debug`**

In `src/utils/log.ts`, modify the `log` export:

```ts
const DEBUG_ENABLED = process.env.DEBUG === "true" || process.env.DEBUG === "1";

function emitDebug(msg: string): void {
  // Console: only when DEBUG env var is set — keep default console uncluttered
  if (DEBUG_ENABLED) {
    console.log(pc.gray("· " + msg));
  }
  // JSONL: always (if in a log context) — so retrospective analysis has the data
  const ctx = logStore.getStore();
  if (ctx) {
    appendLogEntry(
      {
        workflow: ctx.workflow,
        itemId: ctx.itemId,
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        level: "debug",
        message: msg,
        ts: new Date().toISOString(),
      },
      ctx.dir,
    );
  }
}

export const log = {
  step: (msg: string): void => emit("step", pc.blue("->"), msg),
  success: (msg: string): void => emit("success", pc.green("✓"), msg),
  waiting: (msg: string): void => emit("waiting", pc.yellow("⌛"), msg),
  warn: (msg: string): void => emit("warn", pc.yellow("!"), msg),
  error: (msg: string): void => emit("error", pc.red("✗"), msg, true),
  debug: (msg: string): void => emitDebug(msg),
};
```

The helper is named `emitDebug` (not reusing `emit`) because the console gating differs — only print to stdout when `DEBUG=true`.

- [x] **Step 4: Run test**

Run: `npm run test -- tests/unit/utils/log-debug.test.ts`

Expected: PASS (2/2).

- [x] **Step 5: Full tests + typecheck**

Run: `npm run typecheck:all && npm run test`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/utils/log.ts src/tracker/jsonl.ts src/dashboard/components/types.ts \
       tests/unit/utils/log-debug.test.ts
git commit -m "feat(log): log.debug — JSONL-always, console-gated on DEBUG env var"
```

### Task 0.3: Dashboard renders `"debug"` level with dimmed styling

**Files:**
- Modify: `src/dashboard/components/LogLine.tsx`

- [x] **Step 1: Read current LogLine level handling**

Run: `grep -n "level\|\"step\"\|\"success\"\|\"error\"\|\"warn\"" src/dashboard/components/LogLine.tsx`

Find where `level` is switched on.

- [x] **Step 2: Add debug case**

In `src/dashboard/components/LogLine.tsx`, wherever the level-to-icon/color mapping lives, add:

```tsx
// Inside the level switch (example — adjust to match existing shape):
if (level === "debug") {
  return {
    icon: ChevronRight,  // or another lucide-react icon, dimmed
    color: "text-muted-foreground/40",  // very dim
    category: "debug",
  };
}
```

If the component uses the pattern-based mapping from `src/dashboard/CLAUDE.md` log-icon table (`"step"` default → blue `ArrowRight`), handle debug as its own distinct case to prevent it from accidentally looking like a step.

- [x] **Step 3: Add "Debug" category filter tab (optional — defer if complex)**

If LogStream's filter tabs (`All / Errors / Auth / Fill / …`) are easy to extend, add a "Debug" tab. If not, skip — debug lines render in "All" only, muted, and that's fine.

- [x] **Step 4: Build dashboard**

Run: `npm run build:dashboard`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/dashboard/components/LogLine.tsx
git commit -m "feat(dashboard): render debug-level logs with dimmed styling"
```

---

## Phase 1 — Shared error classifier

### Task 1.1: `classifyPlaywrightError` helper

**Files:**
- Modify: `src/utils/errors.ts`
- Create: `tests/unit/utils/classify-playwright-error.test.ts`

- [x] **Step 1: Write failing test**

Create `tests/unit/utils/classify-playwright-error.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPlaywrightError } from "../../../src/utils/errors.js";

describe("classifyPlaywrightError", () => {
  it("classifies timeout-disabled when error mentions 'not enabled'", () => {
    const err = new Error("locator.click: Timeout 10000ms exceeded.\n  - element is not enabled");
    const result = classifyPlaywrightError(err);
    assert.strictEqual(result.kind, "timeout-disabled");
    assert.match(result.summary, /disabled/i);
  });

  it("classifies timeout-intercepted when subtree intercepts", () => {
    const err = new Error("locator.click: Timeout\n  - subtree intercepts pointer events");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-intercepted");
  });

  it("classifies timeout-hidden when element not visible", () => {
    const err = new Error("waitForSelector: Timeout\n  - element is not visible");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-hidden");
  });

  it("classifies timeout-stale for element detached", () => {
    const err = new Error("Element is no longer attached to the DOM");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-stale");
  });

  it("classifies navigation-interrupted", () => {
    const err = new Error("page.goto: net::ERR_ABORTED; frame was detached");
    assert.strictEqual(classifyPlaywrightError(err).kind, "navigation-interrupted");
  });

  it("classifies process-singleton", () => {
    const err = new Error("browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory");
    assert.strictEqual(classifyPlaywrightError(err).kind, "process-singleton");
  });

  it("returns generic 'timeout' for plain timeouts with no detail", () => {
    const err = new Error("locator.click: Timeout 10000ms exceeded.");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout");
  });

  it("returns 'unknown' for non-Playwright errors", () => {
    assert.strictEqual(classifyPlaywrightError(new Error("something else")).kind, "unknown");
    assert.strictEqual(classifyPlaywrightError(null).kind, "unknown");
    assert.strictEqual(classifyPlaywrightError(undefined).kind, "unknown");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/utils/classify-playwright-error.test.ts`

Expected: FAIL — export not defined.

- [x] **Step 3: Implement classifier**

In `src/utils/errors.ts`, add at the bottom:

```ts
export type PlaywrightErrorKind =
  | "timeout"
  | "timeout-disabled"
  | "timeout-hidden"
  | "timeout-intercepted"
  | "timeout-stale"
  | "navigation-interrupted"
  | "process-singleton"
  | "unknown";

export interface ClassifiedError {
  kind: PlaywrightErrorKind;
  summary: string;
  original: string;
}

/**
 * Classify a Playwright/browser automation error into a small kind-enum so
 * downstream logs + dashboards can group failures without string-matching
 * 2000-char error strings everywhere.
 */
export function classifyPlaywrightError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const lower = msg.toLowerCase();

  if (lower.includes("processsingleton")) {
    return { kind: "process-singleton", summary: "Chrome profile lock held by another process", original: msg };
  }
  if (lower.includes("no longer attached to the dom") || lower.includes("detached")) {
    return { kind: "timeout-stale", summary: "Element detached from DOM before action completed", original: msg };
  }
  if (lower.includes("err_aborted") || lower.includes("frame was detached") || lower.includes("navigation was aborted")) {
    return { kind: "navigation-interrupted", summary: "Navigation aborted mid-action", original: msg };
  }
  if (lower.includes("timeout")) {
    if (lower.includes("not enabled") || lower.includes("disabled")) {
      return { kind: "timeout-disabled", summary: "Element visible but disabled when timeout fired", original: msg };
    }
    if (lower.includes("intercepts pointer")) {
      return { kind: "timeout-intercepted", summary: "Another element intercepted the click (modal/overlay)", original: msg };
    }
    if (lower.includes("not visible") || lower.includes("hidden")) {
      return { kind: "timeout-hidden", summary: "Element never became visible", original: msg };
    }
    return { kind: "timeout", summary: "Generic timeout — no specific cause found in error body", original: msg };
  }

  return { kind: "unknown", summary: msg.slice(0, 120), original: msg };
}
```

- [x] **Step 4: Run test**

Run: `npm run test -- tests/unit/utils/classify-playwright-error.test.ts`

Expected: PASS (8/8).

- [x] **Step 5: Commit**

```bash
git add src/utils/errors.ts tests/unit/utils/classify-playwright-error.test.ts
git commit -m "feat(utils): classifyPlaywrightError — groups Playwright errors into diagnostic kinds"
```

---

## Phase 2 — Selector fallback disambiguation

`safeClick` / `safeFill` in `src/systems/common/` currently emit `selector fallback triggered: <label>` when primary + all fallbacks need trying. They do NOT log which specific fallback in the chain matched. Today this would have been useful for the Save button where grid index shifted from `$0$` to `$4$`.

### Task 2.1: Log which fallback level succeeded

**Files:**
- Modify: `src/systems/common/` (find the safeClick / safeFill file — likely `selector-helpers.ts` or `index.ts`)
- Create: `tests/unit/systems/common/selector-fallback-logging.test.ts`

- [x] **Step 1: Locate safeClick/safeFill**

Run: `grep -rn "selector fallback triggered" src/systems/common/`

Note the file + function.

- [x] **Step 2: Read the current implementation**

Run: `grep -n -B2 -A30 "function safeClick\|function safeFill" src/systems/common/*.ts`

Understand how fallbacks are tried (Playwright's `.or()` chain is internal to the Locator, so "which one matched" isn't directly introspectable — but we can log the attempt count that triggered before success).

- [x] **Step 3: Write failing test**

Create `tests/unit/systems/common/selector-fallback-logging.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Build a mock safeClick that records log messages.
// The real function is in src/systems/common/ — we exercise it via a fake
// Locator that rejects N times before succeeding.

import { safeClick } from "../../../../src/systems/common/index.js";

function fakeLocator(failsBefore: number) {
  let attempts = 0;
  return {
    click: async () => {
      attempts += 1;
      if (attempts <= failsBefore) throw new Error(`Timeout attempt ${attempts}`);
    },
    first: () => ({ click: async () => fakeLocator(failsBefore).click() }),
  } as never;
}

// Note: this test is a placeholder — real implementation needs to expose
// either a reporter callback or a per-attempt counter. If safeClick doesn't
// naturally track attempts, Step 4 adds that instrumentation.

describe.skip("safeClick fallback attempt logging", () => {
  it("records the attempt count at success", async () => {
    const logs: string[] = [];
    // TODO: plumb a logger override into safeClick for tests (Step 4).
  });
});
```

(Skipped until the implementation supports attempt-level callbacks. The real test is the observable behavior in integration runs.)

- [x] **Step 4: Instrument safeClick / safeFill**

In the common file, modify `safeClick`:

```ts
export async function safeClick(
  label: string,
  locator: Locator,
  opts: { timeout?: number } = {},
): Promise<void> {
  const start = Date.now();
  const timeout = opts.timeout ?? 10_000;

  // Single top-level try — Playwright's Locator.click handles the .or() chain
  // internally, so we don't see individual attempts. We DO log whether the
  // click landed quickly (<1s) or took time (>3s) to distinguish a primary-
  // selector hit from a fallback hit.
  try {
    await locator.click({ timeout });
    const elapsed = Date.now() - start;
    if (elapsed > 3_000) {
      log.warn(`selector fallback triggered: ${label} (click took ${elapsed}ms — primary likely missed, fallback matched)`);
    } else {
      log.debug(`${label}: clicked in ${elapsed}ms`);
    }
  } catch (e) {
    log.error(`${label}: click failed after ${Date.now() - start}ms — ${errorMessage(e)}`);
    throw e;
  }
}
```

Apply the same pattern to `safeFill`. The heuristic (>3 s ⇒ fallback likely) is imperfect but matches empirical Playwright behavior: primary selector resolutions complete in <500 ms; fallback chains exhaust the timeout on prior entries before matching.

- [x] **Step 5: Typecheck + existing tests**

Run: `npm run typecheck && npm run test -- tests/unit/systems/`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/systems/common/ tests/unit/systems/common/selector-fallback-logging.test.ts
git commit -m "feat(systems): log selector fallback timing — primary-vs-fallback inferred from click latency"
```

---

## Phase 3 — Pre-click page health + modal state

### Task 3.1: I9 — log `.k-window` inventory before critical clicks

**Files:**
- Modify: `src/systems/i9/navigate.ts` (add `snapshotKendoWindows`)
- Modify: `src/systems/i9/create.ts` (log before create click)
- Modify: `src/systems/i9/search.ts` (log before search-options click)

- [x] **Step 1: Add snapshotKendoWindows helper**

In `src/systems/i9/navigate.ts` (created/extended in stability-polish D.1 plan):

```ts
/**
 * Return a one-line summary of every visible Kendo k-window on the page.
 * Used diagnostically before clicks known to be blocked by stale modals
 * (e.g. "Create New I-9" on the dashboard after a search dialog).
 *
 * Example output: "k-windows=3 [1:'Search Employees',2:'',3:'Options']"
 */
export async function snapshotKendoWindows(page: Page): Promise<string> {
  return page.evaluate(() => {
    const windows = Array.from(document.querySelectorAll<HTMLElement>(".k-window")); // allow-inline-selector
    if (windows.length === 0) return "k-windows=0";
    const summaries = windows.map((w, i) => {
      const title = w.querySelector(".k-window-title")?.textContent?.trim().slice(0, 30) ?? "";
      const visible = w.offsetParent !== null;
      return `${i + 1}:'${title}'${visible ? "" : "-hidden"}`;
    });
    return `k-windows=${windows.length} [${summaries.join(",")}]`;
  }).catch(() => "k-windows=<evaluate-failed>");
}
```

- [x] **Step 2: Use it in create.ts**

In `src/systems/i9/create.ts`, before the create link click:

```ts
await closeAllKendoWindows(page);
log.debug(`I9 create — pre-click state: ${await snapshotKendoWindows(page)}`);
try {
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
} catch (e) {
  const classified = classifyPlaywrightError(e);
  log.warn(`I9 create — click blocked (${classified.kind}: ${classified.summary}) — state: ${await snapshotKendoWindows(page)}`);
  await closeAllKendoWindows(page);
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
}
```

Ensure `classifyPlaywrightError` is imported from `src/utils/errors.js`, and `snapshotKendoWindows` from `./navigate.js`.

- [x] **Step 3: Use it in search.ts**

In `src/systems/i9/search.ts`, before returning, add:

```ts
log.debug(`I9 search complete — post-parse state: ${await snapshotKendoWindows(page)}`);
await closeAllKendoWindows(page);
return parseSearchResults(page);
```

- [x] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/systems/i9/`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/i9/
git commit -m "feat(i9): log k-window inventory before critical clicks + use classifyPlaywrightError on retry"
```

### Task 3.2: UCPath transaction — log tab-walk progress

**Files:**
- Modify: `src/workflows/onboarding/enter.ts`

- [x] **Step 1: Grep for tab plan steps**

Run: `grep -n "tab.*click\|Personal Data\|Job Data\|Earns Dist\|Employee Experience" src/workflows/onboarding/enter.ts`

Find the `plan.add` entries for each tab.

- [x] **Step 2: Add per-tab state log**

After each tab click block in `enter.ts`, add (matching the existing log style):

```ts
await frame.getByRole("tab", { name: "Job Data" }).click({ timeout: 10_000 });
await page.waitForTimeout(3_000);
await waitForPeopleSoftProcessing(frame, 10_000);
log.step(`[TabWalk] Job Data loaded (tabs visited: Personal Data ✓, Job Data ✓)`);
```

Do this for each of the 4 tabs. On the final re-click of Personal Data, log:

```ts
log.step(`[TabWalk] Personal Data re-clicked — all 4 tabs visited, Save should now be enabled`);
```

- [x] **Step 3: Log Initiator Comments fill**

Find the `fillComments` call in `enter.ts`. After it:

```ts
log.step(`[TabWalk] Initiator Comments filled (${finalComments.length} chars)`);
```

- [x] **Step 4: Typecheck + smoke**

Run: `npm run typecheck && npm run build:dashboard`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/workflows/onboarding/enter.ts
git commit -m "feat(onboarding): log tab-walk progress — Save-disabled failures now self-explain"
```

### Task 3.3: UCPath Job Summary — pre-click page health log

**Files:**
- Modify: `src/systems/ucpath/job-summary.ts`

- [x] **Step 1: Read current extractWorkLocation**

Run: `grep -n "extractWorkLocation\|workLocationTab\|getFormRoot" src/systems/ucpath/job-summary.ts`

- [x] **Step 2: Add pre-click state dump**

Before the Work Location click (the site modified in stability-polish C.4):

```ts
const frameCount = await page.frames().then((fs) => fs.length);
const url = page.url();
const rootCountCheck = await root.count().catch(() => -1);
log.debug(`[Job Summary] pre-click state: url=${url} frames=${frameCount} root-matches=${rootCountCheck}`);

await waitForPeopleSoftProcessing(root as FrameLocator, 15_000).catch(() => {});
// existing clickOnce retry from stability-polish task C.4
```

- [x] **Step 3: On retry, log what changed**

Inside the catch, before calling `clickOnce` again:

```ts
} catch (e) {
  const classified = classifyPlaywrightError(e);
  log.warn(`[Job Summary] Work Location click flaked (${classified.kind}) — retrying. url=${page.url()}`);
  await page.waitForTimeout(2000);
  await waitForPeopleSoftProcessing(root as FrameLocator, 15_000).catch(() => {});
  await clickOnce();
}
```

- [x] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/systems/ucpath/`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/ucpath/job-summary.ts
git commit -m "feat(ucpath): log Job Summary page state (url, frames, root count) before Work Location click"
```

---

## Phase 4 — Workflow boundary + handoff logs

### Task 4.1: Separations — step timing + handoff logs

**Files:**
- Modify: `src/workflows/separations/workflow.ts`

- [x] **Step 1: Add a step-timing wrapper log**

At the top of each `ctx.step` callback in `src/workflows/separations/workflow.ts`, log entry. At the end, log exit with duration. Pattern:

```ts
const kualiData = await ctx.step("kuali-extraction", async () => {
  const t0 = Date.now();
  log.debug(`[Step: kuali-extraction] START docId=${docId}`);
  // ... existing body ...
  log.step(`[Step: kuali-extraction] END took=${Date.now() - t0}ms employeeName='${result.employeeName}' eid='${result.eid}'`);
  return result;
});
```

Apply to:
- `kuali-extraction` → log docId on entry; on exit, name + eid + dates
- `kronos-search` → log eid on entry; on exit, `oldK found=x`, `newK found=y`, `jobSummary ok=z`, `kualiTimekeeper ok=w`
- `ucpath-job-summary` → log dept + payroll filled
- `ucpath-transaction` → log entry (empl + template); on exit, txn # (or "<none>" if absent)
- `kuali-finalization` → log entry txn #; on exit, success

- [x] **Step 2: Log phase 1 task outcomes concretely**

In the phase1 result processing (~L285-304), replace the current error logs with classified variants. Before:

```ts
log.error(`[Old Kronos] Error: ${errorMessage(phase1.oldK.reason)}`);
```

After:

```ts
const classified = classifyPlaywrightError(phase1.oldK.reason);
log.error(`[Old Kronos] ${classified.kind}: ${classified.summary}`);
log.debug(`[Old Kronos] full error: ${errorMessage(phase1.oldK.reason)}`);
```

Same for `[New Kronos]`, `[UCPath Job Summary]`, `[Kuali Timekeeper]`.

- [x] **Step 3: Log transaction submit outcome in detail**

At line ~398 (after transactionNumber assignment):

```ts
transactionNumber = submitResult.transactionNumber ?? "";
log.step(
  `[UCPath Txn] submit result: success=${submitResult.success} txnNumber='${transactionNumber || "<empty>"}' `
  + `reasonMessage='${submitResult.error ?? "<none>"}'`
);
if (submitResult.success && !transactionNumber) {
  throw new Error("...");  // existing throw from stability-polish C.7
}
```

- [x] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/workflows/separations/`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/workflows/separations/workflow.ts
git commit -m "feat(separations): step boundary logs (entry/exit + handoff state) + classified phase 1 errors"
```

### Task 4.2: Onboarding — same treatment

**Files:**
- Modify: `src/workflows/onboarding/workflow.ts`

- [x] **Step 1: Apply step-timing pattern**

For each `ctx.step(...)` in `src/workflows/onboarding/workflow.ts`:
- `crm-auth` → log entry (email); exit (auth time)
- `extraction` → log entry (email, cache check result); exit (department#, position#, firstName+lastName, eid if available)
- `pdf-download` → entry; exit (file count)
- `ucpath-auth` → entry; exit (auth time)
- `person-search` → entry (SSN-last-4, DOB, name); exit (result: new-hire | rehire | duplicate, profileId if any)
- `i9-creation` → entry (existing profileId if any, or "creating new"); exit (new profileId)
- `transaction` → entry (template, effectiveDate); exit (txn # or "<failed at step: XXX>")

- [x] **Step 2: Classify errors in the transaction catch**

Find the catch block in onboarding's transaction step. Apply:

```ts
} catch (e) {
  const classified = classifyPlaywrightError(e);
  log.error(`[Transaction] ${classified.kind}: ${classified.summary}`);
  log.debug(`[Transaction] full error: ${errorMessage(e)}`);
  throw e;
}
```

- [x] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/workflows/onboarding/`

Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/workflows/onboarding/workflow.ts
git commit -m "feat(onboarding): step boundary + handoff logs + classified transaction errors"
```

---

## Phase 5 — Kernel / infra logs

### Task 5.1: Session.launch — auth retry visibility

**Files:**
- Modify: `src/core/session.ts`

- [x] **Step 1: Find auth retry loop**

Run: `grep -n "loginWithRetry\|attempt\|retry" src/core/session.ts`

There's a 3-attempt retry around login per `src/core/CLAUDE.md`.

- [x] **Step 2: Log attempt number + prior error**

In the retry loop body, add:

```ts
for (let attempt = 1; attempt <= 3; attempt++) {
  if (attempt > 1) {
    log.warn(`[Auth: ${systemId}] Retrying (attempt ${attempt}/3) — previous error: ${lastError ?? "unknown"}`);
  } else {
    log.step(`[Auth: ${systemId}] Starting login (attempt ${attempt}/3)`);
  }
  try {
    await login(page, instance);
    if (attempt > 1) {
      log.success(`[Auth: ${systemId}] Recovered on attempt ${attempt}`);
    }
    return;
  } catch (e) {
    lastError = errorMessage(e);
    // ... existing retry body ...
  }
}
```

Match whatever variable names the existing code uses; don't rename. Just add the logs.

- [x] **Step 3: Log ProcessSingleton specifically**

Find the launchBrowser / launchPersistentContext call site. Wrap in:

```ts
try {
  const { browser, context, page } = await launchBrowser({ ... });
  return { browser, context, page };
} catch (e) {
  const classified = classifyPlaywrightError(e);
  if (classified.kind === "process-singleton") {
    log.error(`[Session: ${systemId}] ProcessSingleton collision — another process holds the Chrome profile lock. pid=${process.pid} sessionDir='${sessionDir ?? "<ephemeral>"}'`);
  } else {
    log.error(`[Session: ${systemId}] launch failed: ${classified.kind} — ${classified.summary}`);
  }
  throw e;
}
```

Import `classifyPlaywrightError` from `../utils/errors.js`.

- [x] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/core/`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/core/session.ts
git commit -m "feat(core): log auth retry attempts + ProcessSingleton detail (pid + sessionDir)"
```

### Task 5.2: Step-cache — log miss context

**Files:**
- Modify: `src/core/step-cache.ts`

- [ ] **Step 1: Read current stepCacheGet**

Run: `grep -n "stepCacheGet\|fsp.readFile\|ENOENT" src/core/step-cache.ts`

- [ ] **Step 2: Add miss context log**

In the miss branch (file-not-exists / TTL-expired), add:

```ts
// On miss, log why so retries are introspectable
log.debug(`[StepCache] miss: workflow='${workflow}' itemId='${itemId}' step='${stepName}' reason='${missReason}'`);
```

Where `missReason` is one of `"no-file"`, `"ttl-expired-<hours>h"`, `"parse-error"`, `"path-unsafe"`.

Also log hits with file age:

```ts
const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
log.debug(`[StepCache] hit: workflow='${workflow}' itemId='${itemId}' step='${stepName}' age=${ageHours.toFixed(1)}h`);
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/core/step-cache*`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/step-cache.ts
git commit -m "feat(step-cache): log miss reason + hit age for retry debugging"
```

### Task 5.3: Batch/pool — worker assignment + queue depth

**Files:**
- Modify: `src/core/pool.ts`
- Modify: `src/core/workflow.ts` (runWorkflowBatch sequential mode)

- [ ] **Step 1: Log pool worker assignments**

In `src/core/pool.ts`, inside `worker()`:

```ts
async function worker(index: number): Promise<void> {
  log.step(`[Pool W${index}] Starting`);
  const session = await Session.launch(...);
  log.success(`[Pool W${index}] Session ready`);
  while (true) {
    const item = queue.shift();
    if (!item) break;
    const remaining = queue.length;
    log.step(`[Pool W${index}] Taking item (${remaining} remaining in queue)`);
    // ... process ...
  }
  log.step(`[Pool W${index}] Queue empty — exiting`);
}
```

- [ ] **Step 2: Log sequential batch progress**

In `src/core/workflow.ts`'s `runWorkflowBatch` sequential loop, find where each item starts and add:

```ts
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const itemId = deriveItemId(item);
  log.step(`[Batch] Item ${i + 1}/${items.length}: itemId='${itemId}'`);
  // ... existing body ...
}
```

And between items, log the reset duration:

```ts
if (i < items.length - 1 && wf.config.batch?.betweenItems?.includes("reset-browsers")) {
  const t0 = Date.now();
  await session.reset(itemId);
  log.step(`[Batch] Reset browsers (took ${Date.now() - t0}ms)`);
}
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/core/`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/pool.ts src/core/workflow.ts
git commit -m "feat(core): log pool worker assignments + sequential batch progress with reset timing"
```

---

## Phase 6 — Final verification

### Task 6.1: End-to-end smoke

- [ ] **Step 1: Full test suite**

```bash
npm run typecheck:all && npm run test
```

Expected: PASS.

- [ ] **Step 2: Log-sample inspection**

Start `npm run dashboard`, run a dry-run workflow:

```bash
npm run separation:dry 3917
```

Verify: step boundary logs appear; error classification works if failure simulated.

- [ ] **Step 3: Verify dashboard renders debug logs as expected**

Open the Log Stream for a run that executed with the new logging (or trigger a short dry-run to generate some). Verify:
- Debug-level log lines appear in the "All" tab with a dimmed icon + color per Task 0.3.
- Debug lines do NOT drown out step/success/error messages (they should be visually subordinate).
- If `DEBUG=true` is NOT set in the environment, debug lines still appear in the dashboard (JSONL-backed) but NOT in the terminal console.
- If `DEBUG=true` IS set, debug lines also appear in terminal (for live debugging).

---

## Out of scope (deferred)

- **JSON-structured logs.** Current format is free-form strings. Switching to JSON would enable machine-readable log aggregation but touches every call site. Parked.
- **Per-step attempt counters in stepper.** Right now retries happen inside Playwright or inside manual try/catches; the stepper doesn't know. Instrumenting the stepper to count retries per step is a larger change.
- **Log-level filter UI in the dashboard.** LogStream filters by category (Errors / Auth / Fill / etc.) not by log level. Adding a debug toggle is a dashboard feature; separate plan if needed.
- **Metrics (numeric time-series).** Logs are text; metrics want counters and histograms. No metrics today; adding them is its own project.

---

## Rollout order

1. **Phase 0** (log.debug + level extension) — prerequisite for all other phases.
2. **Phase 1** (classifier) — prerequisite for Phases 3/4/5.
3. **Phase 2** (selector fallback) — low risk, independent.
4. **Phase 3** (pre-click state) — depends on Phase 0 + Phase 1.
5. **Phase 4** (workflow boundary) — depends on Phase 0 + Phase 1.
6. **Phase 5** (kernel) — depends on Phase 0 + Phase 1.
7. **Phase 6** — manual verification.

Each phase lands as its commits; no branching. Typical phase = 1–3 commits.

## Success criteria

- Next time `HR_TBH_WRK_TBH_SAVE$4$` disabled fails, the log reads something like:
  `[TabWalk] Personal Data re-clicked — all 4 tabs visited, Save should now be enabled`
  then
  `[Save enabled wait] Button still disabled after 15s — tab walk incomplete (grid index $4$)`
- Next time I9 click is blocked, the log reads:
  `I9 create — pre-click state: k-windows=3 [1:'Search Employees',2:'',3:'Options']`
- Next time two separations collide, the log reads:
  `[Session: old-kronos] ProcessSingleton collision — another process holds the Chrome profile lock. pid=12345 sessionDir='/home/u/ukg_session_sep_pid12345'`
- Next time a step-cache miss happens, the log reads:
  `[StepCache] miss: workflow='separations' itemId='3917' step='kuali-extraction' reason='ttl-expired-3.2h'`
- Each separations/onboarding run emits a clear `[Step: X] END took=Yms …` summary per step, visible in the dashboard Log Stream's "All" tab.
