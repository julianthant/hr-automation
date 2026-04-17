# Subsystem A — Selector Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate every Playwright selector in the repo into a single `selectors.ts` file per system, under `src/systems/<system>/selectors.ts`. Move the three unmigrated per-system directories (`old-kronos`, `kuali`, `new-kronos`) under `src/systems/` so they sit alongside the already-migrated ones. Add a small shared helpers layer at `src/systems/common/` (modal dismiss + instrumented click/fill wrappers). Add an import-time guard that prevents new inline selectors from sneaking into callers. Update per-module CLAUDE.md files to point at the new registry. **Do NOT migrate `kronos-reports` or `separations` workflows to the kernel** — their handler code keeps its pre-kernel shape and only changes import paths.

**Architecture / Shape decision (from the sketch):**

- **Shape 1: functions that return Playwright Locators/FrameLocators.** We pass `page`/`frame`/`frameLocator` in, get a `Locator` back, then call `.click()` / `.fill()` / `.selectOption()` normally. No "selectors as data" resolver layer. Type inference stays native, IDE goto-def Just Works.
- **One `selectors.ts` per system.** UCPath's will be the largest (~50 selectors), but not so large that splitting into `selectors/smartHR.ts` + `selectors/personalData.ts` earns its keep. Per the sketch: "otherwise keep a single `selectors.ts` per system."
- **Grouped by page/flow within each file** (e.g. `ucpathSelectors.smartHR.templateInput`, `ucpathSelectors.personalData.legalFirstName`).
- **`.or()` fallback chains** where PeopleSoft grid IDs mutate on page refresh, or similar brittle anchors. Max 3-deep per sketch. Inline `// verified YYYY-MM-DD` comments preserving any original verified-date.
- **No live re-verification this session.** User can't approve Duo MFA for UCPath/CRM/Kuali. This is a **re-homing pass** — the source of truth is the current working `*.ts` files; every selector we lift comes with whatever verified-date the original carried (or today's date `2026-04-16` if none). The sketch explicitly sanctions this approach.
- **Shared cross-system helpers at `src/systems/common/`:**
  - `safeClick(locator, label)` / `safeFill(locator, value, label)` — logs `log.warn("selector fallback triggered: <label>")` when the primary locator path times out and the fallback branch of an `.or()` chain carries the click/fill. Best-effort only — no stalling.
  - `dismissPeopleSoftModalMask(page)` — hides the `#pt_modalMask` overlay that UCPath leaves visible between tab switches. Callers: UCPath transaction, emergency-contact. Consolidates the two copies currently living in `src/systems/ucpath/navigate.ts` (`dismissModalMask`) and `src/systems/ucpath/personal-data.ts` (`hidePeopleSoftModalMask`) — these do exactly the same JS eval with different function names. Keep old names as re-exports for migration-free source compat.
  - `waitForPeopleSoftProcessing(frame, timeoutMs)` — **stays in `src/systems/ucpath/`**. This helper is PeopleSoft-specific (targets `#processing`, `#WAIT_win0`, `.ps_box-processing`), used only by UCPath. Migrating it to `common/` would be premature abstraction since no other system uses those selectors. The sketch said "migrate to common only if it's genuinely reusable across systems" — it isn't.
  - **Old Kronos `dismissModal(page, iframe)`** is a different thing (clicks OK/Close buttons on iframe modals) — it stays in `src/systems/old-kronos/` under its current name. No shared helper candidate.
- **Instrumentation (`log.warn`):** `utils/log.ts` currently has no `warn` level. Add it as yellow `!` prefix, wired through the same `emit()` path so warns land in the JSONL log stream. This is a one-line addition.

**Tech Stack:** TypeScript (NodeNext ESM — `.js` import extensions), Playwright, `node:test` runner.

**Scope / Boundaries:**

- In scope: moving selectors into registries; creating `src/systems/common/`; import-guard test; per-module CLAUDE.md updates; root CLAUDE.md `## Selector Registry` section.
- Out of scope: kernel-migrating `kronos-reports` or `separations`; modifying `src/core/`; subsystem D (dashboard richness) or C (CLAUDE.md conventions); live re-verification of any selector; rewriting callers beyond import-path adjustments.

**Known deviations from the sketch (sanctioned here, documented per-task where they apply):**

1. **Sketch talks about `log.warn` as if it exists; it doesn't.** We add it as part of Task 4.
2. **Sketch's list of common helpers includes `waitForPeopleSoftProcessing` "already exists; stays".** It does exist — in `src/systems/ucpath/` — and since only UCPath uses it, we leave it there rather than moving it to `common/`. This is a narrower read of "migrate to common only if it's genuinely reusable" than the sketch wrote literally, but matches its intent.
3. **Old Kronos `dismissModal` is NOT moved to common.** It's iframe-button-click based, has per-call `iframe` arg, and isn't PeopleSoft-modal-mask semantics. Different function under the same name = footgun. Stays in `src/systems/old-kronos/`.
4. **CRM / I9 / Kuali / Old Kronos / New Kronos selectors** generally don't have grid-index mutation issues — they're `getByRole()` / CSS-based. Those systems get a registry file but mostly zero `.or()` chains, because the existing selectors are already robust. We add `.or()` only where the source code actually had a fallback (UCPath grid inputs, Kuali save button, New Kronos goto menu).
5. **Inline-selectors guard is a unit test, not an ESLint rule.** Sketch suggests either; test is faster to land, doesn't require adding ESLint to this repo, and runs as part of `npm test`.

---

## File Structure

### Final target tree

```
src/systems/
  common/
    index.ts              ← barrel
    modal.ts              ← dismissPeopleSoftModalMask (+ legacy alias re-exports)
    safe.ts               ← safeClick, safeFill wrappers
  ucpath/
    CLAUDE.md
    action-plan.ts
    index.ts
    job-summary.ts
    navigate.ts
    personal-data.ts
    selectors.ts          ← NEW: all UCPath selectors
    transaction.ts
    types.ts
  crm/
    (existing) + selectors.ts
  i9/
    (existing) + selectors.ts
  old-kronos/             ← moved from src/old-kronos/
    CLAUDE.md
    index.ts
    navigate.ts
    reports.ts
    selectors.ts          ← NEW
    types.ts
  kuali/                  ← moved from src/kuali/
    CLAUDE.md
    index.ts
    navigate.ts
    selectors.ts          ← NEW
  new-kronos/             ← moved from src/new-kronos/
    CLAUDE.md
    index.ts
    navigate.ts
    selectors.ts          ← NEW

tests/unit/systems/
  common/                 ← NEW
    safe.test.ts
  inline-selectors.test.ts  ← NEW: import-time guard test
  old-kronos/             ← migrated (if any tests exist — none today)
  kuali/                  ← migrated (if any tests exist — none today)
  new-kronos/             ← migrated (if any tests exist — none today)
```

### Import site audit (pre-verified via grep)

Files that import from `../../old-kronos/*` or `../old-kronos/*`:
- `src/cli.ts` (one reference — via `runParallelKronos` not directly)  ← actually goes through workflow barrel, not `old-kronos/`
- `src/workflows/separations/workflow.ts`
- `src/workflows/separations/explore-kronos.ts`
- `src/workflows/old-kronos-reports/workflow.ts`
- `src/workflows/old-kronos-reports/parallel.ts`
- `src/scripts/explore-kronos-selectors.ts`
- `src/scripts/test-kronos-timecard.ts`
- `src/scripts/kronos-map.ts`

Files that import from `../../kuali/*`:
- `src/workflows/separations/workflow.ts`

Files that import from `../../new-kronos/*` or `../new-kronos/*`:
- `src/workflows/separations/workflow.ts`
- `src/workflows/separations/explore-kronos.ts`
- `src/scripts/explore-kronos-selectors.ts`
- `src/scripts/test-kronos-timecard.ts`
- `src/scripts/kronos-map.ts`

No test files import any of these directly (confirmed via grep).

---

## Task 1: Rename `src/old-kronos/` → `src/systems/old-kronos/`

**Rationale:** First of three directory moves. Each one is a standalone commit for reviewability. Matches the pattern from earlier `src/ucpath → src/systems/ucpath` commit (`2c48e12` family).

**Files:**
- Move: `src/old-kronos/` → `src/systems/old-kronos/` via `git mv`
- Depth-adjust imports inside the moved files
- Update 5 consumer import sites (workflows/separations, workflows/old-kronos-reports, scripts)

- [ ] **Step 1: Move the directory**

```bash
git mv src/old-kronos src/systems/old-kronos
```

Verify: `git status -s` shows 5 renames (`CLAUDE.md`, `index.ts`, `navigate.ts`, `reports.ts`, `types.ts`) as `R  src/old-kronos/X -> src/systems/old-kronos/X`.

- [ ] **Step 2: Depth-adjust imports INSIDE `src/systems/old-kronos/`**

Run `rg -n '"\.\./' src/systems/old-kronos/` to find all upward-path imports. Expect 3 files.

Apply via Edit tool `replace_all: true` to `src/systems/old-kronos/navigate.ts`:
- `"../utils/log.js"` → `"../../utils/log.js"`
- `"../utils/screenshot.js"` → `"../../utils/screenshot.js"`
- `"../auth/login.js"` → `"../../auth/login.js"`
- Note the `await import("../config.js")` inside `goBackToMain` — change to `await import("../../config.js")`.

Apply to `src/systems/old-kronos/reports.ts`:
- `"../utils/log.js"` → `"../../utils/log.js"`
- `"../utils/screenshot.js"` → `"../../utils/screenshot.js"`
- `"../config.js"` → `"../../config.js"`

Verify: `rg -n '"\.\./' src/systems/old-kronos/` should return only `"../../..."` hits after this step.

- [ ] **Step 3: Update 5 consumer import sites**

For each of the following files, use Edit tool `replace_all: true`.

`src/workflows/separations/workflow.ts`:
- `from "../../old-kronos/index.js"` → `from "../../systems/old-kronos/index.js"`

`src/workflows/separations/explore-kronos.ts`:
- `from "../../old-kronos/index.js"` → `from "../../systems/old-kronos/index.js"`

`src/workflows/old-kronos-reports/workflow.ts`:
- `from "../../old-kronos/index.js"` → `from "../../systems/old-kronos/index.js"`
- `from "../../old-kronos/reports.js"` → `from "../../systems/old-kronos/reports.js"`

`src/workflows/old-kronos-reports/parallel.ts`:
- `from "../../old-kronos/index.js"` → `from "../../systems/old-kronos/index.js"`

`src/scripts/explore-kronos-selectors.ts`:
- `from "../old-kronos/index.js"` → `from "../systems/old-kronos/index.js"`

`src/scripts/test-kronos-timecard.ts`:
- `from "../old-kronos/index.js"` → `from "../systems/old-kronos/index.js"`

`src/scripts/kronos-map.ts`:
- `from "../old-kronos/index.js"` → `from "../systems/old-kronos/index.js"`

Sanity check: `rg -n '"\.\./\.\./old-kronos|"\.\./old-kronos' src/ tests/` returns zero hits.

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

Expected: all three exit 0, 181/181 tests pass (no new tests in this task).

- [ ] **Step 5: Commit**

```bash
git add src/systems/old-kronos \
  src/workflows/separations/workflow.ts \
  src/workflows/separations/explore-kronos.ts \
  src/workflows/old-kronos-reports/workflow.ts \
  src/workflows/old-kronos-reports/parallel.ts \
  src/scripts/explore-kronos-selectors.ts \
  src/scripts/test-kronos-timecard.ts \
  src/scripts/kronos-map.ts
git commit -m "$(cat <<'EOF'
refactor(systems): rename src/old-kronos/ -> src/systems/old-kronos/

First of three per-system directory moves in subsystem A. Consumers
updated to import from "../../systems/old-kronos/" (or "../systems/"
from src/scripts/). Internal imports inside the moved dir bumped one
hop deeper.

Preparation for landing per-system selectors.ts registries.

Typecheck clean on both tsconfigs; 181/181 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rename `src/kuali/` → `src/systems/kuali/`

**Rationale:** Second of three directory moves. Same cadence as Task 1.

**Files:**
- Move: `src/kuali/` → `src/systems/kuali/` via `git mv`
- Depth-adjust imports inside moved files
- Update 1 consumer import site

- [ ] **Step 1: Move the directory**

```bash
git mv src/kuali src/systems/kuali
```

Verify: 3 renames (`CLAUDE.md`, `index.ts`, `navigate.ts`).

- [ ] **Step 2: Depth-adjust imports INSIDE `src/systems/kuali/`**

`src/systems/kuali/navigate.ts`:
- `"../utils/log.js"` → `"../../utils/log.js"`
- `"../browser/launch.js"` → `"../../browser/launch.js"`

Verify: `rg -n '"\.\./' src/systems/kuali/` only returns `"../../..."` hits.

- [ ] **Step 3: Update 1 consumer import site**

`src/workflows/separations/workflow.ts`:
- `from "../../kuali/index.js"` → `from "../../systems/kuali/index.js"` (occurs on lines 22 AND 23 — `replace_all: true`)

Sanity: `rg -n '"\.\./\.\./kuali' src/` returns zero.

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

181/181 pass.

- [ ] **Step 5: Commit**

```bash
git add src/systems/kuali src/workflows/separations/workflow.ts
git commit -m "$(cat <<'EOF'
refactor(systems): rename src/kuali/ -> src/systems/kuali/

Second of three per-system directory moves in subsystem A. Sole
consumer is src/workflows/separations/workflow.ts.

Typecheck clean on both tsconfigs; 181/181 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rename `src/new-kronos/` → `src/systems/new-kronos/`

**Rationale:** Third of three directory moves.

**Files:**
- Move: `src/new-kronos/` → `src/systems/new-kronos/` via `git mv`
- Depth-adjust imports inside the moved files
- Update 4 consumer import sites

- [ ] **Step 1: Move the directory**

```bash
git mv src/new-kronos src/systems/new-kronos
```

Verify: 3 renames (`CLAUDE.md`, `index.ts`, `navigate.ts`).

- [ ] **Step 2: Depth-adjust imports INSIDE `src/systems/new-kronos/`**

`src/systems/new-kronos/navigate.ts`:
- `"../utils/log.js"` → `"../../utils/log.js"`
- `"../utils/screenshot.js"` → `"../../utils/screenshot.js"`

- [ ] **Step 3: Update 4 consumer import sites**

`src/workflows/separations/workflow.ts`:
- `from "../../new-kronos/index.js"` → `from "../../systems/new-kronos/index.js"`

`src/workflows/separations/explore-kronos.ts`:
- `from "../../new-kronos/index.js"` → `from "../../systems/new-kronos/index.js"`

`src/scripts/explore-kronos-selectors.ts`:
- `from "../new-kronos/index.js"` → `from "../systems/new-kronos/index.js"`

`src/scripts/test-kronos-timecard.ts`:
- `from "../new-kronos/index.js"` → `from "../systems/new-kronos/index.js"`

`src/scripts/kronos-map.ts`:
- `from "../new-kronos/index.js"` → `from "../systems/new-kronos/index.js"`

Sanity: `rg -n '"\.\./\.\./new-kronos|"\.\./new-kronos' src/` returns zero.

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

181/181 pass.

- [ ] **Step 5: Commit**

```bash
git add src/systems/new-kronos \
  src/workflows/separations/workflow.ts \
  src/workflows/separations/explore-kronos.ts \
  src/scripts/explore-kronos-selectors.ts \
  src/scripts/test-kronos-timecard.ts \
  src/scripts/kronos-map.ts
git commit -m "$(cat <<'EOF'
refactor(systems): rename src/new-kronos/ -> src/systems/new-kronos/

Third of three per-system directory moves in subsystem A. Every
per-system dir now lives under src/systems/.

Typecheck clean on both tsconfigs; 181/181 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create `src/systems/common/` (shared helpers + instrumentation)

**Rationale:** Establish the shared helpers layer before per-system selector consolidation, so selector modules can depend on `safeClick`/`safeFill` on day 1.

Also adds `log.warn` to `src/utils/log.ts` (the sketch assumes it exists; it doesn't) so the wrapper instrumentation has a real logging channel.

**Files:**
- Create: `src/systems/common/index.ts`
- Create: `src/systems/common/modal.ts`
- Create: `src/systems/common/safe.ts`
- Modify: `src/utils/log.ts` — add `log.warn`
- Create: `tests/unit/systems/common/safe.test.ts`
- Modify: `src/systems/ucpath/navigate.ts` — re-export `dismissModalMask` from common (preserve API)
- Modify: `src/systems/ucpath/personal-data.ts` — re-export `hidePeopleSoftModalMask` from common (preserve API)

- [ ] **Step 1: Add `log.warn` to `src/utils/log.ts`**

Also widen `LogEntry["level"]` to include `"warn"`. Check `src/tracker/jsonl.ts` to see the `LogEntry` type, and confirm it uses a union — add `"warn"` there if it's a closed union (it is).

Peek at the current type:

```bash
rg -n "type LogEntry|LogEntry\s*=" src/tracker/jsonl.ts | head -5
```

Apply Edit in `src/tracker/jsonl.ts` to add `"warn"` to the union:
```typescript
// old:
level: "step" | "success" | "waiting" | "error";
// new:
level: "step" | "success" | "waiting" | "warn" | "error";
```

Apply Edit in `src/utils/log.ts`:
```typescript
// old:
export const log = {
  step: (msg: string): void => emit("step", pc.blue("->"), msg),
  success: (msg: string): void => emit("success", pc.green("\u2713"), msg),
  waiting: (msg: string): void => emit("waiting", pc.yellow("\u231B"), msg),
  error: (msg: string): void => emit("error", pc.red("\u2717"), msg, true),
};
// new:
export const log = {
  step: (msg: string): void => emit("step", pc.blue("->"), msg),
  success: (msg: string): void => emit("success", pc.green("\u2713"), msg),
  waiting: (msg: string): void => emit("waiting", pc.yellow("\u231B"), msg),
  warn: (msg: string): void => emit("warn", pc.yellow("!"), msg),
  error: (msg: string): void => emit("error", pc.red("\u2717"), msg, true),
};
```

Typecheck after to surface any downstream consumer of `LogEntry["level"]` (likely none — it's a local type).

- [ ] **Step 2: Create `src/systems/common/modal.ts`**

```typescript
import type { Page } from "playwright";

/**
 * Hide PeopleSoft's `#pt_modalMask` overlay.
 *
 * PeopleSoft leaves this transparent mask visible between tab switches and
 * after some interactions, intercepting every click with "subtree intercepts
 * pointer events" and making Playwright retry forever. Hide it via JS before
 * any click that targets the iframe content.
 *
 * This is UCPath-specific (and the emergency-contact flow which uses UCPath's
 * HR Tasks page), but landed in `common/` because two call sites in
 * `src/systems/ucpath/` already duplicate this function. One home is better
 * than two.
 */
export async function dismissPeopleSoftModalMask(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const mask = document.getElementById("pt_modalMask");
      if (mask) mask.style.display = "none";
    })
    .catch(() => {});
}
```

- [ ] **Step 3: Create `src/systems/common/safe.ts`**

```typescript
import type { Locator } from "playwright";
import { log } from "../../utils/log.js";

export interface SafeActionOpts {
  /**
   * Short human-readable label for log output when a fallback branch carries
   * the action. Required — unlabeled instrumentation is worthless.
   */
  label: string;
  /** Playwright click/fill timeout. Default: 10_000ms. */
  timeout?: number;
}

/**
 * Click a locator and, on timeout, log a selector-fallback warning.
 *
 * Playwright's `.or()` chains evaluate lazily: the first successful match
 * wins the click. When ALL branches of an `.or()` chain time out, Playwright
 * throws a `TimeoutError`. We can't distinguish "primary took the click" from
 * "fallback took the click" at runtime from outside — Playwright doesn't
 * surface which branch matched.
 *
 * What we CAN detect: the click failed entirely. That's the signal worth
 * broadcasting — a fallback-chain click that raises TimeoutError means the
 * primary selector AND its fallbacks are all stale.
 *
 * We emit `log.warn("selector fallback triggered: <label>")` on timeout
 * BEFORE re-throwing the error, so dashboards and log streams capture the
 * label. Best-effort: if logging itself fails, we swallow and re-throw the
 * original timeout. No stall path.
 */
export async function safeClick(
  locator: Locator,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000 } = opts;
  try {
    await locator.click({ timeout });
  } catch (err) {
    try {
      log.warn(`selector fallback triggered: ${label}`);
    } catch {
      // instrumentation failure is never fatal
    }
    throw err;
  }
}

/**
 * Fill a locator and, on timeout, log a selector-fallback warning. See
 * `safeClick` for the semantics of this instrumentation.
 */
export async function safeFill(
  locator: Locator,
  value: string,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000 } = opts;
  try {
    await locator.fill(value, { timeout });
  } catch (err) {
    try {
      log.warn(`selector fallback triggered: ${label}`);
    } catch {
      // instrumentation failure is never fatal
    }
    throw err;
  }
}
```

- [ ] **Step 4: Create `src/systems/common/index.ts`**

```typescript
export { dismissPeopleSoftModalMask } from "./modal.js";
export { safeClick, safeFill } from "./safe.js";
export type { SafeActionOpts } from "./safe.js";
```

- [ ] **Step 5: Write unit tests for `safe.ts`**

Create `tests/unit/systems/common/safe.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeClick, safeFill } from "../../../../src/systems/common/safe.js";

/**
 * These tests use lightweight duck-typed fakes for Playwright's Locator
 * (just the `.click()` / `.fill()` methods we call). The real Locator API
 * surface is too broad and browser-dependent to mock in a unit test.
 */
function fakeLocator(behavior: {
  click?: () => Promise<void>;
  fill?: (v: string) => Promise<void>;
}): import("playwright").Locator {
  return {
    click: behavior.click ?? (async () => {}),
    fill: behavior.fill ?? (async () => {}),
    // other Locator methods unused in safe.ts
  } as unknown as import("playwright").Locator;
}

function captureWarns(fn: () => Promise<void>): Promise<string[]> {
  return (async () => {
    const origWarn = console.log; // log.warn → emit → console.log
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.join(" "));
    };
    try {
      await fn();
    } catch {
      // propagate later — we want to capture warns even when the action rejects
    }
    console.log = origWarn;
    return captured;
  })();
}

describe("safeClick", () => {
  it("returns undefined on success without logging a fallback warning", async () => {
    const loc = fakeLocator({ click: async () => {} });
    const logs = await captureWarns(() => safeClick(loc, { label: "test-primary" }));
    assert.equal(logs.filter((l) => l.includes("selector fallback")).length, 0);
  });

  it("logs a 'selector fallback triggered' warning on click timeout and re-throws", async () => {
    const err = new Error("TimeoutError: locator.click timed out");
    const loc = fakeLocator({
      click: async () => {
        throw err;
      },
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    let thrown: unknown;
    try {
      await safeClick(loc, { label: "comp-rate-code" });
    } catch (e) {
      thrown = e;
    } finally {
      console.log = origLog;
    }

    assert.equal(thrown, err, "original click error should be re-thrown");
    assert.ok(
      logs.some((l) => l.includes("selector fallback triggered: comp-rate-code")),
      "expected fallback-triggered warning in logs",
    );
  });
});

describe("safeFill", () => {
  it("returns undefined on success without logging", async () => {
    const loc = fakeLocator({ fill: async () => {} });
    const logs = await captureWarns(() => safeFill(loc, "v", { label: "any" }));
    assert.equal(logs.filter((l) => l.includes("selector fallback")).length, 0);
  });

  it("logs fallback warning and re-throws on fill timeout", async () => {
    const err = new Error("TimeoutError");
    const loc = fakeLocator({
      fill: async () => {
        throw err;
      },
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    let thrown: unknown;
    try {
      await safeFill(loc, "x", { label: "national-id" });
    } catch (e) {
      thrown = e;
    } finally {
      console.log = origLog;
    }

    assert.equal(thrown, err);
    assert.ok(
      logs.some((l) => l.includes("selector fallback triggered: national-id")),
    );
  });
});
```

Note: these tests exercise the logging path via `console.log` capture rather than a mock log module. The yellow `!` prefix goes through `console.log`, so capturing there is direct and doesn't require stubbing the `log` export.

- [ ] **Step 6: Consolidate UCPath's modal-mask helpers to re-export from common**

Edit `src/systems/ucpath/navigate.ts` (around line 53-61):

Remove the inline `dismissModalMask` implementation and replace with a re-export.

```typescript
// OLD:
export async function dismissModalMask(page: Page): Promise<void> {
  await page.evaluate(() => {
    const mask = document.getElementById("pt_modalMask");
    if (mask) mask.style.display = "none";
  });
}

// NEW:
// Legacy name alias — implementation lives in src/systems/common/modal.ts.
export { dismissPeopleSoftModalMask as dismissModalMask } from "../common/modal.js";
```

Edit `src/systems/ucpath/personal-data.ts` (around line 77-84):

```typescript
// OLD:
export async function hidePeopleSoftModalMask(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const mask = document.getElementById("pt_modalMask");
      if (mask) mask.style.display = "none";
    })
    .catch(() => {});
}

// NEW:
// Legacy name alias — implementation lives in src/systems/common/modal.ts.
export { dismissPeopleSoftModalMask as hidePeopleSoftModalMask } from "../common/modal.js";
```

Verify `src/systems/ucpath/index.ts` still re-exports `dismissModalMask` correctly — it does (line 8), and the re-export from navigate.ts now points at common.

- [ ] **Step 7: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

Expected: 181 + 4 new = 185 tests pass. Typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/systems/common \
  src/utils/log.ts \
  src/tracker/jsonl.ts \
  src/systems/ucpath/navigate.ts \
  src/systems/ucpath/personal-data.ts \
  tests/unit/systems/common/safe.test.ts
git commit -m "$(cat <<'EOF'
feat(systems): add src/systems/common with safeClick/safeFill + modal helper

Establishes the shared cross-system helpers layer per the subsystem A
sketch:
- safeClick/safeFill: instrumented wrappers that log.warn("selector
  fallback triggered: <label>") on Playwright timeout. Best-effort,
  never stalls; re-throws the original error.
- dismissPeopleSoftModalMask: single home for the UCPath modal-mask
  hide trick. Consolidates the two copies that lived in
  src/systems/ucpath/navigate.ts (dismissModalMask) and
  personal-data.ts (hidePeopleSoftModalMask); both names are preserved
  as re-export aliases.

Also adds log.warn (yellow `!` prefix) to utils/log.ts — the sketch
assumed it existed. LogEntry["level"] union widened to include "warn".

4 new unit tests for safe.ts. 185 total passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Consolidate UCPath selectors into `src/systems/ucpath/selectors.ts`

**Rationale:** UCPath is the largest system (~51 selectors per the sketch). The real grid-mutation pain lives here. Do it first so Tasks 6-10 (other systems) can follow the same pattern.

**Files:**
- Create: `src/systems/ucpath/selectors.ts`
- Modify: `src/systems/ucpath/navigate.ts` — import selectors from registry
- Modify: `src/systems/ucpath/transaction.ts` — import selectors from registry
- Modify: `src/systems/ucpath/personal-data.ts` — import selectors from registry
- Modify: `src/systems/ucpath/job-summary.ts` — import selectors from registry
- Modify: `src/systems/ucpath/index.ts` — re-export `ucpathSelectors`

- [ ] **Step 1: Create `src/systems/ucpath/selectors.ts`**

The registry is grouped by flow: `smartHR`, `personalData`, `jobData`, `jobSummary`, `personSearch`, `common` (page-level), plus `frame` helpers. Every grid-ID selector gets a 2-3 deep `.or()` chain preserving the existing fallbacks. Verified dates come from inline comments in the source files.

```typescript
import type { Page, Locator, FrameLocator } from "playwright";

/**
 * UCPath selector registry.
 *
 * Every selector used by src/systems/ucpath/*.ts lives here. Callers import
 * from this module rather than constructing locators inline. Each selector
 * is a function that takes the appropriate root (page / frame / FrameLocator)
 * and returns a Playwright Locator, so `.click()` / `.fill()` / `.selectOption()`
 * at the call site is unchanged.
 *
 * Fallback chains (`.or()`) are used where the underlying anchor is known to
 * mutate — specifically PeopleSoft grid input IDs (`$0` vs `$11` after a page
 * refresh). Preferred anchor first (accessible-name via `getByRole`), then
 * the grid-ID fallback, then the pre-refresh variant.
 *
 * Verified-date comments preserve the original in-source verification stamp.
 * This was a re-homing pass, not live re-verification — see
 * docs/superpowers/plans/2026-04-17-subsystem-a-selector-registry.md.
 */

// ─── Iframe root ───────────────────────────────────────────────────────────

/**
 * Returns the PeopleSoft content iframe FrameLocator.
 * UCPath wraps Classic content in #main_target_win0 (not #ptifrmtgtframe).
 * Every form interaction after initial navigation must go through this frame.
 * verified 2026-03-16 (iframe ID: main_target_win0)
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#main_target_win0");
}

// ─── Smart HR Transactions (sidebar + template setup) ─────────────────────

export const smartHR = {
  /** Sidebar "Smart HR Templates" expand/collapse link. verified 2026-03-16 */
  sidebarTemplatesLink: (page: Page): Locator =>
    page.getByRole("link", { name: /Smart HR Templates/i }).first(),

  /** Sidebar child link "Smart HR Transactions" (exact match). verified 2026-03-16 */
  sidebarTransactionsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Smart HR Transactions", exact: true }),

  /** Navigation Area button that collapses the sidebar so iframe buttons aren't blocked. verified 2026-03-16 */
  sidebarNavigationToggle: (page: Page): Locator =>
    page.getByRole("button", { name: "Navigation Area" }),

  /** Template selection textbox in the Smart HR Transactions form. verified 2026-03-16 */
  templateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Select Template" }),

  /** Effective Date textbox. verified 2026-03-16 */
  effectiveDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Effective Date" }),

  /** Create Transaction button. verified 2026-03-16 */
  createTransactionButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Create Transaction" }),

  /** Reason Code dropdown. verified 2026-03-16 */
  reasonCodeSelect: (f: FrameLocator): Locator => f.getByLabel("Reason Code"),

  /** Continue button after reason code selection. verified 2026-03-16 (id: HR_TBH_WRK_TBH_NEXT) */
  continueButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Continue" }),

  /** Tabs within the transaction form. verified 2026-03-16 */
  tab: {
    personalData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Personal Data" }),
    jobData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Job Data" }),
    earnsDist: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Earns Dist" }),
    employeeExperience: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Employee Experience" }),
  },

  /** Save and Submit button (at the bottom of every tab once all tabs are visited). verified 2026-03-16 */
  saveAndSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Save and Submit" }).first(),

  /** OK button on the confirmation dialog after Save & Submit. verified 2026-04-01 */
  confirmationOkButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "OK" }),

  /** Error/alert region inside the transaction iframe. verified 2026-03-16 */
  errorBanner: (f: FrameLocator): Locator =>
    f.locator(".PSERROR, #ALERTMSG, .ps_alert-error"),
};

// ─── Personal Data tab (inside transaction form) ───────────────────────────

export const personalData = {
  legalFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal First Name" }),
  legalLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Last Name" }),
  legalMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Middle Name" }),

  /** Preferred/Lived name fields — `exact: true` disambiguates from legal variants. verified 2026-04-16 */
  preferredFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "First Name", exact: true }),
  preferredLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Last Name", exact: true }),
  preferredMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Middle Name", exact: true }),

  dateOfBirth: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Date of Birth" }),

  /** SSN / National ID textbox. exact: true avoids matching "National ID Type" dropdown. verified 2026-03-16 */
  nationalId: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "National ID", exact: true }),

  addressLine1: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Address Line 1" }),
  city: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "City" }),
  state: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "State" }),
  postalCode: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Postal Code" }),

  /**
   * Phone Type dropdown for row index 6 (Mobile - Personal slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6)
   */
  phoneTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6"]'),

  /**
   * Phone number textbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6)
   */
  phoneNumberInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6"]'),

  /**
   * Preferred-phone checkbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_CHK3$6)
   */
  phonePreferredCheckbox: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_CHK3$6"]'),

  /**
   * Email Type dropdown for row index 7 (Home slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7)
   */
  emailTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7"]'),

  /**
   * Email address textbox for row index 7.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7)
   */
  emailAddressInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7"]'),

  /** Tracker profile ID textbox (I-9 linkage). verified 2026-03-16 */
  trackerProfileIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Tracker Profile ID" }),
};

// ─── Comments section (inside transaction form) ────────────────────────────

export const comments = {
  /** Comments textarea — exact ID preserved from original. verified 2026-03-16 */
  commentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#HR_TBH_WRK_DESCRLONG_NOTES"),

  /** Initiator Comments textarea — exact ID preserved from original. verified 2026-03-16 */
  initiatorCommentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#UC_SS_TRANSACT_COMMENTS"),
};

// ─── Job Data tab (inside transaction form) ───────────────────────────────

export const jobData = {
  /** Position Number textbox. exact: true avoids "Reports To Position Number". verified 2026-03-16 */
  positionNumberInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Position Number", exact: true }),

  /** Employee Classification textbox. verified 2026-03-16 */
  employeeClassificationInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Employee Classification" }),

  /**
   * Comp Rate Code input. Primary: accessible name (resilient to grid-index
   * shifts). Fallbacks: 4 known grid-ID variants covering pre- and
   * post-position-number-fill states. verified 2026-04-16
   *
   * PeopleSoft grid input IDs mutate from $11 → $0 after the position number
   * fill triggers a page refresh. Fallback chain captures both.
   */
  compRateCodeInput: (f: FrameLocator): Locator =>
    f
      .getByRole("textbox", { name: "Comp Rate Code" })
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$11"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$11"]')),

  /**
   * Compensation Rate input. Same shape as Comp Rate Code. verified 2026-04-16
   */
  compensationRateInput: (f: FrameLocator): Locator =>
    f
      .getByRole("textbox", { name: "Compensation Rate" })
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$11"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$11"]')),

  /** Compensation Frequency textbox (accessible name — resilient). verified 2026-04-16 */
  compensationFrequencyInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Compensation Frequency" }),

  /** Expected Job End Date textbox. verified 2026-03-16 */
  expectedJobEndDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Expected Job End Date" }),
};

// ─── Person Search (pre-transaction duplicate check) ───────────────────────

export const personSearch = {
  /** Search Type dropdown (P = Person). verified 2026-03-16 */
  searchTypeSelect: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_TYPE"),

  /** Parameter code input ("PERSON_SEARCH"). verified 2026-03-16 */
  parameterCodeInput: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_PARM_CD"),

  /** Search button on page 1 (loads the search form). verified 2026-03-16 */
  loadFormButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /** Result code input ("PERSON_RESULTS"). verified 2026-04-01 */
  resultCodeInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_RSLT_CD"]'),

  /** SSN input (CHAR_INPUT$0). verified 2026-04-01 */
  ssnInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$0"]'),

  /** First name input (CHAR_INPUT$1). verified 2026-04-01 */
  firstNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$1"]'),

  /** Last name input (CHAR_INPUT$2). verified 2026-04-01 */
  lastNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$2"]'),

  /** DOB input (DATE_INPUT$3). verified 2026-04-01 */
  dobInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_DATE_INPUT$3"]'),

  /** National Id magnifying-glass lookup button (CHAR_INPUT$prompt$0). verified 2026-04-01 */
  ssnLookupButton: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$prompt$0"]'),

  /** Search submit button. verified 2026-04-01 */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.locator("#DERIVED_HCR_SM_SM_SEARCH_BTN"),

  /** Results grid — rows containing a 5+ digit employee ID. verified 2026-04-01 */
  resultRows: (f: FrameLocator): Locator =>
    f.locator('[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr').filter({ hasText: /\d{5,}/ }),
};

// ─── Job Summary page (sidebar-less direct URL + iframe cases) ─────────────

export const jobSummary = {
  /** Campus discovery page — UCSD link. verified 2026-04-01 */
  campusDiscoveryUcsdLink: (page: Page): Locator =>
    page.getByRole("link", { name: "University of California, San Diego" }),

  /** Empl ID textbox. Accepts `root` which can be page.locator("body") or frameLocator.locator("body"). verified 2026-04-01 */
  emplIdInput: (root: Locator): Locator =>
    root.getByRole("textbox", { name: "Empl ID" }),

  /** Search button (exact: true). verified 2026-04-01 */
  searchButton: (root: Locator): Locator =>
    root.getByRole("button", { name: "Search", exact: true }),

  /** Work Location tab. verified 2026-04-01 */
  workLocationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Work Location" }),

  /** Job Information tab. verified 2026-04-01 */
  jobInformationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Job Information" }),

  /** Iframe presence probe — when count > 0 we're in iframe mode. verified 2026-04-01 */
  mainTargetIframeProbe: (page: Page): Locator =>
    page.locator("#main_target_win0"),
};

// ─── HR Tasks navigation (top-level page before iframe interactions) ──────

export const hrTasks = {
  /** HR Tasks tile / link. verified 2026-03-16 */
  tile: (page: Page): Locator =>
    page.getByRole("link", { name: /HR Tasks/i }).or(page.getByText("HR Tasks")),

  /** Sidebar: Smart HR Templates link. verified 2026-03-16 */
  smartHRTemplatesLink: (page: Page): Locator =>
    page.getByText("Smart HR Templates"),

  /** Sidebar: Smart HR Transactions link. verified 2026-03-16 */
  smartHRTransactionsLink: (page: Page): Locator =>
    page.getByText("Smart HR Transactions"),
};

// ─── Barrel: grouped namespace export ──────────────────────────────────────

/**
 * Grouped namespace for ergonomic call sites:
 *   ucpathSelectors.jobData.positionNumberInput(frame).fill(positionNum)
 *
 * Use flat exports (e.g. `personalData.dateOfBirth`) for per-flow call sites
 * that only touch one group; use the namespace for files that span groups.
 */
export const ucpathSelectors = {
  smartHR,
  personalData,
  comments,
  jobData,
  personSearch,
  jobSummary,
  hrTasks,
  getContentFrame,
};
```

- [ ] **Step 2: Rewrite `src/systems/ucpath/transaction.ts` to use the registry**

Open the file. At the top, add `import { smartHR, personalData as personalDataSelectors, comments as commentsSelectors, jobData as jobDataSelectors, ucpathSelectors } from "./selectors.js";`

Replace every inline locator construction with the registry call. Keep the `log.step()` / `waitForPeopleSoftProcessing` / timeout scaffolding unchanged. Example diff of `clickSmartHRTransactions`:

```typescript
// OLD:
await page
  .getByRole("link", { name: /Smart HR Templates/i })
  .first()
  .click({ timeout: 10_000 });
// NEW:
await smartHR.sidebarTemplatesLink(page).click({ timeout: 10_000 });
```

Apply the same mechanical substitution for:
- `clickSmartHRTransactions` → uses `smartHR.sidebarTemplatesLink`, `smartHR.sidebarTransactionsLink`, `smartHR.sidebarNavigationToggle`
- `selectTemplate` → `smartHR.templateInput`
- `enterEffectiveDate` → `smartHR.effectiveDateInput`
- `clickCreateTransaction` → `smartHR.createTransactionButton`, `smartHR.errorBanner`
- `selectReasonCode` → `smartHR.reasonCodeSelect`, `smartHR.continueButton`
- `fillPersonalData` → `personalDataSelectors.*` entries + `waitForPeopleSoftProcessing` untouched
- `fillComments` → `commentsSelectors.commentsTextarea`, `commentsSelectors.initiatorCommentsTextarea`
- `clickJobDataTab` → `smartHR.tab.jobData`
- `fillJobData` → `jobDataSelectors.*` (the compRateCode and compensationRate already have the `.or()` chain baked in)
- `clickEarnsDistTab` / `clickEmployeeExperienceTab` → `smartHR.tab.earnsDist` / `.employeeExperience`
- `clickSaveAndSubmit` → `smartHR.saveAndSubmitButton`, `smartHR.confirmationOkButton`, `smartHR.errorBanner`

The `navigateToSmartHR()` re-entry path (for transaction number extraction) uses `getByRole("link", { name: employeeName })` dynamically — that's a parameterized selector and stays inline (registry entry would need to take the name as arg, which is just re-inventing getByRole call). Leave it inline BUT add a `// intentionally inline — dynamic employee name` comment so the import-guard test can skip it.

- [ ] **Step 3: Rewrite `src/systems/ucpath/personal-data.ts` (the emergency-contact helper file)**

This file's `navigateToEmergencyContact` uses top-level page locators (no iframe). Add a new namespace in selectors.ts:

Append to `src/systems/ucpath/selectors.ts`:

```typescript
// ─── Emergency Contact (standalone, deep-link URL, no iframe) ─────────────

export const emergencyContact = {
  /** Empl ID textbox at page top level. verified 2026-04-14 */
  emplIdInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Empl ID" }).first(),

  /** Search button (exact: true). verified 2026-04-14 */
  searchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search", exact: true }).first(),

  /** "No matching values were found." message. verified 2026-04-14 */
  noMatchMessage: (page: Page): Locator =>
    page.getByText("No matching values were found."),

  /** Drill-in link in multi-result grid. verified 2026-04-14 */
  drillInLink: (page: Page): Locator =>
    page.getByRole("link", { name: /drill in/i }),

  /** Every Contact Name textbox on the editor (for duplicate checking). verified 2026-04-14 */
  contactNameInputs: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Contact Name" }),
};
```

Add to `ucpathSelectors`:
```typescript
export const ucpathSelectors = {
  // ... existing ...
  emergencyContact,
};
```

Then rewrite `personal-data.ts`'s function bodies to use `emergencyContact.*`.

- [ ] **Step 4: Rewrite `src/systems/ucpath/navigate.ts`**

Uses `searchPerson()` which touches `personSearch` selectors, plus the HR Tasks navigation. Substitute as per registry. The inline `dismissDialog` helper (for `#ICOK`) stays as-is — it's a JS eval, not a Playwright locator; the selector is inside `document.getElementById("#ICOK")` and has no meaningful `.or()` chain. Add a `// intentionally inline — JS eval bypasses Playwright locator API` comment.

`navigateToSmartHR()` → use `hrTasks.tile`, `hrTasks.smartHRTemplatesLink`, `hrTasks.smartHRTransactionsLink`.

- [ ] **Step 5: Rewrite `src/systems/ucpath/job-summary.ts`**

Substitute: `jobSummary.campusDiscoveryUcsdLink`, `jobSummary.emplIdInput`, `jobSummary.searchButton`, `jobSummary.workLocationTab`, `jobSummary.jobInformationTab`, `jobSummary.mainTargetIframeProbe`.

The `page.evaluate(() => { ... })` grid cell extraction is DOM-side JS, not a Playwright selector — leave it inline.

- [ ] **Step 6: Export registry from `src/systems/ucpath/index.ts`**

Append:
```typescript
export { ucpathSelectors, getContentFrame as getContentFrameFromSelectors } from "./selectors.js";
```

Wait — `getContentFrame` is already exported from `./navigate.js` in the index. The `navigate.ts` definition of `getContentFrame` should now re-export from `selectors.ts` to avoid duplication:

In `src/systems/ucpath/navigate.ts`, replace the inline `getContentFrame` definition with:
```typescript
export { getContentFrame } from "./selectors.js";
```

Remove the duplicate in the index (keep only one export path). The index should look like:

```typescript
// ... existing non-overlapping exports ...
export { ucpathSelectors } from "./selectors.js";
// getContentFrame comes from navigate.js which re-exports from selectors.js
```

- [ ] **Step 7: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

Expected: all green. No new tests yet (the import-guard test comes in Task 11).

- [ ] **Step 8: Commit**

```bash
git add src/systems/ucpath/
git commit -m "$(cat <<'EOF'
refactor(systems/ucpath): consolidate selectors into selectors.ts registry

Every Playwright locator used by the UCPath system now lives in
src/systems/ucpath/selectors.ts, grouped by flow (smartHR, personalData,
comments, jobData, personSearch, jobSummary, hrTasks, emergencyContact).
Callers in transaction.ts / personal-data.ts / navigate.ts /
job-summary.ts import the registry and invoke selector(root).click() etc.

Preserves existing `.or()` fallback chains for PeopleSoft grid-index
mutations (Comp Rate Code, Compensation Rate) — 5-deep fallback chains
remain intact. Inline "intentionally inline" comments mark the few
selectors that can't move: JS-eval paths (#ICOK) and parameterized
dynamic names (employee-name link after save).

getContentFrame consolidated into selectors.ts; navigate.ts re-exports
for API preservation.

Typecheck clean on both tsconfigs; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Consolidate CRM selectors

**Rationale:** CRM has 12 selectors per the sketch — small volume but easy win; mechanical.

**Files:**
- Create: `src/systems/crm/selectors.ts`
- Modify: `src/systems/crm/search.ts`, `navigate.ts`, `extract.ts`
- Modify: `src/systems/crm/index.ts`

- [ ] **Step 1: Create `src/systems/crm/selectors.ts`**

```typescript
import type { Page, Locator } from "playwright";

/**
 * ACT CRM (Salesforce) selector registry.
 *
 * Salesforce Visualforce pages — selectors are CSS / XPath / getByRole
 * mostly. No grid-index mutation issues here (selectors are
 * table-structural or role-based).
 */

// ─── Search results (/hr/ONB_OnboardingSearch results page) ───────────────

export const search = {
  /** All result rows in the search-results table. verified 2026-04-14 */
  resultRows: (page: Page): Locator => page.locator("table tbody tr"),

  /**
   * Nth result row. Use: `.nth(i).locator("td").nth(1)` for "Offer Sent On"
   * column (index 1). verified 2026-04-14
   */
  nthResultRow: (page: Page, i: number): Locator =>
    page.locator("table tbody tr").nth(i),
};

// ─── Record page (/hr/ONB_ViewOnboarding?id=...) ──────────────────────────

export const record = {
  /**
   * Visualforce label → value locator strategy 1: label in <th>, value in
   * the next sibling <td>. verified 2026-04-14
   */
  thLabelFollowingTd: (page: Page, label: string): Locator =>
    page.locator(`th:has-text("${label}")`).locator("xpath=following-sibling::td[1]"),

  /**
   * Visualforce label → value locator strategy 2 (fallback): label in <td>,
   * value in the next sibling <td>. verified 2026-04-14
   */
  tdLabelFollowingTd: (page: Page, label: string): Locator =>
    page.locator(`td:has-text("${label}")`).locator("xpath=following-sibling::td[1]"),
};

// ─── Section navigation ────────────────────────────────────────────────────

export const sectionNav = {
  /**
   * Fallback chain for "click a section by name" when direct URL mapping
   * isn't available in CRM_SECTION_URLS. Tries link, then text, then tab.
   * verified 2026-04-14
   */
  byName: (page: Page, sectionName: string): Locator =>
    page
      .getByRole("link", { name: new RegExp(sectionName, "i") })
      .or(page.getByText(sectionName))
      .or(page.getByRole("tab", { name: new RegExp(sectionName, "i") })),
};

export const crmSelectors = {
  search,
  record,
  sectionNav,
};
```

- [ ] **Step 2: Rewrite `src/systems/crm/search.ts`, `navigate.ts`, `extract.ts`**

`search.ts`:
- Replace `page.locator("table tbody tr")` with `search.resultRows(page)`.
- Replace `rows.nth(i).locator("td").nth(1)` → still in-place (parameterized with `i`, uses registry-derived root). Actually — the registry doesn't capture "nth row → cell column N" well. Keep the `locator("td").nth(1)` inline but source the row from the registry: `search.nthResultRow(page, i).locator("td").nth(1)`.
- The `nameLink` construction (`rows.nth(latestIndex).locator("td").first().locator("a")`) stays inline — it's a compound locator path where the parameterization is the row index. Add comment `// compound path — root from registry` after fetching the row from the registry.

`navigate.ts`:
- Replace the 3-way `.or()` chain with `sectionNav.byName(page, sectionName)`.

`extract.ts`:
- Replace the two inline strategies with `record.thLabelFollowingTd(page, label)` and `record.tdLabelFollowingTd(page, label)`.

- [ ] **Step 3: Export from `src/systems/crm/index.ts`**

```typescript
// append:
export { crmSelectors } from "./selectors.js";
```

- [ ] **Step 4: Typecheck + tests**

`npm run typecheck && npm run typecheck:all && npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/systems/crm
git commit -m "$(cat <<'EOF'
refactor(systems/crm): consolidate selectors into selectors.ts registry

All CRM Playwright locators (search results, Visualforce label/value
extraction, section navigation fallback chain) moved into
src/systems/crm/selectors.ts. Callers import and invoke; zero behavior
change.

Typecheck clean; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Consolidate I9 selectors

**Rationale:** I9 has ~37 selectors — mostly `getByRole` on form fields. Mechanical.

**Files:**
- Create: `src/systems/i9/selectors.ts`
- Modify: `src/systems/i9/login.ts`, `create.ts`, `search.ts`
- Modify: `src/systems/i9/index.ts`

- [ ] **Step 1: Create `src/systems/i9/selectors.ts`**

```typescript
import type { Page, Locator } from "playwright";

/**
 * I-9 Complete (Tracker I-9 by Mitratech) selector registry.
 *
 * Email/password auth (no Duo). Form fields use accessible names
 * consistently. No grid-index mutation issues.
 */

// ─── Login flow ────────────────────────────────────────────────────────────

export const login = {
  /** Email / username textbox. verified 2026-03-16 */
  usernameInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Username or Email*" }),

  /** Next button (email-first login flow). verified 2026-03-16 */
  nextButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Next" }),

  /** Password textbox. verified 2026-03-16 */
  passwordInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Password*" }),

  /** Log in button. verified 2026-03-16 */
  loginButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Log in" }),

  /** Training-notification dismiss button. verified 2026-03-16 */
  dismissNotificationButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Dismiss the Notification" }),

  /** Training-notification confirm "Yes". verified 2026-03-16 */
  confirmYesButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Yes" }),
};

// ─── Dashboard → Create new employee ──────────────────────────────────────

export const dashboard = {
  /** "Create New I-9 : New Employee" entry link. verified 2026-03-16 */
  createNewI9Link: (page: Page): Locator =>
    page.getByRole("link", { name: "create new I9: new employee" }),

  /** Search Options button (opens search dialog). verified 2026-03-16 (id-anchored) */
  searchOptionsButton: (page: Page): Locator =>
    page.locator("#divSearchOptions"),
};

// ─── New Employee Profile form ────────────────────────────────────────────

export const profile = {
  firstName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "First Name (Given Name)*" }),
  middleName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Middle Name" }),
  lastName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Name (Family Name)*" }),
  ssn: (page: Page): Locator =>
    page.getByRole("textbox", { name: "U.S. Social Security Number" }),
  dob: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Date of Birth" }),
  email: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee's Email Address" }),

  /** Worksite listbox. verified 2026-03-16 */
  worksiteListbox: (page: Page): Locator =>
    page.getByRole("listbox", { name: "Worksite *" }),

  /** Worksite option by regex (matches `6-{deptNum}` prefix). verified 2026-03-16 */
  worksiteOption: (page: Page, pattern: RegExp): Locator =>
    page.getByRole("option", { name: pattern }),

  /** Save & Continue button. verified 2026-03-16 */
  saveContinueButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Save & Continue" }),

  /** Error summary heading (validation errors). verified 2026-03-16 */
  errorSummary: (page: Page): Locator =>
    page.getByRole("heading", { name: "Error Summary:" }),

  /** Generic OK button on confirmation dialogs. verified 2026-03-16 */
  okButtonFirst: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }).first(),

  /** Mobile loader overlay (wait for it to hide post-save). verified 2026-03-16 (CSS class) */
  loaderOverlay: (page: Page): Locator =>
    page.locator(".mobile-responsive-loader"),

  /** Duplicate Employee Record dialog. verified 2026-04-16 */
  duplicateDialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Duplicate Employee Record" }),

  /** First row of the duplicate-dialog grid (select existing record). verified 2026-04-16 */
  duplicateFirstRow: (page: Page): Locator =>
    page.getByRole("grid").last().getByRole("row").first(),

  /** View/Edit Selected Record button (inside duplicate dialog). verified 2026-04-16 */
  viewEditSelectedButton: (page: Page): Locator =>
    page.getByRole("button", { name: "View/Edit Selected Record" }),
};

// ─── Remote I-9 section (post-save) ───────────────────────────────────────

export const remoteI9 = {
  /** Remote - Section 1 Only radio. verified 2026-03-16 */
  remoteSection1OnlyRadio: (page: Page): Locator =>
    page.getByRole("radio", { name: "Remote - Section 1 Only" }),

  /** Start Date textbox. verified 2026-03-16 */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start Date*" }),

  /** Create I-9 button. verified 2026-03-16 */
  createI9Button: (page: Page): Locator =>
    page.getByRole("button", { name: "Create I-9" }),

  /** OK confirm after Create I-9 click. verified 2026-03-16 */
  createI9OkButton: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }),
};

// ─── Search dialog ────────────────────────────────────────────────────────

export const search = {
  /** The search dialog itself. verified 2026-03-16 */
  dialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Search for Existing Employee" }),

  /** Clear Search Filters & Results link. verified 2026-03-16 */
  clearFiltersLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Clear Search Filters & Results" }),

  /** Last Name textbox inside dialog. verified 2026-03-16 */
  lastNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("textbox", { name: "Last Name" }),

  /** First Name textbox inside dialog (regex for flexibility). verified 2026-03-16 */
  firstNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("textbox", { name: /First Name/ }),

  /** SSN textbox inside dialog. verified 2026-03-16 */
  ssnInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("textbox", { name: "Social Security Number" }),

  /** Profile ID textbox inside dialog. verified 2026-03-16 */
  profileIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("textbox", { name: "Profile ID" }),

  /** Employee ID textbox inside dialog. verified 2026-03-16 */
  employeeIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("textbox", { name: "Employee ID" }),

  /** Search submit button (dialog-scoped). verified 2026-03-16 */
  submitButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search" }),

  /**
   * Results grid rows. The last grid in the dialog is the results grid
   * (earlier grid contains headers). verified 2026-03-16
   */
  resultRows: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: "Search for Existing Employee" })
      .getByRole("grid")
      .last()
      .getByRole("row"),
};

export const i9Selectors = {
  login,
  dashboard,
  profile,
  remoteI9,
  search,
};
```

- [ ] **Step 2: Rewrite `src/systems/i9/login.ts`, `create.ts`, `search.ts`**

Mechanical replacement using the registry. One catch in `search.ts`: the existing `dialog.getByRole("textbox", ...)` pattern chains off a scoped dialog. Registry entries handle that by re-invoking `page.getByRole("dialog", ...)` inside each selector — slightly more verbose Playwright calls, but idempotent and fine.

In `create.ts`, the `selectWorksite` function builds a regex from `departmentNumber`. Use `profile.worksiteOption(page, optionPattern)`.

- [ ] **Step 3: Export from `src/systems/i9/index.ts`**

```typescript
export { i9Selectors } from "./selectors.js";
```

- [ ] **Step 4: Typecheck + tests + commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

Commit:
```bash
git add src/systems/i9
git commit -m "$(cat <<'EOF'
refactor(systems/i9): consolidate selectors into selectors.ts registry

All Playwright locators for I-9 Complete (login, dashboard, create-new
profile form, remote I-9 section, search dialog) moved into
src/systems/i9/selectors.ts. Zero behavior change.

Typecheck clean; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Consolidate Old Kronos (UKG) selectors

**Rationale:** Old Kronos is heavy on CSS selectors and frame-lookup strategies (unique to UKG's nested iframe model). Many selectors aren't Playwright locators at all — they're strings passed to `clickInFrames()` / `jsClickText()` / `page.evaluate()`. For those, we group them as string constants rather than locator factories. Everything else (employee grid, date inputs, timeframe) becomes locator factories as usual.

**Files:**
- Create: `src/systems/old-kronos/selectors.ts`
- Modify: `src/systems/old-kronos/navigate.ts`, `reports.ts`
- Modify: `src/systems/old-kronos/index.ts`

- [ ] **Step 1: Create `src/systems/old-kronos/selectors.ts`**

```typescript
import type { Page, Frame, Locator } from "playwright";

/**
 * Old Kronos (UKG) selector registry.
 *
 * UKG is a deeply-nested-iframe beast: main content sits inside
 * `widgetFrame804` (or any `widgetFrame*`), and the Reports page adds two
 * more nested frames (`khtmlReportList`, `khtmlReportWorkspace`,
 * `khtmlReportingContentIframe`). Many selectors target specific frames.
 *
 * Some UKG selectors are string arrays passed to `clickInFrames()` /
 * `jsClickText()` helpers rather than Playwright locator chains. Those live
 * here as string constants with verified-date comments.
 */

// ─── SSO session-expiry detection ─────────────────────────────────────────

export const ssoProbe = {
  /**
   * SSO username field — detects when UKG has bounced us back to the SSO
   * login page after a page refresh. verified 2026-03-16
   */
  ssoField: (page: Page): Locator =>
    page.locator('#ssousername, input[name="j_username"]'),
};

// ─── Employee grid (Manage My Department / Genies iframe) ─────────────────

export const employeeGrid = {
  /** QuickFind search input. verified 2026-03-16 */
  quickFindInput: (iframe: Frame): Locator => iframe.locator("#searchQuery"),

  /** QuickFind search submit button. verified 2026-03-16 */
  quickFindSubmitButton: (iframe: Frame): Locator =>
    iframe.locator("#quickfindsearch_btn"),

  /** First row of the Genies grid. verified 2026-03-16 */
  firstRow: (iframe: Frame): Locator => iframe.locator("#row0genieGrid"),

  /** All rows via ARIA role=row. verified 2026-03-16 */
  allRowsByRole: (iframe: Frame): Locator => iframe.locator("div[role='row']"),

  /** Gridcell containing a specific employee ID. verified 2026-03-16 */
  cellByEmployeeId: (iframe: Frame, employeeId: string): Locator =>
    iframe.locator(`div[role='gridcell']:has-text('${employeeId}')`).first(),

  /**
   * Network-change-detected error text — if visible in the iframe, page
   * needs reload. verified 2026-04-01
   */
  networkChangeError: (iframe: Frame): Locator =>
    iframe.locator("text=network change was detected"),
};

// ─── Modal dismiss candidates ─────────────────────────────────────────────

/**
 * String selectors passed to `clickInFrames()` / raw `iframe.locator()` when
 * dismissing UKG modals. Kept separate because `dismissModal()` walks
 * multiple frame/locator pairs and needs raw strings for the helper.
 */
export const modalDismiss = {
  /** OK button. verified 2026-03-16 */
  okButton: (iframe: Frame): Locator => iframe.locator("button:has-text('OK')"),

  /** Close button (multiple variants). verified 2026-03-16 */
  closeButton: (iframe: Frame): Locator =>
    iframe.locator(
      "button.close-handler, button:has-text('Close'), .jqx-window-close-button",
    ),
};

// ─── Date range dialog ────────────────────────────────────────────────────

export const dateRange = {
  /**
   * Calendar button — two variants covering different UKG builds.
   * verified 2026-03-16
   */
  calendarButton: (iframe: Frame): Locator =>
    iframe
      .locator("button:has(i.icon-k-calendar)")
      .or(iframe.locator("button.btn.i.dropdown-toggle[title='Select Dates']")),

  /** Date input fields inside the timeframeSelection dialog. verified 2026-03-16 */
  dateInputs: (iframe: Frame): Locator =>
    iframe.locator("div.timeframeSelection input.jqx-input-content"),

  /**
   * Apply button — two variants covering different UKG builds.
   * verified 2026-03-16
   */
  applyButton: (iframe: Frame): Locator =>
    iframe
      .locator("div.timeframeSelection button[title='Apply']")
      .or(iframe.locator("div.timeframeSelection button:has-text('Apply')")),
};

// ─── Go To menu / navigation ──────────────────────────────────────────────

export const goToMenu = {
  /** "Go To" trigger text. verified 2026-03-16 */
  goToTrigger: (iframe: Frame): Locator => iframe.locator("text=Go To").first(),

  /** Dropdown toggles inside the iframe (used in GoTo → Reports strategy). verified 2026-03-16 */
  dropdownToggles: (iframe: Frame): Locator => iframe.locator(".dropdown-toggle"),

  /** "Reports" menu item. verified 2026-03-16 */
  reportsItem: (iframe: Frame): Locator =>
    iframe.locator("text=Reports").first(),

  /** Sidebar fallback for Reports. verified 2026-03-16 */
  sidebarReports: (page: Page): Locator => page.locator("div[title='Reports']"),

  /** Timecards menu item (exact to avoid "Approve Timecards"). verified 2026-03-16 */
  timecardsItem: (iframe: Frame): Locator =>
    iframe.locator("a, li, span").filter({ hasText: /^Timecards$/ }).first(),
};

// ─── Timecard view ────────────────────────────────────────────────────────

export const timecard = {
  /** Previous Pay Period link (inside an open period dropdown). verified 2026-04-01 */
  previousPayPeriodLink: (f: Frame): Locator =>
    f.getByRole("link", { name: "Previous Pay Period" }),
};

// ─── Workspace tabs ───────────────────────────────────────────────────────

export const workspace = {
  /** Manage My Department tab (preferred). verified 2026-03-16 */
  manageDeptTab: (page: Page): Locator =>
    page.locator("span.krn-workspace-tabs__tab-title:has-text('Manage My Department')"),

  /** Manage My Department tab li fallback. verified 2026-03-16 */
  manageDeptLi: (page: Page): Locator =>
    page.locator("li[title='Manage My Department']"),
};

// ─── Reports page (Run Report button, across many frames) ─────────────────

/**
 * CSS selector strings for the "Run Report" button. Used by `clickRunReport`
 * which iterates frames and selectors. Grouped here so the registry reflects
 * the full set of known anchors.
 */
export const reportsPage = {
  runReportSelectors: [
    "input[value='Run Report']",
    "button:has-text('Run Report')",
    "a:has-text('Run Report')",
    "td:has-text('Run Report')",
    "input[type='submit'][value*='Run']",
    "input[type='button'][value*='Run']",
  ] as const, // verified 2026-03-16

  viewReportSelectors: [
    "input[value='View Report']",
    "button:has-text('View Report')",
    "text=View Report",
  ] as const, // verified 2026-03-16

  checkStatusSelectors: [
    "text=CHECK REPORT STATUS",
    "a:has-text('Check Report Status')",
    "td:has-text('Check Report Status')",
  ] as const, // verified 2026-03-16

  refreshStatusSelectors: [
    "text=Refresh Status",
  ] as const, // verified 2026-03-16

  /** Timecard nav-tree entry. verified 2026-03-16 */
  timecardNavTreeEntry: (listFrame: Frame): Locator =>
    listFrame.locator("a:text-is('Timecard'), span:text-is('Timecard')"),
};

export const oldKronosSelectors = {
  ssoProbe,
  employeeGrid,
  modalDismiss,
  dateRange,
  goToMenu,
  timecard,
  workspace,
  reportsPage,
};
```

- [ ] **Step 2: Rewrite `src/systems/old-kronos/navigate.ts` to import from registry**

Substitute every inline locator with registry equivalents. Keep the 15-attempt `getGeniesIframe` loop and the 3-fallback strategies in `clickGoToReports` / `clickEmployeeRow` — those are logic patterns, not selector patterns. Where the iframe-finding loop uses `page.frame({ name: "widgetFrame804" })`, that's framework-level API, not a selector — leave it untouched.

- [ ] **Step 3: Rewrite `src/systems/old-kronos/reports.ts`**

The inline string arrays `["input[value='Run Report']", ...]` in `clickRunReport` now live as `reportsPage.runReportSelectors`. Update to import and spread.

The `page.frame({ name: "khtmlReportList" })` / `{ name: "khtmlReportWorkspace" }` calls are framework API — not Playwright locators — and stay inline. Same for `listFrame.evaluate(() => {...})` JS-evals for DOM traversal.

- [ ] **Step 4: Export from `src/systems/old-kronos/index.ts`**

```typescript
export { oldKronosSelectors } from "./selectors.js";
```

- [ ] **Step 5: Typecheck + tests + commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
git add src/systems/old-kronos
git commit -m "$(cat <<'EOF'
refactor(systems/old-kronos): consolidate selectors into selectors.ts

UKG Playwright locators (SSO probe, Genies grid, modal dismiss, date
range, Go To menu, workspace tabs, Reports page button selectors)
moved into src/systems/old-kronos/selectors.ts. String-based selector
arrays for multi-anchor click helpers (runReportSelectors,
viewReportSelectors, etc.) live in the same registry as `as const`
arrays. Frame-finding API calls (page.frame({ name: ... })) stay
inline — those are Playwright framework calls, not locators.

Typecheck clean; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Consolidate Kuali selectors

**Rationale:** Kuali's 25-ish selectors are all `getByRole("textbox", { name: "..." })` or combobox/checkbox/radio. Easy lift.

**Files:**
- Create: `src/systems/kuali/selectors.ts`
- Modify: `src/systems/kuali/navigate.ts`
- Modify: `src/systems/kuali/index.ts`

- [ ] **Step 1: Create `src/systems/kuali/selectors.ts`**

```typescript
import type { Page, Locator } from "playwright";

/**
 * Kuali Build selector registry.
 *
 * Separation form on Kuali Build space 5e47518b90adda9474c14adb. Selectors
 * are getByRole({ name: "<exact label>*" }) — the asterisks are literal in
 * the form labels.
 */

// ─── Action List navigation ───────────────────────────────────────────────

export const actionList = {
  /** "Action List" menu item. verified 2026-03-16 */
  menuItem: (page: Page): Locator =>
    page.getByRole("menuitem", { name: "Action List" }),

  /** Document link matching a doc number regex. verified 2026-03-16 */
  docLink: (page: Page, docNumber: string): Locator =>
    page.getByRole("link", { name: new RegExp(docNumber) }),
};

// ─── Separation form: extraction / base fields ────────────────────────────

export const separationForm = {
  employeeName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee Last Name, First Name*" }),
  eid: (page: Page): Locator =>
    page.getByRole("textbox", { name: "EID*" }),
  lastDayWorked: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Day Worked*" }),
  separationDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: /Separation Date/ }),
  terminationType: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Type of Termination*" }),
  location: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Location *" }),
};

// ─── Timekeeper Tasks section ─────────────────────────────────────────────

export const timekeeperTasks = {
  requestAcknowledgedCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Request Acknowledged - In Progress" }),

  timekeeperName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper Name:*" }),

  timekeeperComments: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper/Approver Comments:" }),
};

// ─── Final Transactions section ───────────────────────────────────────────

export const finalTransactions = {
  terminationEffDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Termination Effective Date*" }),

  department: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Department*" }),

  payrollTitleCode: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title Code*" }),

  payrollTitle: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title*" }),
};

// ─── UCPath Transaction Results section ───────────────────────────────────

export const transactionResults = {
  submittedTemplateCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Submitted Termination Template" }),

  transactionNumber: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Transaction Number:*" }),

  doesNotNeedFinalPayRadio: (page: Page): Locator =>
    page.getByRole("radio", { name: "Does not need Final Pay (student employee)" }),
};

// ─── Save button (navbar) ─────────────────────────────────────────────────

/**
 * Save button. 3-deep fallback chain:
 *   1. Navbar action-bar save
 *   2. Generic nav save
 *   3. Global role-based Save button
 *
 * verified 2026-04-10
 */
export const save = {
  navbarSaveButton: (page: Page): Locator =>
    page
      .locator('[class*="action-bar"] button:has-text("Save")')
      .or(page.locator('nav button:has-text("Save")'))
      .or(page.getByRole("button", { name: "Save", exact: true })),
};

export const kualiSelectors = {
  actionList,
  separationForm,
  timekeeperTasks,
  finalTransactions,
  transactionResults,
  save,
};
```

- [ ] **Step 2: Rewrite `src/systems/kuali/navigate.ts`** — mechanical substitution.

- [ ] **Step 3: Export from `src/systems/kuali/index.ts`**

```typescript
export { kualiSelectors } from "./selectors.js";
```

- [ ] **Step 4: Typecheck + tests + commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
git add src/systems/kuali
git commit -m "$(cat <<'EOF'
refactor(systems/kuali): consolidate selectors into selectors.ts registry

All Kuali separation-form selectors (action list, extraction fields,
timekeeper / final transactions / UCPath results sections, save
button 3-deep fallback) moved into src/systems/kuali/selectors.ts.

Typecheck clean; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Consolidate New Kronos (WFD) selectors

**Rationale:** New Kronos has ~29 selectors — about half are inside a dynamic `portal-frame-*` iframe. Selectors factor cleanly.

**Files:**
- Create: `src/systems/new-kronos/selectors.ts`
- Modify: `src/systems/new-kronos/navigate.ts`
- Modify: `src/systems/new-kronos/index.ts`

- [ ] **Step 1: Create `src/systems/new-kronos/selectors.ts`**

```typescript
import type { Page, Locator, FrameLocator } from "playwright";

/**
 * New Kronos (WFD / Dayforce) selector registry.
 *
 * Search sidebar and timecard content live inside an iframe with a
 * session-dependent name: `portal-frame-*`. We expose both a
 * `searchFrame(page)` helper and selectors that take either the page or the
 * FrameLocator.
 */

// ─── Dynamic iframe lookup ────────────────────────────────────────────────

/**
 * Grab the Employee Search sidebar iframe (dynamic name).
 * verified 2026-04-06 (selector: iframe[name^="portal-frame-"])
 */
export function searchFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name^="portal-frame-"]');
}

// ─── Top-level navbar ──────────────────────────────────────────────────────

export const navbar = {
  /** Open the Employee Search sidebar. verified 2026-04-06 */
  employeeSearchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Employee Search" }).first(),

  /** Go To button on main page (fallback when not inside the search frame). verified 2026-04-06 */
  goToButton: (page: Page): Locator =>
    page
      .getByRole("button", { name: /go to/i })
      .or(page.locator("button:has-text('Go To')")),
};

// ─── Employee Search sidebar (inside portal-frame-*) ──────────────────────

export const search = {
  /** Search textbox inside the frame. verified 2026-04-06 */
  searchInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Search by Employee Name or ID" }),

  /** Search submit (exact name to distinguish from other Search buttons). verified 2026-04-06 */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Search", exact: true }),

  /** "There are no items to display" text — no-results probe. verified 2026-04-06 */
  noResultsText: (f: FrameLocator): Locator =>
    f.getByText("There are no items to display."),

  /** First-row checkbox on employee results. verified 2026-04-06 */
  firstResultCheckbox: (f: FrameLocator): Locator =>
    f.locator('input[type="checkbox"]').first(),

  /** First-row fallback (click the row directly). verified 2026-04-06 */
  firstResultRow: (f: FrameLocator): Locator =>
    f.locator('[role="row"]').first(),

  /** Close the sidebar. verified 2026-04-06 */
  closeButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Employee Search Close" }),

  /**
   * Go To button inside the search frame (fallback variant of main-page Go
   * To). verified 2026-04-06
   */
  goToButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: /go to/i }).or(f.locator("text=Go To")),
};

// ─── Go To → Timecard menu (both frame and page variants) ─────────────────

export const goToMenu = {
  /**
   * Timecard menu item — 6-deep fallback chain covering both frame
   * (searchFrame) and page-level renderings, plus "Timecards" plural/
   * "Timecard" singular variants. verified 2026-04-06
   */
  timecardItem: (page: Page): Locator => {
    const f = searchFrame(page);
    return f
      .getByRole("menuitem", { name: /timecard/i })
      .or(f.locator("text=Timecards").first())
      .or(f.locator("text=Timecard").first())
      .or(page.getByRole("menuitem", { name: /timecard/i }))
      .or(page.locator("text=Timecards").first())
      .or(page.locator("text=Timecard").first());
  },
};

// ─── Timecard view / pay period controls ──────────────────────────────────

export const timecard = {
  /** Current Pay Period button (first). verified 2026-04-06 */
  currentPayPeriodButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Current Pay Period" }).first(),

  /**
   * Pay-period trigger button — text varies ("Current Pay Period",
   * "Previous Pay Period", or a date range). Match all three.
   * verified 2026-04-06
   */
  payPeriodTriggerButton: (page: Page): Locator =>
    page
      .getByRole("button", { name: /Pay Period|Schedule Period|^\d+\/\d+\/\d+/ })
      .first(),

  /** Previous Pay Period option (inside an open period dropdown). verified 2026-04-06 */
  previousPayPeriodOption: (page: Page): Locator =>
    page.getByRole("option", { name: "Previous Pay Period" }),

  /** "Select range" button to switch to custom date range. verified 2026-04-06 */
  selectRangeButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Select range" }),

  /** Start date input (custom range). verified 2026-04-06 */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start date" }),

  /** End date input (custom range). verified 2026-04-06 */
  endDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "End date" }),

  /** Apply button (custom range). verified 2026-04-06 */
  applyButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Apply" }),
};

export const newKronosSelectors = {
  searchFrame,
  navbar,
  search,
  goToMenu,
  timecard,
};
```

- [ ] **Step 2: Rewrite `src/systems/new-kronos/navigate.ts`** — mechanical substitution. The dynamic `page.frameLocator('iframe[name^="portal-frame-"]')` pattern becomes `searchFrame(page)` from the registry.

- [ ] **Step 3: Export from `src/systems/new-kronos/index.ts`**

```typescript
export { newKronosSelectors, searchFrame as newKronosSearchFrame } from "./selectors.js";
```

- [ ] **Step 4: Typecheck + tests + commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
git add src/systems/new-kronos
git commit -m "$(cat <<'EOF'
refactor(systems/new-kronos): consolidate selectors into selectors.ts

All New Kronos (WFD) Playwright locators moved into
src/systems/new-kronos/selectors.ts. Exposes searchFrame(page) helper
for dynamic portal-frame-* iframe lookup. Preserves the 6-deep
fallback chain for the Go To → Timecard menu (covers frame and
page variants, "Timecards" plural and "Timecard" singular).

Typecheck clean; 185/185 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Add inline-selector guard test

**Rationale:** Prevent regressions. A future PR that adds `page.locator("#somethingNew")` inside `src/systems/ucpath/transaction.ts` should fail the test suite — forcing the author to put the selector in `selectors.ts` instead.

**Files:**
- Create: `tests/unit/systems/inline-selectors.test.ts`

- [ ] **Step 1: Create the test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Guard: no inline Playwright selectors outside per-system `selectors.ts`.
 *
 * This test walks every `.ts` file under `src/systems/<name>/` (with some
 * explicit allowlist exceptions) and rejects the common Playwright locator-
 * constructor patterns. New selectors must be added to `selectors.ts` and
 * invoked from callers as `<system>Selectors.group.name(root)`.
 *
 * Patterns checked:
 *   - `.locator(` arg that starts with a string literal
 *   - `.getByRole(` with a name
 *   - `.getByLabel(`
 *   - `.getByText(`
 *   - `.getByRole(` with role only
 *   - `.frameLocator(`
 *   - `.getByPlaceholder(`
 *
 * Allowlist (files where inline selectors are intentional):
 *   - `selectors.ts` in every system — obviously
 *   - `common/` files — shared helpers may wrap locator invocations
 *   - Files explicitly annotated with `// allow-inline-selectors` at the top
 *     (for logic that can't reasonably be expressed as a factory, e.g.
 *     dynamic employee-name regex lookups, JS-eval-based dismiss helpers)
 */

const SYSTEMS_DIR = path.resolve(new URL("../../../src/systems", import.meta.url).pathname);

const ALLOWED_FILENAMES = new Set([
  "selectors.ts",
  "types.ts",
  "index.ts",
]);

const ALLOWED_DIRS = new Set([
  "common",
]);

// Patterns that match "inline Playwright selector construction".
// These are conservative — they aim to catch the common cases only.
// If a false positive shows up, add `// allow-inline-selectors` to the file.
const INLINE_PATTERNS: RegExp[] = [
  /\.locator\(\s*["'`]/,                  // .locator("#foo") or .locator('...')
  /\.getByRole\(/,                         // .getByRole(...)
  /\.getByLabel\(/,
  /\.getByText\(/,
  /\.getByPlaceholder\(/,
  /\.getByTestId\(/,
  /\.frameLocator\(/,
];

/**
 * Walk a dir recursively, returning all `.ts` files not in ignored locations.
 */
async function findTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ALLOWED_DIRS.has(entry.name)) continue;
      out.push(...(await findTsFiles(p)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (ALLOWED_FILENAMES.has(entry.name)) continue;
      out.push(p);
    }
  }
  return out;
}

describe("inline-selectors guard", () => {
  it("src/systems/<system>/ files (other than selectors.ts / types.ts / index.ts) contain no inline Playwright selector constructors", async () => {
    const files = await findTsFiles(SYSTEMS_DIR);
    const offenders: Array<{ file: string; line: number; match: string; pattern: string }> = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      // Per-file opt-out
      if (content.includes("// allow-inline-selectors")) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Per-line opt-out (for single lines that can't reasonably be factored)
        if (line.includes("// allow-inline-selector")) continue;
        // Skip comments entirely (JSDoc often references selector patterns)
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

        for (const pat of INLINE_PATTERNS) {
          const m = line.match(pat);
          if (m) {
            offenders.push({
              file: path.relative(process.cwd(), file),
              line: i + 1,
              match: line.trim().slice(0, 120),
              pattern: pat.source,
            });
            break;
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}\n    [${o.pattern}] ${o.match}`)
        .join("\n");
      assert.fail(
        `Found ${offenders.length} inline Playwright selector(s) outside selectors.ts:\n${msg}\n\n` +
          `Fix: move the selector to the per-system selectors.ts registry, or add\n` +
          `  // allow-inline-selector\n` +
          `at the end of the offending line (for rare cases like dynamic regex matchers\n` +
          `or JS-eval paths that can't reasonably be factored).`,
      );
    }
  });
});
```

- [ ] **Step 2: Run the test — it will fail on first attempt**

```bash
npm test -- --test-name-pattern="inline-selectors guard"
```

Examine the output. Common offenders (expected — these need `// allow-inline-selector` annotations):
- `src/systems/ucpath/navigate.ts` — dynamic employee-name-link regex (`new RegExp(lastName, "i")`)
- `src/systems/ucpath/transaction.ts` — same dynamic name-link selector in the transaction-number extraction re-navigation
- `src/systems/new-kronos/navigate.ts` — dynamic `frameLocator` paths (should already be routed through `searchFrame()` after Task 10, but double-check)

For each genuine offender, apply one of:
- Refactor to a registry factory (preferred when the pattern is semi-static)
- Add `// allow-inline-selector` as an end-of-line comment on the offending line (preserves the call site's line but whitelists it)

Iterate until the test passes.

- [ ] **Step 3: Commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
# Expect: 185 + 1 = 186 tests pass.
git add tests/unit/systems/inline-selectors.test.ts \
  src/systems/ucpath/navigate.ts \
  src/systems/ucpath/transaction.ts \
  src/systems/new-kronos/navigate.ts \
  src/systems/old-kronos/navigate.ts \
  src/systems/old-kronos/reports.ts
# (Include any other files touched by annotation edits.)
git commit -m "$(cat <<'EOF'
test(systems): add inline-selectors guard to prevent registry drift

New test tests/unit/systems/inline-selectors.test.ts walks every .ts
file under src/systems/<name>/ (excluding selectors.ts / types.ts /
index.ts / common/) and rejects Playwright locator-constructor calls
(.locator("str"), .getByRole(), .getByLabel(), .getByText(),
.frameLocator(), .getByPlaceholder()).

Future PRs that add inline selectors outside selectors.ts will fail
this test, forcing the author to use the registry. Dynamic regex
matchers and JS-eval paths that can't reasonably factor are
whitelisted via end-of-line `// allow-inline-selector` comments.

186 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update CLAUDE.md files (per-system + root)

**Rationale:** The selector registry is only useful if future sessions know to look there. Every CLAUDE.md that previously had an empty `## Verified Selectors` section now points at `selectors.ts`.

**Files:**
- Modify: `src/systems/ucpath/CLAUDE.md`
- Modify: `src/systems/crm/CLAUDE.md`
- Modify: `src/systems/i9/CLAUDE.md`
- Modify: `src/systems/old-kronos/CLAUDE.md`
- Modify: `src/systems/kuali/CLAUDE.md`
- Modify: `src/systems/new-kronos/CLAUDE.md`
- Create: `src/systems/common/CLAUDE.md`
- Modify: `CLAUDE.md` (repo root) — add `## Selector Registry` section

- [ ] **Step 1: For each per-system CLAUDE.md, rewrite the `## Verified Selectors` section**

Replace the current placeholder contents with:

```markdown
## Verified Selectors

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts).
Grouped by page/flow: see that file's exported namespaces (e.g.
`ucpathSelectors.smartHR.templateInput`, `crmSelectors.record.thLabelFollowingTd`).
Each selector carries a `// verified YYYY-MM-DD` inline comment with its
verification date. Grid-index-mutating selectors (PeopleSoft $0/$11 shifts,
multi-variant fallbacks) use `.or()` chains up to 3-deep.

**Do not add inline selectors outside `selectors.ts`.** The
`tests/unit/systems/inline-selectors.test.ts` guard will reject PRs that
do. Dynamic regex-based lookups and JS-eval paths are the rare
exception — annotate those with `// allow-inline-selector`.

When you verify a selector via playwright-cli, update the `// verified`
comment in `selectors.ts` to today's date.
```

- [ ] **Step 2: Create `src/systems/common/CLAUDE.md`**

```markdown
# systems/common — Shared Cross-System Helpers

Shared Playwright helpers used across multiple systems. Keep this layer
**minimal**: only move a helper here when ≥2 systems call it. Most helpers
belong in the system that owns them, not in common.

## Files

- `modal.ts` — `dismissPeopleSoftModalMask(page)`: hides `#pt_modalMask`,
  the transparent overlay PeopleSoft leaves visible between tab switches.
  Used by UCPath transaction flow and emergency-contact. Legacy aliases
  `dismissModalMask` / `hidePeopleSoftModalMask` re-export this from
  `src/systems/ucpath/navigate.ts` and `personal-data.ts`.
- `safe.ts` — `safeClick(locator, { label })` and `safeFill(locator, value,
  { label })`: instrumented wrappers that log a `log.warn("selector fallback
  triggered: <label>")` when the underlying Playwright call throws.
  Instrumentation is best-effort — it never stalls. Use these for selectors
  with `.or()` fallback chains where a fallback-branch win signals the
  primary anchor has become stale.

## Pattern

```typescript
import { safeClick } from "../common/index.js";
import { ucpathSelectors } from "./selectors.js";

await safeClick(
  ucpathSelectors.jobData.compRateCodeInput(frame),
  { label: "ucpath.jobData.compRateCodeInput" },
);
```

## Why not more?

Fields that look like good candidates for `common/` but stay in their
system:

- **`waitForPeopleSoftProcessing`** — PeopleSoft-specific (#processing,
  #WAIT_win0, .ps_box-processing). Only UCPath uses it. Lives in
  `src/systems/ucpath/navigate.ts`.
- **Old Kronos `dismissModal(page, iframe)`** — clicks iframe OK/Close
  buttons; different semantics from `dismissPeopleSoftModalMask` (which
  hides a CSS overlay). Lives in `src/systems/old-kronos/navigate.ts`.

## Lessons Learned

*(empty — add entries as common helpers grow)*
```

- [ ] **Step 3: Append `## Selector Registry` section to root `CLAUDE.md`**

Insert before the `## Key Patterns` section (or anywhere in the top half):

```markdown
## Selector Registry

Every Playwright selector used by automation lives in a per-system
`selectors.ts` file under `src/systems/<system>/`:

- `src/systems/ucpath/selectors.ts`
- `src/systems/crm/selectors.ts`
- `src/systems/i9/selectors.ts`
- `src/systems/old-kronos/selectors.ts`
- `src/systems/kuali/selectors.ts`
- `src/systems/new-kronos/selectors.ts`

Shared cross-system helpers (modal dismiss, instrumented `safeClick` /
`safeFill` wrappers) live in [`src/systems/common/`](./src/systems/common/).

### Pattern

Selectors are **functions returning Playwright Locators/FrameLocators**:

```typescript
// src/systems/ucpath/selectors.ts
export const personalData = {
  legalFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal First Name" }),
  // ...
};

// Caller:
import { personalData } from "./selectors.js";
await personalData.legalFirstName(frame).fill(data.firstName);
```

Each selector carries a `// verified YYYY-MM-DD` comment. Fallback chains
(`.or()`) up to 3-deep are used where PeopleSoft grid IDs mutate or
similar brittle anchors need hardening.

### Adding selectors

1. Map the live page with `playwright-cli snapshot` (see playwright-cli
   section).
2. Add the new selector to the relevant system's `selectors.ts` with
   today's `// verified` date.
3. Import and call it from the caller. Never inline `page.locator("...")`
   calls in system .ts files — the
   [`tests/unit/systems/inline-selectors.test.ts`](./tests/unit/systems/inline-selectors.test.ts)
   guard will reject the PR.
4. For PeopleSoft grid inputs or any anchor that has failed in the past,
   add a 2-3 deep `.or()` fallback chain and wrap invocations with
   `safeClick` / `safeFill` from `src/systems/common/` so a fallback
   match is logged.

### Verification

This subsystem (A, 2026-04-17) was a **re-homing pass** — selectors
moved verbatim from their prior inline locations with existing
verified-dates preserved. When you next touch a selector in production
(e.g. because automation failed and playwright-cli shows the anchor
moved), bump the `// verified` date to the day you re-mapped it.
```

- [ ] **Step 4: Typecheck + tests + commit**

```bash
npm run typecheck && npm run typecheck:all && npm test
git add src/systems/ucpath/CLAUDE.md \
  src/systems/crm/CLAUDE.md \
  src/systems/i9/CLAUDE.md \
  src/systems/old-kronos/CLAUDE.md \
  src/systems/kuali/CLAUDE.md \
  src/systems/new-kronos/CLAUDE.md \
  src/systems/common/CLAUDE.md \
  CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(systems): point every CLAUDE.md at the new per-system selectors.ts

- Per-system CLAUDE.md: `## Verified Selectors` sections now reference
  selectors.ts as the canonical home.
- src/systems/common/CLAUDE.md: new file documenting the shared
  helpers layer (modal.ts + safe.ts) and what intentionally does NOT
  live here.
- Root CLAUDE.md: new `## Selector Registry` section documenting the
  pattern, how to add selectors, and the verification semantics of
  the re-homing pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Full verification

**Rationale:** Prove the registry migration doesn't break anything.

- [ ] **Step 1: Typecheck + tests**

```bash
npm run typecheck && npm run typecheck:all && npm test
```

All three exit 0. Test count ≥ 186 (original 181 + 4 safe.ts + 1 inline-selectors).

- [ ] **Step 2: Dry-run smoke tests**

Run each of the following. Each should exit 0 without launching a browser (dry-run mode):

```bash
npm run work-study:dry 12345 04/16/2026
npm run emergency-contact:dry src/workflows/emergency-contact/fixtures/test-batch.yaml
tsx --env-file=.env src/cli.ts eid-lookup --dry-run --no-crm "Smith, John"
```

Capture the last 10 lines of each for the final report.

If any dry-run fails, trace back to the task that likely broke it:
- work-study: Task 5 (UCPath selectors)
- emergency-contact: Task 5 (UCPath personal-data.ts)
- eid-lookup: Task 5 or Task 6 (UCPath/CRM selectors)

Fix + re-verify before proceeding to Task 14.

- [ ] **Step 3: No commit** — verification-only task.

---

## Task 14: Tag `subsystem-a-selector-registry-complete`

- [ ] **Step 1: Tag the final commit**

```bash
git tag subsystem-a-selector-registry-complete
git tag | grep subsystem-a
```

Expected output: `subsystem-a-selector-registry-complete`.

---

## Verification Summary

After all 14 tasks:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run typecheck:all` exits 0
- [ ] `npm test` shows ≥186 passing (181 baseline + 4 `safe.ts` + 1 inline-selectors guard)
- [ ] `src/old-kronos/`, `src/kuali/`, `src/new-kronos/` no longer exist; all three now live under `src/systems/`
- [ ] Each of the 6 `src/systems/<system>/` dirs contains a `selectors.ts` file
- [ ] `src/systems/common/` exists with `index.ts`, `modal.ts`, `safe.ts`, `CLAUDE.md`
- [ ] `src/utils/log.ts` exports `log.warn`
- [ ] `tests/unit/systems/inline-selectors.test.ts` exists and passes
- [ ] Every per-system `CLAUDE.md` points at `selectors.ts` in `## Verified Selectors`
- [ ] Root `CLAUDE.md` has a `## Selector Registry` section
- [ ] `npm run work-study:dry 12345 04/16/2026` exits 0
- [ ] `npm run emergency-contact:dry src/workflows/emergency-contact/fixtures/test-batch.yaml` exits 0
- [ ] `tsx --env-file=.env src/cli.ts eid-lookup --dry-run --no-crm "Smith, John"` exits 0
- [ ] `git tag | grep subsystem-a` prints `subsystem-a-selector-registry-complete`
- [ ] No kernel-migration of kronos-reports or separations happened; they still work via their pre-kernel shape, only import paths changed

## Risk / Rollback

| Risk | Mitigation |
|------|-----------|
| A miss in the rename/depth-adjust (Tasks 1-3) breaks an unmigrated workflow | `typecheck:all` catches it; dry-runs in Task 13 catch runtime-only issues. |
| The `.or()` fallback chain I copied doesn't actually compile because the `FrameLocator` type doesn't support `.or()` on a mix of Locator + FrameLocator.locator | Only `Locator.or(Locator)` — matches the existing inline code already. All existing chains preserved verbatim. |
| Inline-selectors test false-positives on legit patterns (comments, non-selector `.locator` calls like `row.locator("td").nth(1)`) | The test skips commented lines. The compound pattern `row.locator("td").nth(1)` IS flagged — needs `// allow-inline-selector` annotation. Expect 5-10 annotations in this first pass. |
| Migrating `waitForPeopleSoftProcessing` to common breaks UCPath | Not doing it. Stays in `src/systems/ucpath/navigate.ts`. Decision documented in plan intro. |
| Re-exporting `dismissModalMask` / `hidePeopleSoftModalMask` as common aliases breaks consumer imports | They still resolve because the re-export preserves the original export name at the original path. `rg "dismissModalMask\|hidePeopleSoftModalMask" src/ tests/` stays green. |

Rollback by task:
- After Tasks 1-3 only: revert the 3 rename commits in reverse order.
- After Task 4: revert Task 4 commit; old `dismissModalMask` comes back, `safeClick` / `safeFill` disappear.
- After Tasks 5-10: each system's consolidation is an isolated commit; revert individually.
- After Task 11 (guard): revert the test file; all prior work stays.
- After Task 12 (docs): doc-only, trivially reversible.

## Deferred items (NOT done in this plan)

- Live re-verification of every selector against running UCPath/CRM/Kuali/I9/Kronos (needs user Duo approval).
- Kernel-migrating `kronos-reports` or `separations` workflows (explicit out-of-scope per subsystem scope boundaries).
- ESLint rule version of the inline-selectors guard (a test suffices today).
- Visual regression UI-change detection (separate concern per sketch).
- Annual audit / selector-staleness alerting (open question from sketch; no answer mandated here).
- Shared PeopleSoft "base module" for UCPath + Old Kronos (per sketch's open question; too speculative for now).
