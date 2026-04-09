# Codebase Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the HR automation codebase by extracting duplicate patterns into shared modules, centralizing config, redesigning session management (one session per workflow), replacing Excel trackers with a live monitoring dashboard, and improving code quality.

**Architecture:** Extract 6 shared utilities from duplicated code in auth/browser/tracker modules. Centralize ~50 scattered constants into `src/config.ts`. Introduce `WorkflowSession` class for per-workflow browser session sharing. Replace ExcelJS runtime tracking with atomic JSONL writes + SSE-based HTML dashboard. Keep Excel as an optional export.

**Tech Stack:** TypeScript (strict), Playwright, Node.js built-in `http` module (dashboard), `fs.appendFileSync` (JSONL), async-mutex, Commander CLI, ExcelJS (export only).

---

## File Structure

### New Files to Create
```
src/auth/sso-fields.ts          — Shared SSO credential filling (username/password .or() chains)
src/auth/duo-poll.ts            — Unified Duo MFA polling with device trust button handling
src/browser/session.ts          — WorkflowSession class (one session per workflow)
src/browser/tiling.ts           — Window tiling computation for multi-browser workflows
src/tracker/jsonl.ts            — JSONL append-only tracker (replaces Excel for runtime)
src/tracker/dashboard.ts        — Live HTML dashboard via Node http + SSE
src/tracker/export-excel.ts     — On-demand Excel export from JSONL data
src/tracker/locked.ts           — Generic mutex-locked write wrapper
src/utils/screenshot.ts         — Unified debug screenshot helper
src/utils/worker-pool.ts        — Generic parallel worker pool with queue + health checks
tests/unit/sso-fields.test.ts   — Tests for SSO field locator construction
tests/unit/duo-poll.test.ts     — Tests for Duo polling options validation
tests/unit/tiling.test.ts       — Tests for window tiling math
tests/unit/jsonl.test.ts        — Tests for JSONL read/write
tests/unit/worker-pool.test.ts  — Tests for worker pool queue logic
```

### Files to Modify
```
src/config.ts                                    — Add PATHS, TIMEOUTS, SCREEN, ANNUAL_DATES, URLs
src/auth/login.ts                                — Replace 5 SSO fills + 5 Duo loops with shared calls
src/workflows/onboarding/parallel.ts             — Use worker-pool.ts + locked.ts
src/workflows/old-kronos-reports/parallel.ts      — Use worker-pool.ts + locked.ts + tiling.ts
src/workflows/old-kronos-reports/config.ts        — Re-export from central config
src/workflows/separations/config.ts               — Re-export from central config
src/workflows/separations/workflow.ts              — Use WorkflowSession + tiling.ts
src/workflows/onboarding/tracker.ts               — Add JSONL trackEvent calls
src/workflows/eid-lookup/tracker.ts               — Add JSONL trackEvent calls
src/workflows/old-kronos-reports/tracker.ts        — Add JSONL trackEvent calls
src/workflows/work-study/tracker.ts                — Add JSONL trackEvent calls
```

---

## Task 1: Shared SSO Credential Filling

**Files:**
- Create: `src/auth/sso-fields.ts`
- Create: `tests/unit/sso-fields.test.ts`
- Modify: `src/auth/login.ts:84-102,243-254,444-451,537-544`

- [ ] **Step 1: Write the test for SSO field helpers**

```typescript
// tests/unit/sso-fields.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSsoFieldSelectors, getUkgFieldSelectors } from "../../src/auth/sso-fields.js";

describe("getSsoFieldSelectors", () => {
  it("returns 3 username and 3 password label variants", () => {
    const { usernameLabels, passwordLabels, submitSelector } = getSsoFieldSelectors();
    assert.equal(usernameLabels.length, 3);
    assert.equal(passwordLabels.length, 3);
    assert.equal(submitSelector, 'button[name="_eventId_proceed"]');
  });
});

describe("getUkgFieldSelectors", () => {
  it("returns UKG-specific selectors", () => {
    const { usernameSelector, passwordSelector } = getUkgFieldSelectors();
    assert.equal(usernameSelector, "#ssousername");
    assert.equal(passwordSelector, "#ssopassword");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/sso-fields.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/sso-fields.ts
import type { Page } from "playwright";
import { validateEnv } from "../utils/env.js";
import { log } from "../utils/log.js";

/** Standard UCSD Shibboleth SSO selectors (UCPath, CRM, Kuali, New Kronos) */
export function getSsoFieldSelectors() {
  return {
    usernameLabels: [
      "User name (or email address)",
      "Username",
    ] as const,
    usernameInputSelector: 'input[name="j_username"]',
    passwordLabels: [
      "Password:",
      "Password",
    ] as const,
    passwordInputSelector: 'input[name="j_password"]',
    submitSelector: 'button[name="_eventId_proceed"]',
  };
}

/** UKG-specific selectors (different SSO form) */
export function getUkgFieldSelectors() {
  return {
    usernameSelector: "#ssousername",
    passwordSelector: "#ssopassword",
  };
}

/**
 * Fill SSO credentials on a UCSD Shibboleth login page.
 * Builds a 3-level .or() chain for username and password fields.
 */
export async function fillSsoCredentials(page: Page): Promise<void> {
  const { userId, password } = validateEnv();
  const sel = getSsoFieldSelectors();

  const usernameField = page
    .getByLabel(sel.usernameLabels[0])
    .or(page.getByLabel(sel.usernameLabels[1]))
    .or(page.locator(sel.usernameInputSelector));

  const passwordField = page
    .getByLabel(sel.passwordLabels[0])
    .or(page.getByLabel(sel.passwordLabels[1]))
    .or(page.locator(sel.passwordInputSelector));

  log.step("Filling SSO credentials...");
  await usernameField.first().fill(userId, { timeout: 5_000 });
  await passwordField.first().fill(password, { timeout: 5_000 });
  log.step("SSO credentials filled");
}

/** Click the Shibboleth SSO submit button. */
export async function clickSsoSubmit(page: Page): Promise<void> {
  const sel = getSsoFieldSelectors();
  await page.locator(sel.submitSelector).click({ timeout: 5_000 });
  log.step("SSO submit clicked");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/unit/sso-fields.test.ts`
Expected: PASS

- [ ] **Step 5: Replace SSO fills in login.ts**

Modify `src/auth/login.ts` — replace 4 identical credential-fill blocks with calls to `fillSsoCredentials` and `clickSsoSubmit`. UKG keeps its own selectors.

In `loginToUCPath` (lines 84-107): replace the `.or()` chain + fill + submit with:
```typescript
import { fillSsoCredentials, clickSsoSubmit } from "./sso-fields.js";

// Replace lines 84-107 with:
await fillSsoCredentials(page);
await clickSsoSubmit(page);
```

Apply the same replacement at:
- `loginToACTCrm` (lines 243-260)
- `loginToKuali` (lines 444-458)
- `loginToNewKronos` (lines 537-551)

Keep `ukgNavigateAndFill` using its own `#ssousername`/`#ssopassword` selectors.

- [ ] **Step 6: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: All pass with no type errors

- [ ] **Step 7: Commit**

```bash
git add src/auth/sso-fields.ts tests/unit/sso-fields.test.ts src/auth/login.ts
git commit -m "refactor: extract shared SSO credential filling into sso-fields.ts"
```

---

## Task 2: Unified Duo MFA Polling

**Files:**
- Create: `src/auth/duo-poll.ts`
- Create: `tests/unit/duo-poll.test.ts`
- Modify: `src/auth/login.ts:114-131,272-303,393-408,474-501,560-587`
- Modify: `src/auth/duo-wait.ts` (kept as-is, duo-poll.ts builds on top)

- [ ] **Step 1: Write the test**

```typescript
// tests/unit/duo-poll.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DuoPollOptions } from "../../src/auth/duo-poll.js";

describe("DuoPollOptions", () => {
  it("accepts string successUrlMatch", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "universityofcalifornia.edu",
    };
    assert.equal(opts.successUrlMatch, "universityofcalifornia.edu");
    assert.equal(opts.timeoutSeconds, undefined); // defaults to 180
  });

  it("accepts function successUrlMatch", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: (url) => url.includes("kualibuild"),
      timeoutSeconds: 120,
    };
    assert.equal(typeof opts.successUrlMatch, "function");
    assert.equal(opts.timeoutSeconds, 120);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/duo-poll.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/duo-poll.ts
import type { Page } from "playwright";
import { log } from "../utils/log.js";

export interface DuoPollOptions {
  /** Timeout in seconds (default 180) */
  timeoutSeconds?: number;
  /** URL substring or predicate that indicates successful auth */
  successUrlMatch: string | ((url: string) => boolean);
  /** Additional check after URL match (e.g., element visible) */
  successCheck?: (page: Page) => Promise<boolean>;
  /** Post-approval actions (e.g., click through intermediate pages) */
  postApproval?: (page: Page) => Promise<void>;
}

/**
 * Poll for Duo MFA approval with "Yes, this is my device" button handling.
 *
 * Replaces 5 near-identical polling loops across login functions.
 * Polls every 2 seconds. Clicks device trust button if visible.
 */
export async function pollDuoApproval(
  page: Page,
  options: DuoPollOptions,
): Promise<boolean> {
  const timeout = options.timeoutSeconds ?? 180;
  const isSuccess =
    typeof options.successUrlMatch === "function"
      ? options.successUrlMatch
      : (url: string) => url.includes(options.successUrlMatch as string);

  log.waiting("Waiting for Duo approval (approve on your phone)...");

  for (let elapsed = 0; elapsed < timeout; elapsed += 2) {
    try {
      // Check for "Yes, this is my device" trust button
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
      }

      // Check success condition
      const currentUrl = page.url();
      if (isSuccess(currentUrl)) {
        // Run additional success check if provided
        if (options.successCheck) {
          const ok = await options.successCheck(page);
          if (!ok) {
            await page.waitForTimeout(2_000);
            continue;
          }
        }

        // Run post-approval hook if provided
        if (options.postApproval) {
          await options.postApproval(page);
        }

        log.success("Duo MFA approved — authenticated");
        return true;
      }
    } catch {
      // Ignore transient errors during polling
    }

    await page.waitForTimeout(2_000);
  }

  log.error(`Duo approval timed out after ${timeout}s`);
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/unit/duo-poll.test.ts`
Expected: PASS

- [ ] **Step 5: Replace Duo loops in login.ts**

Replace the 5 inline Duo polling loops with calls to `pollDuoApproval`:

**loginToUCPath (lines 114-131):**
```typescript
import { pollDuoApproval } from "./duo-poll.js";

// Replace the for loop with:
const duoOk = await pollDuoApproval(page, {
  successUrlMatch: (url) =>
    url.includes("universityofcalifornia.edu") && !url.includes("duosecurity"),
});
if (!duoOk) return false;
```

**loginToACTCrm (lines 272-303):**
```typescript
const duoOk = await pollDuoApproval(page, {
  timeoutSeconds: 60,
  successUrlMatch: (url) =>
    (url.includes("act-crm.my.site.com") || url.includes("crm.ucsd.edu")) &&
    !url.includes("login"),
});
if (!duoOk) return false;
```

**ukgSubmitAndWaitForDuo (lines 393-408):**
```typescript
const duoOk = await pollDuoApproval(page, {
  successUrlMatch: "kronos.net",
  successCheck: async (p) =>
    (await p.locator("text=Manage My Department").count()) > 0,
});
return duoOk;
```

**loginToKuali (lines 474-501):**
```typescript
const duoOk = await pollDuoApproval(page, {
  successUrlMatch: "kualibuild",
});
if (!duoOk) return false;
```

**loginToNewKronos (lines 560-587):**
```typescript
const duoOk = await pollDuoApproval(page, {
  successUrlMatch: "mykronos.com/wfd",
});
if (!duoOk) return false;
```

- [ ] **Step 6: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/auth/duo-poll.ts tests/unit/duo-poll.test.ts src/auth/login.ts
git commit -m "refactor: extract unified Duo MFA polling into duo-poll.ts"
```

---

## Task 3: Navigation Retry Consolidation

**Files:**
- Modify: `src/auth/login.ts:50-76,343-359`
- Reference: `src/browser/launch.ts:20-56` (existing `gotoWithRetry`)

- [ ] **Step 1: Replace inline retry in loginToUCPath**

In `src/auth/login.ts`, the campus selection retry loop (lines 50-76) does:
1. `page.goto(url)` with ERR_NETWORK retry
2. Then waits and clicks campus link

Replace the navigation part with `gotoWithRetry`:

```typescript
import { gotoWithRetry } from "../browser/launch.js";

// Lines 50-76: Replace navigation retry loop with:
await gotoWithRetry(page, UCPATH_URL, undefined, 3, 15_000);
```

Keep the campus link click logic outside the retry since `gotoWithRetry` handles the navigation part.

- [ ] **Step 2: Replace inline retry in ukgNavigateAndFill**

In `src/auth/login.ts` lines 343-359, replace:

```typescript
// Replace with:
await gotoWithRetry(page, UKG_URL, undefined, 3, 60_000);
```

- [ ] **Step 3: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/auth/login.ts
git commit -m "refactor: use gotoWithRetry for inline navigation retries in login.ts"
```

---

## Task 4: Debug Screenshot Helper

**Files:**
- Create: `src/utils/screenshot.ts`
- Modify: `src/auth/login.ts:10-13` (remove `ss()`)
- Modify: `src/old-kronos/navigate.ts:12-15` (remove `ukgScreenshot()`)

- [ ] **Step 1: Write the implementation**

```typescript
// src/utils/screenshot.ts
import { mkdirSync } from "fs";
import type { Page } from "playwright";
import { log } from "./log.js";

const DEFAULT_DIR = ".auth";

/**
 * Take a debug screenshot with consistent logging.
 * Replaces ss(), ukgScreenshot(), and inline screenshot calls.
 */
export async function debugScreenshot(
  page: Page,
  name: string,
  options?: { fullPage?: boolean; dir?: string },
): Promise<void> {
  const dir = options?.dir ?? DEFAULT_DIR;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path, fullPage: options?.fullPage ?? false });
  log.step(`Screenshot: ${path} (${page.url()})`);
}
```

- [ ] **Step 2: Replace ss() in login.ts**

Remove the `ss` helper function at lines 10-13. Replace all `ss(page, "name")` calls (at lines ~190, 236, 255, 262, 307, 312) with:
```typescript
import { debugScreenshot } from "../utils/screenshot.js";

await debugScreenshot(page, "debug-name");
```

- [ ] **Step 3: Replace ukgScreenshot() in old-kronos/navigate.ts**

Remove the `ukgScreenshot` function at lines 12-15. Replace all `ukgScreenshot(page, "name")` calls with:
```typescript
import { debugScreenshot } from "../utils/screenshot.js";

await debugScreenshot(page, "ukg-name");
```

Update `src/old-kronos/index.ts` to remove `ukgScreenshot` from exports.

- [ ] **Step 4: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/utils/screenshot.ts src/auth/login.ts src/old-kronos/navigate.ts src/old-kronos/index.ts
git commit -m "refactor: unify debug screenshot helpers into utils/screenshot.ts"
```

---

## Task 5: Locked Tracker + Worker Pool

**Files:**
- Create: `src/tracker/locked.ts`
- Create: `src/utils/worker-pool.ts`
- Create: `tests/unit/worker-pool.test.ts`
- Modify: `src/workflows/onboarding/parallel.ts:23-31,67-132`
- Modify: `src/workflows/old-kronos-reports/parallel.ts:30-39,168-247`
- Modify: `src/tracker/index.ts`

- [ ] **Step 1: Write locked tracker**

```typescript
// src/tracker/locked.ts
import type { Mutex } from "async-mutex";

/**
 * Wrap a tracker update function with mutex locking.
 * Prevents concurrent Excel writes from parallel workers.
 */
export function createLockedTracker<T>(
  mutex: Mutex,
  updateFn: (filePath: string, data: T) => Promise<void>,
): (filePath: string, data: T) => Promise<void> {
  return async (filePath: string, data: T): Promise<void> => {
    const release = await mutex.acquire();
    try {
      await updateFn(filePath, data);
    } finally {
      release();
    }
  };
}
```

- [ ] **Step 2: Update tracker/index.ts exports**

```typescript
// src/tracker/index.ts
export { appendRow, parseDepartmentNumber } from "./spreadsheet.js";
export type { ColumnDef } from "./spreadsheet.js";
export { createLockedTracker } from "./locked.js";
```

- [ ] **Step 3: Write worker pool test**

```typescript
// tests/unit/worker-pool.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWorkerPool } from "../../src/utils/worker-pool.js";

describe("runWorkerPool", () => {
  it("processes all items across workers", async () => {
    const processed: number[] = [];

    await runWorkerPool({
      items: [1, 2, 3, 4, 5],
      workerCount: 2,
      setup: async () => ({}),
      process: async (item) => {
        processed.push(item);
      },
    });

    assert.deepEqual(processed.sort(), [1, 2, 3, 4, 5]);
  });

  it("stops worker after maxConsecutiveErrors", async () => {
    let attempts = 0;

    await runWorkerPool({
      items: [1, 2, 3, 4, 5],
      workerCount: 1,
      maxConsecutiveErrors: 2,
      setup: async () => ({}),
      process: async () => {
        attempts++;
        throw new Error("fail");
      },
    });

    assert.equal(attempts, 2);
  });

  it("resets error count on success", async () => {
    const results: number[] = [];

    await runWorkerPool({
      items: [1, 2, 3, 4],
      workerCount: 1,
      maxConsecutiveErrors: 2,
      setup: async () => ({}),
      process: async (item) => {
        results.push(item);
        if (item === 2) throw new Error("fail");
      },
    });

    // Should process 1 (ok), 2 (fail), 3 (ok), 4 (ok) — error reset after 3 succeeds
    assert.deepEqual(results, [1, 2, 3, 4]);
  });

  it("calls teardown for each worker", async () => {
    const tornDown: number[] = [];

    await runWorkerPool({
      items: [1, 2],
      workerCount: 2,
      setup: async (id) => ({ id }),
      process: async () => {},
      teardown: async (ctx) => {
        tornDown.push(ctx.id);
      },
    });

    assert.equal(tornDown.length, 2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx --test tests/unit/worker-pool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Write worker pool implementation**

```typescript
// src/utils/worker-pool.ts
import { log } from "./log.js";
import { errorMessage } from "./errors.js";

export interface WorkerPoolOptions<T, Ctx> {
  /** Items to process */
  items: T[];
  /** Number of parallel workers */
  workerCount: number;
  /** Called once per worker before processing begins */
  setup: (workerId: number) => Promise<Ctx>;
  /** Called for each item on a worker */
  process: (item: T, ctx: Ctx, workerId: number) => Promise<void>;
  /** Called when a worker finishes or encounters fatal error */
  teardown?: (ctx: Ctx, workerId: number) => Promise<void>;
  /** Max consecutive errors before stopping a worker (default: Infinity) */
  maxConsecutiveErrors?: number;
}

/**
 * Run a parallel worker pool with a shared queue.
 * Each worker pulls items from the queue until empty.
 */
export async function runWorkerPool<T, Ctx>(
  options: WorkerPoolOptions<T, Ctx>,
): Promise<void> {
  const {
    items,
    workerCount,
    setup,
    process,
    teardown,
    maxConsecutiveErrors = Infinity,
  } = options;

  const queue = [...items];
  const actualWorkers = Math.min(workerCount, items.length);

  async function worker(workerId: number): Promise<void> {
    const prefix = `[W${workerId}]`;
    const ctx = await setup(workerId);
    let consecutiveErrors = 0;

    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;

        try {
          await process(item, ctx, workerId);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          log.error(`${prefix} Error: ${errorMessage(err)}`);
          if (consecutiveErrors >= maxConsecutiveErrors) {
            log.error(
              `${prefix} ${maxConsecutiveErrors} consecutive errors — stopping worker`,
            );
            break;
          }
        }
      }
    } finally {
      if (teardown) {
        await teardown(ctx, workerId).catch(() => {});
      }
    }
  }

  const workers = Array.from({ length: actualWorkers }, (_, i) =>
    worker(i + 1),
  );
  await Promise.all(workers);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test tests/unit/worker-pool.test.ts`
Expected: PASS

- [ ] **Step 7: Migrate onboarding/parallel.ts to use shared modules**

Replace the `createLockedTracker` function and the inline worker loop in `src/workflows/onboarding/parallel.ts`:

```typescript
import { createLockedTracker } from "../../tracker/locked.js";
import { runWorkerPool } from "../../utils/worker-pool.js";

// Remove local createLockedTracker (lines 23-31)
// Replace runParallel body (lines 67-86) with:

const mutex = new Mutex();
const lockedTracker = createLockedTracker(mutex, updateOnboardingTracker);

await runWorkerPool({
  items: emails,
  workerCount: parallelCount,
  setup: async (workerId) => {
    const crm = await launchBrowser();
    const ucpath = options.dryRun ? null : await launchBrowser();
    // Auth...
    return { crmPage: crm.page, ucpathPage: ucpath?.page };
  },
  process: async (email, ctx, workerId) => {
    await runOnboarding(email, {
      dryRun: options.dryRun,
      crmPage: ctx.crmPage,
      ucpathPage: ctx.ucpathPage,
      updateTrackerFn: lockedTracker,
      logPrefix: `[W${workerId}]`,
    });
  },
});
```

- [ ] **Step 8: Migrate old-kronos-reports/parallel.ts to use shared modules**

Replace the `createLockedTracker` function and worker pattern in `src/workflows/old-kronos-reports/parallel.ts`:

```typescript
import { createLockedTracker } from "../../tracker/locked.js";
import { runWorkerPool } from "../../utils/worker-pool.js";

// Remove local createLockedTracker (lines 30-39)
// The Kronos workflow needs custom setup (browser launch + auth + tiling)
// so setup() will be more complex, but the queue/worker pattern is replaced
```

- [ ] **Step 9: Run typecheck and all tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add src/tracker/locked.ts src/tracker/index.ts src/utils/worker-pool.ts tests/unit/worker-pool.test.ts src/workflows/onboarding/parallel.ts src/workflows/old-kronos-reports/parallel.ts
git commit -m "refactor: extract shared worker pool and locked tracker utilities"
```

---

## Task 6: Config Centralization

**Files:**
- Modify: `src/config.ts`
- Modify: `src/workflows/old-kronos-reports/config.ts`
- Modify: `src/workflows/separations/config.ts`
- Modify: `src/old-kronos/reports.ts:266`
- Modify: `src/workflows/separations/workflow.ts:179`

- [ ] **Step 1: Expand src/config.ts**

```typescript
// src/config.ts — add to existing file (keep existing URL exports)
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();

// ─── Paths (user-agnostic) ───────────────────────────────────
export const PATHS = {
  reportsDir: join(HOME, "Downloads", "reports"),
  downloadsDir: join(HOME, "Downloads"),
  ukgSessionBase: join(HOME, "ukg_session"),
  ukgSessionSep: join(HOME, "ukg_session_sep"),
  screenshotDir: ".auth",
  trackerDir: ".tracker",
} as const;

// ─── Timeouts (ms) ──────────────────────────────────────────
export const TIMEOUTS = {
  fast: 5_000,
  normal: 10_000,
  navigation: 15_000,
  longNavigation: 30_000,
  ukgNavigation: 60_000,
  duoApproval: 180,      // seconds (used by duo-poll.ts)
  duoApprovalCrm: 60,    // seconds
  retryDelay: 5_000,
} as const;

// ─── Screen layout ──────────────────────────────────────────
export const SCREEN = {
  width: 2560,
  height: 1440,
} as const;

// ─── Annual dates (UPDATE EACH FISCAL YEAR) ─────────────────
export const ANNUAL_DATES = {
  /** Job end date for dining hires — update each June */
  jobEndDate: "06/30/2026",
  /** Default end date for Kronos report range */
  kronosDefaultEndDate: "2/1/2026",
  kronosDefaultStartDate: "1/1/2017",
} as const;

// ─── URLs not yet centralized ───────────────────────────────
export const KUALI_SPACE_URL =
  "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";
export const NEW_KRONOS_URL =
  "https://ucsd-sso.prd.mykronos.com/wfd/home";
export const CRM_ENTRY_URL = "https://crm.ucsd.edu/hr";
```

- [ ] **Step 2: Update old-kronos-reports/config.ts to re-export**

```typescript
// src/workflows/old-kronos-reports/config.ts
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { PATHS, SCREEN, ANNUAL_DATES } from "../../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPORTS_DIR = PATHS.reportsDir;
export const SESSION_DIR = PATHS.ukgSessionBase;
export const DEFAULT_START_DATE = ANNUAL_DATES.kronosDefaultStartDate;
export const DEFAULT_END_DATE = ANNUAL_DATES.kronosDefaultEndDate;
export const DEFAULT_WORKERS = 4;
export const SCREEN_WIDTH = SCREEN.width;
export const SCREEN_HEIGHT = SCREEN.height;
export const BATCH_FILE = join(__dirname, "batch.yaml");
export const TRACKER_PATH = join(__dirname, "kronos-tracker.xlsx");
```

- [ ] **Step 3: Update separations/config.ts to re-export**

```typescript
// src/workflows/separations/config.ts
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import {
  KUALI_SPACE_URL as _KUALI,
  NEW_KRONOS_URL as _KRONOS,
  SCREEN,
} from "../../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const KUALI_SPACE_URL = _KUALI;
export const NEW_KRONOS_URL = _KRONOS;
export const SCREEN_WIDTH = SCREEN.width;
export const SCREEN_HEIGHT = SCREEN.height;
export const BATCH_FILE = join(__dirname, "batch.yaml");
export const UC_VOL_TERM_TEMPLATE = "UC_VOL_TERM";
export const UC_INVOL_TERM_TEMPLATE = "UC_INVOL_TERM";
export const INVOLUNTARY_TYPES = ["Never Started Employment"];
```

- [ ] **Step 4: Update hardcoded paths in code**

In `src/old-kronos/reports.ts` line 266, replace hardcoded `C:\Users\juzaw\Downloads` with:
```typescript
import { PATHS } from "../config.js";
// Use PATHS.downloadsDir
```

In `src/workflows/separations/workflow.ts` line 179, replace hardcoded `C:\Users\juzaw\ukg_session_sep` with:
```typescript
import { PATHS } from "../../config.js";
// Use PATHS.ukgSessionSep
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/workflows/old-kronos-reports/config.ts src/workflows/separations/config.ts src/old-kronos/reports.ts src/workflows/separations/workflow.ts
git commit -m "refactor: centralize paths, timeouts, screen dims, and URLs in config.ts"
```

---

## Task 7: Window Tiling Utility

**Files:**
- Create: `src/browser/tiling.ts`
- Create: `tests/unit/tiling.test.ts`
- Modify: `src/workflows/separations/workflow.ts:97-116`
- Modify: `src/workflows/old-kronos-reports/parallel.ts:105-127`

- [ ] **Step 1: Write the test**

```typescript
// tests/unit/tiling.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTileLayout } from "../../src/browser/tiling.js";

describe("computeTileLayout", () => {
  it("tiles 4 windows in 2x2 grid", () => {
    const screen = { width: 2560, height: 1440 };
    const t0 = computeTileLayout(0, 4, screen);
    const t3 = computeTileLayout(3, 4, screen);

    assert.deepEqual(t0.position, { x: 0, y: 0 });
    assert.equal(t0.size.width, 1280);
    assert.equal(t0.size.height, 720);

    assert.deepEqual(t3.position, { x: 1280, y: 720 });
  });

  it("tiles 1 window as fullscreen", () => {
    const screen = { width: 2560, height: 1440 };
    const t = computeTileLayout(0, 1, screen);
    assert.equal(t.size.width, 2560);
    assert.equal(t.size.height, 1440);
  });

  it("tiles 9 windows in 3x3 grid", () => {
    const screen = { width: 2700, height: 1350 };
    const t = computeTileLayout(0, 9, screen);
    assert.equal(t.size.width, 900);
    assert.equal(t.size.height, 450);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/tiling.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/browser/tiling.ts
import { SCREEN } from "../config.js";

export interface TileLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  args: string[];
}

/**
 * Compute window position and size for tiled browser layouts.
 * Uses a dynamic grid: cols = ceil(sqrt(total)), rows = ceil(total/cols).
 */
export function computeTileLayout(
  index: number,
  total: number,
  screen?: { width: number; height: number },
): TileLayout {
  const W = screen?.width ?? SCREEN.width;
  const H = screen?.height ?? SCREEN.height;

  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const winW = Math.floor(W / cols);
  const winH = Math.floor(H / rows);

  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = col * winW;
  const y = row * winH;

  return {
    position: { x, y },
    size: { width: winW, height: winH },
    viewport: { width: winW - 20, height: winH - 80 },
    args: [
      `--window-position=${x},${y}`,
      `--window-size=${winW},${winH}`,
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/unit/tiling.test.ts`
Expected: PASS

- [ ] **Step 5: Replace tiling code in separations**

In `src/workflows/separations/workflow.ts`, replace `getTileArgs` (lines 97-116) with:
```typescript
import { computeTileLayout } from "../../browser/tiling.js";

// Replace getTileArgs(index) calls with:
const tile = computeTileLayout(index, 4);
// Use tile.viewport and tile.args
```

- [ ] **Step 6: Replace tiling code in kronos-reports**

In `src/workflows/old-kronos-reports/parallel.ts`, replace the inline grid math (lines 105-127) with:
```typescript
import { computeTileLayout } from "../../browser/tiling.js";

// Replace manual cols/rows/winW/winH with:
const tile = computeTileLayout(i, actualWorkers);
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/browser/tiling.ts tests/unit/tiling.test.ts src/workflows/separations/workflow.ts src/workflows/old-kronos-reports/parallel.ts
git commit -m "refactor: extract window tiling into shared browser/tiling.ts"
```

---

## Task 8: JSONL Live Tracker

**Files:**
- Create: `src/tracker/jsonl.ts`
- Create: `tests/unit/jsonl.test.ts`
- Modify: `src/tracker/index.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/unit/jsonl.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { trackEvent, readEntries, type TrackerEntry } from "../../src/tracker/jsonl.js";

const TEST_DIR = ".tracker-test";

describe("JSONL tracker", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("writes and reads entries", () => {
    const entry: TrackerEntry = {
      workflow: "test",
      timestamp: new Date().toISOString(),
      id: "emp-001",
      status: "done",
      data: { name: "Test Employee" },
    };

    trackEvent(entry, TEST_DIR);
    const entries = readEntries("test", TEST_DIR);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "emp-001");
    assert.equal(entries[0].status, "done");
  });

  it("appends multiple entries", () => {
    trackEvent({ workflow: "test", timestamp: "t1", id: "a", status: "running" }, TEST_DIR);
    trackEvent({ workflow: "test", timestamp: "t2", id: "b", status: "done" }, TEST_DIR);

    const entries = readEntries("test", TEST_DIR);
    assert.equal(entries.length, 2);
  });

  it("returns empty array for missing file", () => {
    const entries = readEntries("nonexistent", TEST_DIR);
    assert.deepEqual(entries, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/jsonl.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/tracker/jsonl.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const DEFAULT_DIR = ".tracker";

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

function getLogPath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}.jsonl`);
}

/** Append a tracker entry. Atomic on NTFS for small writes. */
export function trackEvent(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const logPath = getLogPath(entry.workflow, dir);
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/** Read all entries for a workflow (today's file). */
export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  const logPath = getLogPath(workflow, dir);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/unit/jsonl.test.ts`
Expected: PASS

- [ ] **Step 5: Update tracker/index.ts**

```typescript
// src/tracker/index.ts
export { appendRow, parseDepartmentNumber } from "./spreadsheet.js";
export type { ColumnDef } from "./spreadsheet.js";
export { createLockedTracker } from "./locked.js";
export { trackEvent, readEntries } from "./jsonl.js";
export type { TrackerEntry } from "./jsonl.js";
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/jsonl.ts tests/unit/jsonl.test.ts src/tracker/index.ts
git commit -m "feat: add JSONL append-only tracker for live progress monitoring"
```

---

## Task 9: Live Dashboard Server

**Files:**
- Create: `src/tracker/dashboard.ts`

- [ ] **Step 1: Write the dashboard server**

```typescript
// src/tracker/dashboard.ts
import { createServer, type Server } from "http";
import { readEntries } from "./jsonl.js";
import { log } from "../utils/log.js";

let server: Server | null = null;

/** Start the live monitoring dashboard. Call once at workflow start. */
export function startDashboard(workflow: string, port: number = 3838): void {
  if (server) return;

  server = createServer((req, res) => {
    if (req.url === "/api/entries") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readEntries(workflow)));
      return;
    }

    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const interval = setInterval(() => {
        const entries = readEntries(workflow);
        res.write(`data: ${JSON.stringify(entries)}\n\n`);
      }, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    // Serve HTML dashboard
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML.replace("{{WORKFLOW}}", workflow));
  });

  server.listen(port, () => {
    log.step(`Live dashboard: http://localhost:${port}`);
  });
}

/** Stop the dashboard server. Call at workflow end. */
export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>HR Automation — {{WORKFLOW}}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 16px; color: #f8fafc; }
  .stats { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { background: #1e293b; border-radius: 8px; padding: 16px 24px; min-width: 120px; }
  .stat-value { font-size: 2rem; font-weight: 700; }
  .stat-label { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; margin-top: 4px; }
  .done .stat-value { color: #4ade80; }
  .failed .stat-value { color: #f87171; }
  .running .stat-value { color: #60a5fa; }
  .total .stat-value { color: #f8fafc; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
  th { background: #334155; padding: 10px 14px; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; }
  td { padding: 10px 14px; border-top: 1px solid #334155; font-size: 0.875rem; }
  tr.done td:nth-child(2) { color: #4ade80; }
  tr.failed td:nth-child(2) { color: #f87171; }
  tr.running td:nth-child(2) { color: #60a5fa; }
  tr.pending td:nth-child(2) { color: #94a3b8; }
  .error { color: #fca5a5; font-size: 0.75rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: #94a3b8; font-size: 0.75rem; }
</style>
</head>
<body>
<h1>{{WORKFLOW}}</h1>
<div class="stats" id="stats"></div>
<table>
<thead><tr><th>ID</th><th>Status</th><th>Step</th><th>Time</th><th>Error</th></tr></thead>
<tbody id="tbody"></tbody>
</table>
<script>
const es = new EventSource("/events");
es.onmessage = (e) => {
  const entries = JSON.parse(e.data);
  const latest = new Map();
  entries.forEach(en => latest.set(en.id, en));
  const rows = [...latest.values()];
  const done = rows.filter(r => r.status === "done").length;
  const failed = rows.filter(r => r.status === "failed").length;
  const running = rows.filter(r => r.status === "running").length;
  const total = rows.length;
  document.getElementById("stats").innerHTML =
    '<div class="stat total"><div class="stat-value">' + total + '</div><div class="stat-label">Total</div></div>' +
    '<div class="stat done"><div class="stat-value">' + done + '</div><div class="stat-label">Done</div></div>' +
    '<div class="stat failed"><div class="stat-value">' + failed + '</div><div class="stat-label">Failed</div></div>' +
    '<div class="stat running"><div class="stat-value">' + running + '</div><div class="stat-label">Running</div></div>';
  document.getElementById("tbody").innerHTML = rows.map(r =>
    '<tr class="' + r.status + '">' +
    '<td>' + r.id + '</td>' +
    '<td>' + r.status + '</td>' +
    '<td>' + (r.step || "-") + '</td>' +
    '<td class="time">' + (r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "") + '</td>' +
    '<td class="error">' + (r.error || "") + '</td></tr>'
  ).join("");
};
</script>
</body>
</html>`;
```

- [ ] **Step 2: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "feat: add live SSE dashboard for real-time workflow monitoring"
```

---

## Task 10: Wire JSONL + Dashboard Into Workflows

**Files:**
- Modify: `src/workflows/onboarding/tracker.ts`
- Modify: `src/workflows/eid-lookup/tracker.ts`
- Modify: `src/workflows/old-kronos-reports/tracker.ts`
- Modify: `src/workflows/work-study/tracker.ts`
- Modify: `src/workflows/onboarding/workflow.ts` (dashboard start/stop)
- Modify: `src/workflows/eid-lookup/workflow.ts` (dashboard start/stop)
- Modify: `src/workflows/old-kronos-reports/parallel.ts` (dashboard start/stop)
- Modify: `src/workflows/work-study/workflow.ts` (dashboard start/stop)

- [ ] **Step 1: Add trackEvent calls to onboarding tracker**

In `src/workflows/onboarding/tracker.ts`, add a JSONL write alongside the Excel write:

```typescript
import { trackEvent } from "../../tracker/jsonl.js";

// At the end of updateOnboardingTracker, add:
trackEvent({
  workflow: "onboarding",
  timestamp: data.timestamp ?? new Date().toISOString(),
  id: data.email ?? `${data.lastName}, ${data.firstName}`,
  status: data.status === "Done" ? "done" : data.status === "Failed" ? "failed" : "running",
  step: data.crmExtraction === "Done" ? "transaction" : "extraction",
  data: { firstName: data.firstName ?? "", lastName: data.lastName ?? "" },
  error: data.error,
});
```

- [ ] **Step 2: Add trackEvent calls to EID lookup tracker**

In `src/workflows/eid-lookup/tracker.ts`:
```typescript
import { trackEvent } from "../../tracker/jsonl.js";

// In updateEidTracker, add:
trackEvent({
  workflow: "eid-lookup",
  timestamp: new Date().toISOString(),
  id: searchName,
  status: result.emplId === "Not Found" ? "failed" : "done",
  data: { emplId: result.emplId, name: result.employeeName ?? "" },
});
```

- [ ] **Step 3: Add trackEvent calls to Kronos tracker**

In `src/workflows/old-kronos-reports/tracker.ts`:
```typescript
import { trackEvent } from "../../tracker/jsonl.js";

// In updateKronosTracker, add:
trackEvent({
  workflow: "kronos-reports",
  timestamp: data.timestamp ?? new Date().toISOString(),
  id: data.emplId,
  status: data.status === "Done" ? "done" : "failed",
  data: { name: data.name ?? "", saved: data.saved ?? "" },
  error: data.notes,
});
```

- [ ] **Step 4: Add trackEvent calls to work-study tracker**

In `src/workflows/work-study/tracker.ts`:
```typescript
import { trackEvent } from "../../tracker/jsonl.js";

// In updateWorkStudyTracker, add:
trackEvent({
  workflow: "work-study",
  timestamp: data.timestamp ?? new Date().toISOString(),
  id: data.emplId,
  status: data.status === "Done" ? "done" : "failed",
  data: { name: data.employeeName ?? "" },
  error: data.error,
});
```

- [ ] **Step 5: Start dashboard in each workflow entry point**

Add `startDashboard` / `stopDashboard` at the top/bottom of each workflow's main function:

```typescript
import { startDashboard, stopDashboard } from "../../tracker/dashboard.js";

// At workflow start:
startDashboard("onboarding"); // or "eid-lookup", "kronos-reports", "work-study"

// At workflow end (in finally block):
stopDashboard();
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/workflows/*/tracker.ts src/workflows/*/workflow.ts src/workflows/*/parallel.ts
git commit -m "feat: wire JSONL tracking and live dashboard into all workflows"
```

---

## Task 11: WorkflowSession Class

**Files:**
- Create: `src/browser/session.ts`
- Reference: `src/browser/launch.ts` (kept for backward compat)

- [ ] **Step 1: Write the implementation**

```typescript
// src/browser/session.ts
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { log } from "../utils/log.js";
import type { TileLayout } from "./tiling.js";

export interface SessionWindowOptions {
  viewport?: { width: number; height: number };
  args?: string[];
}

/**
 * Manages a shared browser session for an entire workflow run.
 * All windows in the workflow share auth cookies via a single persistent context.
 */
export class WorkflowSession {
  private context: BrowserContext;
  private browser: Browser | null;
  private pages: Map<string, Page> = new Map();
  readonly sessionDir: string;

  private constructor(
    context: BrowserContext,
    browser: Browser | null,
    sessionDir: string,
  ) {
    this.context = context;
    this.browser = browser;
    this.sessionDir = sessionDir;
  }

  /** Create a shared workflow session (persistent context with temp dir). */
  static async create(options?: SessionWindowOptions & {
    acceptDownloads?: boolean;
  }): Promise<WorkflowSession> {
    const sessionDir = join(tmpdir(), `hr-auto-${randomUUID().slice(0, 8)}`);
    const context = await chromium.launchPersistentContext(sessionDir, {
      headless: false,
      viewport: options?.viewport ?? { width: 1920, height: 1080 },
      acceptDownloads: options?.acceptDownloads ?? false,
      args: options?.args,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session = new WorkflowSession(context, null, sessionDir);
    session.pages.set("default", page);
    log.step(`Session created: ${sessionDir}`);
    return session;
  }

  /**
   * Create an isolated session (separate browser, no shared cookies).
   * Use when a second UCPath window would cause SSO conflicts.
   */
  static async createIsolated(options?: SessionWindowOptions & {
    acceptDownloads?: boolean;
  }): Promise<WorkflowSession> {
    const browser = await chromium.launch({
      headless: false,
      args: options?.args,
    });
    const context = await browser.newContext({
      viewport: options?.viewport ?? { width: 1920, height: 1080 },
      acceptDownloads: options?.acceptDownloads ?? false,
    });
    const page = await context.newPage();
    const session = new WorkflowSession(context, browser, "");
    session.pages.set("default", page);
    return session;
  }

  /** Get the first/default page. */
  get defaultPage(): Page {
    return this.pages.get("default")!;
  }

  /** Open a new window (tab) in this session. */
  async newWindow(name: string, options?: SessionWindowOptions): Promise<Page> {
    const page = await this.context.newPage();
    if (options?.viewport) {
      await page.setViewportSize(options.viewport);
    }
    this.pages.set(name, page);
    return page;
  }

  /** Open a new tiled window using a TileLayout. */
  async newTiledWindow(name: string, tile: TileLayout): Promise<Page> {
    const page = await this.context.newPage();
    await page.setViewportSize(tile.viewport);
    this.pages.set(name, page);
    return page;
  }

  /** Get a named window. */
  getWindow(name: string): Page | undefined {
    return this.pages.get(name);
  }

  /** Get all pages in this session. */
  get allPages(): Page[] {
    return [...this.pages.values()];
  }

  /** Close the session and clean up temp directory. */
  async close(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
      } else {
        await this.context.close();
      }
    } catch {
      // Ignore close errors
    }
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true });
        log.step(`Session cleaned up: ${this.sessionDir}`);
      } catch {
        // Non-fatal
      }
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/browser/session.ts
git commit -m "feat: add WorkflowSession class for shared per-workflow browser sessions"
```

---

## Task 12: Fix EID Lookup Race Condition

**Files:**
- Modify: `src/workflows/eid-lookup/workflow.ts`

- [ ] **Step 1: Add mutex to EID lookup parallel mode**

The EID lookup parallel mode calls `updateEidTracker()` from multiple worker tabs without mutex protection. Since we now have `createLockedTracker` and JSONL tracking (which is append-safe), fix the Excel race condition:

In `src/workflows/eid-lookup/workflow.ts`, in the `lookupParallel` function, wrap the tracker calls with a mutex:

```typescript
import { Mutex } from "async-mutex";
import { createLockedTracker } from "../../tracker/locked.js";

// In lookupParallel, before spawning workers:
const mutex = new Mutex();
const lockedEidTracker = createLockedTracker(mutex, updateEidTracker);

// Replace direct updateEidTracker calls with lockedEidTracker
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/workflows/eid-lookup/workflow.ts
git commit -m "fix: add mutex to EID lookup parallel mode to prevent tracker race condition"
```

---

## Task 13: Excel Export from JSONL

**Files:**
- Create: `src/tracker/export-excel.ts`
- Modify: `src/cli.ts` (add export command)

- [ ] **Step 1: Write the export function**

```typescript
// src/tracker/export-excel.ts
import ExcelJS from "exceljs";
import { readEntries, type TrackerEntry } from "./jsonl.js";
import { log } from "../utils/log.js";

/**
 * Export JSONL tracker data to an Excel file.
 * Groups entries by date and creates a worksheet per date.
 */
export async function exportToExcel(
  workflow: string,
  outputPath?: string,
): Promise<string> {
  const entries = readEntries(workflow);
  if (entries.length === 0) {
    log.error(`No entries found for workflow "${workflow}"`);
    return "";
  }

  const outPath = outputPath ?? `${workflow}-export.xlsx`;
  const workbook = new ExcelJS.Workbook();

  // Group by date
  const byDate = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const group = byDate.get(date) ?? [];
    group.push(entry);
    byDate.set(date, group);
  }

  // Dedupe: keep latest entry per ID per date
  for (const [date, group] of byDate) {
    const latest = new Map<string, TrackerEntry>();
    for (const entry of group) {
      latest.set(entry.id, entry);
    }

    const sheet = workbook.addWorksheet(date);
    sheet.columns = [
      { header: "ID", key: "id", width: 30 },
      { header: "Status", key: "status", width: 12 },
      { header: "Step", key: "step", width: 20 },
      { header: "Error", key: "error", width: 40 },
      { header: "Timestamp", key: "timestamp", width: 22 },
      // Data fields as additional columns
    ];
    sheet.getRow(1).font = { bold: true };

    for (const entry of latest.values()) {
      sheet.addRow({
        id: entry.id,
        status: entry.status,
        step: entry.step ?? "",
        error: entry.error ?? "",
        timestamp: entry.timestamp,
      });
    }
  }

  await workbook.xlsx.writeFile(outPath);
  log.success(`Exported ${entries.length} entries to ${outPath}`);
  return outPath;
}
```

- [ ] **Step 2: Add CLI export command**

In `src/cli.ts`, add:
```typescript
import { exportToExcel } from "./tracker/export-excel.js";

program
  .command("export <workflow>")
  .description("Export JSONL tracker data to Excel")
  .option("-o, --output <path>", "Output file path")
  .action(async (workflow: string, opts: { output?: string }) => {
    await exportToExcel(workflow, opts.output);
  });
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tracker/export-excel.ts src/cli.ts
git commit -m "feat: add CLI command to export JSONL tracker data to Excel"
```

---

## Task 14: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md with new architecture**

Add sections documenting:
- New shared utilities (`src/auth/sso-fields.ts`, `src/auth/duo-poll.ts`, `src/utils/worker-pool.ts`, `src/utils/screenshot.ts`, `src/browser/tiling.ts`, `src/tracker/locked.ts`)
- JSONL tracker + live dashboard (`src/tracker/jsonl.ts`, `src/tracker/dashboard.ts`)
- WorkflowSession class (`src/browser/session.ts`)
- Config centralization (PATHS, TIMEOUTS, SCREEN, ANNUAL_DATES in `src/config.ts`)
- `npm run export` CLI command
- Updated architecture diagram

Update the "Key Patterns" section:
- Add: "Use `fillSsoCredentials()` and `pollDuoApproval()` — never write inline SSO/Duo loops"
- Add: "Use `trackEvent()` for progress tracking — JSONL is append-safe, no file locks"
- Add: "Use `WorkflowSession.create()` for new workflows — shares auth across all windows"
- Add: "Use `computeTileLayout()` for multi-browser window positioning"
- Add: "Use `runWorkerPool()` for parallel processing — handles queue, errors, teardown"

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with new shared utilities, session model, and live tracker"
```

---

## Verification Plan

1. **After each task**: `npm run typecheck && npm test` — types and unit tests pass
2. **After Task 2** (Duo poll): Run `npm run test-login` to verify UCPath auth still works end-to-end
3. **After Task 8-9** (JSONL + dashboard): Run any workflow, then open `http://localhost:3838` — verify live updates appear
4. **After Task 10**: Run `npx tsx --env-file=.env src/cli.ts export onboarding` — verify Excel export from JSONL
5. **After Task 12**: Run EID lookup with `--workers 4` — verify no tracker data loss
6. **Final**: Run each workflow once (dry-run where available) to verify no regressions
