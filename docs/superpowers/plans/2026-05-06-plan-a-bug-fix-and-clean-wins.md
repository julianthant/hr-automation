# Plan A — Bug Fix + Clean Wins (Pathfinder U5 + U4 + P1)

> **For agentic workers:** This plan is structured for **subagent-driven execution**. The orchestrator (Opus) dispatches one Sonnet subagent per Task. The orchestrator does NOT review subagent diffs between tasks — trust the subagent ran the per-task verification commands. Final review is by Codex over the combined diff (after all three plans land), per `~/.claude/CLAUDE.md`.

**Goal:** Consolidate retry-input lookup, unify daemon terminal-state marking, and move work-study selectors into the registry. Three independent behavior-preserving refactors on disjoint file sets.

**Architecture:** Refactor rhythm — `baseline tests green → make change → tests still green → commit` per task. No new tests written; existing coverage protects against regressions.

**Tech Stack:** TypeScript, Vitest, Zod.

**Source Pathfinder artifacts:**
- `PATHFINDER-2026-05-06/02-duplication-report.md` — findings A4, B1, B2
- `PATHFINDER-2026-05-06/03-unified-proposal.md` — sections U4, U5, P1
- `PATHFINDER-2026-05-06/05-addendum-opus-pass.md` — confirmation pass

**Branch & worktree:**
- Branch off `master` (a clean master, not the current `codex/active-check-dry-run-ocr-e2e` branch which has unrelated dashboard work in progress).
- Recommended: `git checkout -b pathfinder/plan-a-quick-wins master`. Worktree optional — this plan is small enough to fit a single working directory.
- The Pathfinder reports live in `PATHFINDER-2026-05-06/` (untracked). Do NOT commit them.

**Parallelism:**
- **Within this plan:** Tasks 1, 2, 3 touch disjoint files and could be dispatched in parallel. Default to sequential dispatch to keep commits ordered cleanly on one branch. If you do dispatch in parallel, have the orchestrator collect each subagent's diff and commit them in order (1 → 2 → 3) afterward.
- **Across plans (Plans A / B / C):** All three plans touch disjoint files. Different sessions can run them in parallel safely.

**Anti-pattern guards (apply to every task):**
- DO NOT add comments explaining what code does. Comments only for non-obvious WHY (a hidden constraint, a workaround for a specific bug). DO NOT reference Pathfinder IDs (e.g. "U5 from Pathfinder") in code comments — they rot.
- DO NOT introduce new abstraction layers beyond what's specified.
- DO NOT change public function signatures.
- DO NOT add backwards-compat shims (renamed re-exports, deprecation aliases).
- DO NOT skip `--no-verify` on git commits or hooks. If a hook fails, fix the underlying issue.

---

## Task 1 — U5: Centralize retry input lookup

**Subagent model:** Sonnet.

**Goal:** Replace the `findEntryInput` JSONL-only fallback (called from `reEnqueueEntry`) with a single canonical 3-tier function in `src/core/`. The tier chain is identical to what's already implemented in `findEntryInput` + `findTaskInput` today; the change is location (move SQLite tier into the new function so all callers share it) and naming.

**Honest framing of the "bug":** The Pathfinder report described a "double SQLite check" between `reEnqueueEntry` line 405 and `findEntryInput`'s internal `findTaskInput` call. Reading the current code, both checks DO hit SQLite, but via different identity keys (Path A uses `(workflow, id, runId)` composite identity via `resolveControlTask`; `findTaskInput` uses `runId` only via `store.findInputForRunId`). They are NOT strictly redundant — Path A misses can be saved by Path B hits when data is inconsistent. The real win of this consolidation is **one canonical input-lookup function** for future callers (daemon code will need this when SQLite-only mode lands), not bug-fixing. Do NOT remove Path A — its purpose is `retryTaskFromAttempt` + `worker_command` enqueue (preserves task identity as new attempt), which is different from Path B's "create a new task with the original input" purpose.

**Files:**
- Create: `src/core/find-input.ts`
- Modify: `src/tracker/dashboard-ops.ts` (refactor `findEntryInput` to delegate; do NOT touch lines 402–437 — that's Path A and stays)

### Steps

- [ ] **Step 1.1: Confirm baseline tests green.**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all
npm run test -- tests/unit/tracker/dashboard-ops.test.ts
npm run test -- tests/unit/core
```

Expected: all green. If any failure, STOP and report — do not proceed.

- [ ] **Step 1.2: Read the current `findEntryInput` body** so the new function can preserve its exact behavior.

```bash
sed -n '230,290p' src/tracker/dashboard-ops.ts
```

Note especially:
- Tier 0 (SQLite by runId): `findTaskInput(runId, dir)` calls `createTaskStore(openControlDb({ trackerDir: dir })).findInputForRunId(runId)`. Returns `Record<string, unknown> | null`.
- Tier 1: pending row with stored `input`, latest first.
- Tier 2: any row with stored `input`, latest first.
- Tier 3: latest row's `data` minus kernel keys (`KERNEL_DATA_KEYS` set).

- [ ] **Step 1.3: Create `src/core/find-input.ts`.**

```ts
import { readEntries } from "../tracker/jsonl.js";
import { createTaskStore } from "./task-store.js";
import { openControlDb } from "./control-db.js";

const KERNEL_DATA_KEYS = new Set(["__name", "__id", "instance"]);

/**
 * Canonical retry-input lookup. Three tiers, returned in the first-hit order:
 *   1. SQLite task store keyed by runId (authoritative when available).
 *   2. JSONL row's stored `input` field (pending row preferred, else any).
 *   3. JSONL latest row's `data` minus kernel keys (best-effort reconstruct).
 *
 * Returns `undefined` only when nothing matched — caller decides whether
 * that is an error or a soft skip. Workflow schemas are non-strict
 * `z.object` so any extra fields produced by tier 3 are stripped at
 * validation time.
 */
export async function findInputForRetry(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<Record<string, unknown> | undefined> {
  if (runId) {
    const fromTask = findTaskInput(runId, dir);
    if (fromTask) return fromTask;
  }

  const entries = readEntries(workflow, dir).filter((e) => {
    if (e.id !== id) return false;
    if (runId && e.runId !== runId) return false;
    return true;
  });
  if (entries.length === 0) return undefined;

  const pendingWithInput = entries
    .filter((e) => e.status === "pending" && Boolean(e.input))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (pendingWithInput.length > 0) {
    return pendingWithInput[0].input as Record<string, unknown>;
  }

  const anyWithInput = entries
    .filter((e) => Boolean(e.input))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (anyWithInput.length > 0) {
    return anyWithInput[0].input as Record<string, unknown>;
  }

  const sorted = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const data = sorted[0].data;
  if (data && typeof data === "object") {
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (KERNEL_DATA_KEYS.has(k)) continue;
      input[k] = v;
    }
    if (Object.keys(input).length > 0) return input;
  }

  return undefined;
}

function findTaskInput(runId: string, dir: string): Record<string, unknown> | null {
  try {
    const store = createTaskStore(openControlDb({ trackerDir: dir }));
    const input = store.findInputForRunId(runId);
    return input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 1.4: Refactor `findEntryInput` in `src/tracker/dashboard-ops.ts` to delegate.**

Replace lines 242–287 (the existing `findEntryInput` body) with a thin wrapper that calls `findInputForRetry` and reshapes the return into the existing `{ input } | { error }` shape consumed by `reEnqueueEntry`. Do NOT remove the export — it's still used by callers in `reEnqueueEntry`.

```ts
import { findInputForRetry } from "../core/find-input.js";

// ... (keep KERNEL_DATA_KEYS constant import or definition only if other functions in this file still reference it; otherwise delete)

export async function findEntryInput(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<{ input: Record<string, unknown> } | { error: string }> {
  const input = await findInputForRetry(workflow, id, runId, dir);
  if (input) return { input };

  // Distinguish "no rows at all" from "rows exist but no input recoverable"
  // so the dashboard error surface stays informative.
  const entries = readEntries(workflow, dir).filter((e) => {
    if (e.id !== id) return false;
    if (runId && e.runId !== runId) return false;
    return true;
  });
  if (entries.length === 0) {
    return { error: `no tracker entry found for id=${id}` };
  }
  return { error: "no input or data found to reconstruct retry payload" };
}
```

Update the **awaited** call site in `reEnqueueEntry`:

```ts
// dashboard-ops.ts line ~443 — was: const lookup = findEntryInput(wf, id, runId, dir);
const lookup = await findEntryInput(wf, id, runId, dir);
```

`findEntryInput` is now async (was sync). Grep for callers and add `await` everywhere:

```bash
grep -rn "findEntryInput(" src/ tests/
```

Expected callers (verify): `src/tracker/dashboard-ops.ts` `reEnqueueEntry`, possibly tests. Update each to `await`.

Delete the now-unused private helpers (`findTaskInput`, the `KERNEL_DATA_KEYS` constant if no other consumer remains — keep if `findLatestEntryData` uses it; verify with grep first):

```bash
grep -n "KERNEL_DATA_KEYS\|findTaskInput" src/tracker/dashboard-ops.ts
```

- [ ] **Step 1.5: Verify.**

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

Expected: all green. If a test fails, the most likely cause is a missing `await`. Grep the failing test for `findEntryInput` and add the keyword.

- [ ] **Step 1.6: Commit.**

```bash
git add src/core/find-input.ts src/tracker/dashboard-ops.ts
git commit -m "$(cat <<'EOF'
refactor(core): centralize retry input lookup in src/core/find-input.ts

findInputForRetry replaces findEntryInput's inline 3-tier chain with one
canonical async function in src/core/, importable by both dashboard and
future daemon callers. findEntryInput becomes a thin wrapper preserving
the {input} | {error} shape consumed by reEnqueueEntry.

Path A (resolveControlTask + retryTaskFromAttempt + worker_command) in
reEnqueueEntry is unchanged — it has different semantics (new attempt of
same task, not new task) and is preserved as-is.
EOF
)"
```

---

## Task 2 — U4: Unify terminal-state marking in daemon-queue

**Subagent model:** Sonnet.

**Goal:** Three near-identical functions in `src/core/daemon-queue.ts` (`markItemDone`, `markItemFailed`, `markItemCancelled`) collapse onto one private `markTaskTerminal` helper. Public function signatures are UNCHANGED — they become 2–3 line wrappers. Callers in `daemon.ts` are not affected.

**Files:**
- Modify: `src/core/daemon-queue.ts` (lines 492–544 currently; will shrink)

### Steps

- [ ] **Step 2.1: Confirm baseline tests green.**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all
npm run test -- tests/unit/core
```

Expected: green.

- [ ] **Step 2.2: Read the current implementation.**

```bash
sed -n '480,550p' src/core/daemon-queue.ts
```

Note the three functions and the shared shape: `findTaskByIdentity` → `resolveCurrentAttemptId` → conditional `markTask*` (or `markTaskTerminalWithoutAttempt` fallback) → `appendEvent`. Also note:
- `markItemCancelled` writes a `failed` event type (with `error: reason`), NOT a `cancelled` event. Preserve this exactly — the JSONL audit schema must stay stable.
- `markItemDone` and `markItemFailed` use `markTaskTerminalWithoutAttempt(store, task.taskId, ...)` when `attemptId` is undefined; `markItemCancelled` does NOT have this fallback (it goes through `markTaskCancelled` which accepts an optional `attemptId`).
- The `if (queueBackend() === 'jsonl') return legacyXxx(...)` gate stays at the top of each public function — `markTaskTerminal` is SQLite-only.

- [ ] **Step 2.3: Add the private helper at the top of the SQLite-mode block.**

Insert this private function above `markItemDone` (around line 490):

```ts
type TerminalStatus = 'done' | 'failed' | 'cancelled'

async function markTaskTerminal(
  workflow: string,
  itemId: string,
  runId: string,
  status: TerminalStatus,
  payload: { error?: string; reason?: string },
  trackerDir: string | undefined,
): Promise<void> {
  const store = openQueueTaskStore(trackerDir)
  const task = store.findTaskByIdentity({ workflow, itemId, runId })
  const attemptId = task ? resolveCurrentAttemptId(store, task, runId) : undefined

  if (task) {
    if (status === 'done') {
      if (attemptId) store.markTaskDone({ taskId: task.taskId, attemptId })
      else markTaskTerminalWithoutAttempt(store, task.taskId, 'done')
    } else if (status === 'failed') {
      if (attemptId) store.markTaskFailed({ taskId: task.taskId, attemptId, error: payload.error ?? '' })
      else markTaskTerminalWithoutAttempt(store, task.taskId, 'failed', payload.error)
    } else {
      // cancelled: preserves prior behavior of passing optional attemptId
      store.markTaskCancelled({
        taskId: task.taskId,
        ...(attemptId ? { attemptId } : {}),
        reason: payload.reason ?? '',
      })
    }
  }

  // Audit JSONL schema unchanged: cancelled emits as `failed` with error=reason.
  if (status === 'done') {
    appendEvent(workflow, { type: 'done', id: itemId, completedAt: nowIso(), runId }, trackerDir)
  } else {
    const error = status === 'failed' ? (payload.error ?? '') : (payload.reason ?? '')
    appendEvent(workflow, { type: 'failed', id: itemId, failedAt: nowIso(), runId, error }, trackerDir)
  }
}
```

- [ ] **Step 2.4: Replace the three public function bodies with wrappers.**

```ts
export async function markItemDone(
  workflow: string,
  itemId: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemDone(workflow, itemId, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'done', {}, trackerDir)
}

export async function markItemFailed(
  workflow: string,
  itemId: string,
  error: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemFailed(workflow, itemId, error, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'failed', { error }, trackerDir)
}

export async function markItemCancelled(
  workflow: string,
  itemId: string,
  reason: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemFailed(workflow, itemId, reason, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'cancelled', { reason }, trackerDir)
}
```

Public signatures, JSONL legacy gate, and audit JSONL output are all byte-identical to before. Only the SQLite-mode body changed.

- [ ] **Step 2.5: Verify.**

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

Expected: green. If `tests/unit/core/daemon-queue.test.ts` fails, the most likely cause is a behavioral drift in the cancelled path — re-read step 2.2 to confirm `markItemCancelled` still writes `type: 'failed'` (not `cancelled`) and includes `error: reason`.

- [ ] **Step 2.6: Commit.**

```bash
git add src/core/daemon-queue.ts
git commit -m "$(cat <<'EOF'
refactor(core): consolidate daemon terminal-state marking via markTaskTerminal

markItemDone/Failed/Cancelled collapse onto one private helper. Public
signatures and JSONL audit output are unchanged — markItemCancelled still
emits type='failed' with error=reason for audit-schema stability. Legacy
JSONL-mode dispatch gate is preserved at each public function entry.
EOF
)"
```

---

## Task 3 — P1: Promote work-study selectors to UCPath registry

**Subagent model:** Sonnet.

**Goal:** Move work-study's inline `getByRole` selectors into a new `paypath` namespace in `src/systems/ucpath/selectors.ts` so they appear in `npm run selector:search` and the auto-generated `SELECTORS.md` catalog. Behavior is unchanged — same `getByRole` calls, just wrapped in named functions.

**Files:**
- Modify: `src/systems/ucpath/selectors.ts` (add `paypath` namespace)
- Modify: `src/workflows/work-study/enter.ts` (replace inline selectors with `paypath.*` calls)
- Regenerate: `src/systems/ucpath/SELECTORS.md` (via `npm run selectors:catalog`)

### Steps

- [ ] **Step 3.1: Confirm baseline tests green.**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all
npm run test -- tests/unit/scripts/selectors-catalog.test.ts
npm run test -- tests/unit/systems/inline-selectors.test.ts
```

Expected: green.

- [ ] **Step 3.2: Read the current selector usage in work-study.**

```bash
grep -n "getByRole\|getByText\|locator(" src/workflows/work-study/enter.ts
```

The selectors to promote (verified 2026-03-17 per the existing comment at line 13):

| Inline selector | Where used (enter.ts) | Proposed registry name |
|---|---|---|
| `page.getByRole("link", { name: "PayPath/Additional Pay" })` | navigateToPayPathActions:47 | `paypath.navigationLink` |
| `page.getByRole("link", { name: "PayPath Actions", exact: true })` | navigateToPayPathActions:52 | `paypath.actionsLink` |
| `frame.getByRole("textbox", { name: "Empl ID" })` | searchEmployee:64 | `paypath.emplIdInput` |
| `frame.getByRole("button", { name: "Search", exact: true })` | searchEmployee:66 | `paypath.searchButton` |
| `page.getByRole("button", { name: "OK" })` | searchEmployee:72 | `paypath.alertOkButton` |
| `frame.locator('[id="UC_E102_PP_WRK_NAME_DISPLAY"]').or(frame.locator('[id*="NAME_DISPLAY"]').first())` | searchEmployee:83-84 | `paypath.employeeNameDisplay` |
| `page.getByRole("button", { name: "Navigation Area" })` | collapseSidebar:94 | `paypath.navigationAreaButton` |
| `frame.getByRole("textbox", { name: "Effective Date:" })` | fillPositionData:113 | `paypath.effectiveDateInput` |
| `frame.getByRole("textbox", { name: "Position Change Reason:" })` | fillPositionData:117 | `paypath.positionChangeReasonInput` |
| `frame.getByRole("textbox", { name: "Position Pool:" })` | fillPositionData:121 | `paypath.positionPoolInput` |
| `frame.getByRole("tab", { name: "Job Data" })` | clickJobDataTab:131 | `paypath.jobDataTab` |
| `frame.getByRole("textbox", { name: "Job Data Comments:" })` | fillJobDataComments:141 | `paypath.jobDataCommentsInput` |
| `frame.getByRole("tab", { name: "Additional Pay Data" })` | clickAdditionalPayTab:150 | `paypath.additionalPayDataTab` |
| `frame.getByRole("textbox", { name: "Initiator's Comments" })` | fillInitiatorComments:160 | `paypath.initiatorsCommentsInput` |
| `frame.locator('[id="UC_E102_PP_WRK_SUBMIT_BTN"]')` (from `SEL_SAVE_AND_SUBMIT`) | clickSaveAndSubmit:167 | `paypath.saveAndSubmitButton` |

- [ ] **Step 3.3: Add the `paypath` namespace to `src/systems/ucpath/selectors.ts`.**

Look at how an existing namespace (e.g. `oathSignature` or `smartHR`) is structured in that file — match its export style, JSDoc convention, and `// verified` date format. Append a new namespace at the natural place (alphabetical or after `personOrgSummary`). Skeleton:

```ts
/**
 * UCPath PayPath Actions — work-study & similar single-employee transactions.
 *
 * @tags ucpath, paypath, work-study, position, effective-date
 */
// verified 2026-05-06
export const paypath = {
  /** Sidebar parent link "PayPath/Additional Pay" — expands sub-items. */
  navigationLink: (page: Page) =>
    page.getByRole("link", { name: "PayPath/Additional Pay" }),

  /** Sidebar sub-item "PayPath Actions". */
  actionsLink: (page: Page) =>
    page.getByRole("link", { name: "PayPath Actions", exact: true }),

  /** Empl ID textbox in the PayPath Actions search form. */
  emplIdInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Empl ID" }),

  /** Search button in the PayPath Actions search form. */
  searchButton: (frame: FrameLocator) =>
    frame.getByRole("button", { name: "Search", exact: true }),

  /** Generic PeopleSoft alert dialog OK button (e.g. "payroll in progress"). */
  alertOkButton: (page: Page) =>
    page.getByRole("button", { name: "OK" }),

  /** Employee name display span in the Position Data header. */
  employeeNameDisplay: (frame: FrameLocator) =>
    frame.locator('[id="UC_E102_PP_WRK_NAME_DISPLAY"]')
      .or(frame.locator('[id*="NAME_DISPLAY"]').first()),

  /** Sidebar collapse/expand toggle. */
  navigationAreaButton: (page: Page) =>
    page.getByRole("button", { name: "Navigation Area" }),

  /** Effective Date textbox on the Position Data tab. */
  effectiveDateInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Effective Date:" }),

  /** Position Change Reason textbox on the Position Data tab. */
  positionChangeReasonInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Position Change Reason:" }),

  /** Position Pool textbox on the Position Data tab. */
  positionPoolInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Position Pool:" }),

  /** Job Data tab. */
  jobDataTab: (frame: FrameLocator) =>
    frame.getByRole("tab", { name: "Job Data" }),

  /** Job Data Comments textbox. */
  jobDataCommentsInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Job Data Comments:" }),

  /** Additional Pay Data tab. */
  additionalPayDataTab: (frame: FrameLocator) =>
    frame.getByRole("tab", { name: "Additional Pay Data" }),

  /** Initiator's Comments textbox on the Additional Pay Data tab. */
  initiatorsCommentsInput: (frame: FrameLocator) =>
    frame.getByRole("textbox", { name: "Initiator's Comments" }),

  /** Save and Submit button (button id UC_E102_PP_WRK_SUBMIT_BTN). */
  saveAndSubmitButton: (frame: FrameLocator) =>
    frame.locator('[id="UC_E102_PP_WRK_SUBMIT_BTN"]'),
} as const
```

If the file's existing namespaces use a different JSDoc/`@tags` style, match that style instead — consistency with the file matters more than the skeleton above.

- [ ] **Step 3.4: Update `src/workflows/work-study/enter.ts`.**

```ts
// At the top — replace existing imports with:
import { paypath } from "../../systems/ucpath/selectors.js";

// Delete the SEL_SAVE_AND_SUBMIT constant (line 17) — it's now in the registry.

// Replace each inline selector with the registry call:
//
// Before: await page.getByRole("link", { name: "PayPath/Additional Pay" }).click(...)
// After:  await paypath.navigationLink(page).click(...)
//
// Before: frame.getByRole("textbox", { name: "Empl ID" }).fill(...)
// After:  paypath.emplIdInput(frame).fill(...)
//
// ... etc per the table in Step 3.2.
```

Replace ALL 15 inline selectors. The function signatures and behavior of `enter.ts` are otherwise unchanged — same waits, same logging, same comment-text builder.

- [ ] **Step 3.5: Regenerate the catalog.**

```bash
npm run selectors:catalog
```

This rewrites `src/systems/ucpath/SELECTORS.md`. Verify the diff includes the new `paypath` namespace entries.

- [ ] **Step 3.6: Verify.**

```bash
npm run typecheck:all
npm run test -- tests/unit/scripts/selectors-catalog.test.ts
npm run test -- tests/unit/systems/inline-selectors.test.ts
npm run test
npm run test:architecture
```

Expected: all green. The inline-selectors test only enforces no inline selectors in `src/systems/` — work-study is in `src/workflows/`, so it never blocked the inline pattern; this change is organizational, not enforcement-driven.

Sanity check the search:

```bash
npm run selector:search "paypath position pool"
```

Expected: top hit is `ucpath.paypath.positionPoolInput`.

- [ ] **Step 3.7: Commit.**

```bash
git add src/systems/ucpath/selectors.ts src/systems/ucpath/SELECTORS.md src/workflows/work-study/enter.ts
git commit -m "$(cat <<'EOF'
refactor(work-study): promote PayPath selectors to ucpath registry

Adds paypath namespace to src/systems/ucpath/selectors.ts (15 selectors,
verified 2026-03-17 in the original enter.ts). Work-study handler now
imports from the registry so npm run selector:search and SELECTORS.md
both reflect every PayPath selector. No behavior change.
EOF
)"
```

---

## Final verification (after all 3 tasks)

```bash
npm run typecheck:all
npm run test
npm run test:architecture
git log --oneline master..HEAD
```

Expected: 3 commits ahead of master, all tests green. If any test fails, the orchestrator should re-dispatch a Sonnet subagent to fix only that failure (not invoke any review skill).

**Stop here.** Do NOT open a PR yet — wait for Plans B and C to complete and Codex final review (per `~/.claude/CLAUDE.md` Superpowers workflow), then surface findings to the orchestrator session for fixes before merging.
