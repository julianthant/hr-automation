# Migrate work-study to the Kernel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the work-study workflow onto the `src/core/` kernel via `defineWorkflow`, and rename `src/ucpath/` → `src/systems/ucpath/` (first per-system dir move in Phase 2). End state: `src/workflows/work-study/workflow.ts` is a thin CLI adapter wrapping a kernel workflow; no raw `launchBrowser` / `withTrackedWorkflow` / `withLogContext` calls in the workflow file.

**Architecture:** One kernel `defineWorkflow` call declaring 1 system (UCPath), 2 steps (`ucpath-auth`, `transaction`), and the existing `WorkStudyInputSchema`. The handler invokes the existing `buildWorkStudyPlan` ActionPlan unchanged. Dry-run stays out of the kernel entirely — the CLI wrapper checks `dryRun` and calls `plan.preview()` without touching a browser, matching today's behavior.

**Tech Stack:** TypeScript (NodeNext ESM), Playwright, Commander, Zod, the in-repo `src/core/` kernel (Session / Stepper / runWorkflow), tsx for execution, Node's built-in test runner.

**Deviations from the spec's per-workflow migration steps (sanctioned):**
- **Single-commit workflow swap** rather than the spec's two-commit "v2 alongside v1 → swap later". Reason: work-study has a CLI-owned dry-run branch; a v2 sitting beside v1 is never exercised until the swap, so the second commit buys no validation. Rollback is one `git revert` either way. Tradeoff accepted: less granular rollback; upside is fewer moving parts and a cleaner diff for review.
- **Mirror the rename in `tests/`** — move `tests/unit/ucpath/` → `tests/unit/systems/ucpath/` alongside the prod rename so test tree tracks src tree. Cheap and keeps future discoverability honest.
- **Move `tracker.ts` Excel write into the handler** (success path) rather than into the CLI wrapper. Old code had access to `wsCtx.employeeName` via lexical scope through the whole function; the kernel puts a boundary between the CLI wrapper and the handler. Writing success-row from inside the handler preserves name access. The failure row (written in the CLI catch) loses the name, a small observability regression accepted because the dashboard has the richer record.

---

## File Structure

### Files affected by Task 1 (directory rename)

**Renamed (via `git mv`):**
- `src/ucpath/` → `src/systems/ucpath/` — 7 files: `action-plan.ts`, `index.ts`, `job-summary.ts`, `navigate.ts`, `personal-data.ts`, `transaction.ts`, `types.ts`, `CLAUDE.md`
- `tests/unit/ucpath/` → `tests/unit/systems/ucpath/` — 2 files: `action-plan.test.ts`, `types.test.ts`

**Import path updates (10 files, `../../ucpath/` → `../../systems/ucpath/` except test files which use `../../../src/ucpath/` → `../../../src/systems/ucpath/`; after the test-dir move they become `../../../../src/systems/ucpath/`):**
- `src/workflows/work-study/workflow.ts`
- `src/workflows/work-study/enter.ts`
- `src/workflows/onboarding/workflow.ts`
- `src/workflows/onboarding/enter.ts`
- `src/workflows/separations/workflow.ts`
- `src/workflows/emergency-contact/workflow.ts`
- `src/workflows/emergency-contact/enter.ts`
- `src/workflows/eid-lookup/search.ts`
- `tests/unit/systems/ucpath/action-plan.test.ts` (post-move; was `tests/unit/ucpath/`)
- `tests/unit/systems/ucpath/types.test.ts` (post-move)

**Docs updated (path references only):**
- `CLAUDE.md` (root) — Architecture tree lists `ucpath/` as top-level; update to `systems/ucpath/`
- `tests/CLAUDE.md` — any `src/ucpath` reference
- `src/workflows/emergency-contact/CLAUDE.md` — any `src/ucpath` reference

### Files affected by Task 2 (workflow swap)

- `src/workflows/work-study/workflow.ts` — **rewritten** as kernel-based. Exports `workStudyWorkflow` (the `RegisteredWorkflow`) and `runWorkStudy` (CLI adapter with dryRun branch + failure-tracker write).
- `src/workflows/work-study/index.ts` — **modified** to also export `workStudyWorkflow`.
- `src/workflows/work-study/enter.ts` — **unchanged content** (import path already fixed in Task 1).
- `src/workflows/work-study/schema.ts` — **unchanged**.
- `src/workflows/work-study/tracker.ts` — **unchanged**.
- `src/cli.ts` — **unchanged** (already imports `runWorkStudy` via `work-study/index.js`).

### Files affected by Task 5 (documentation)

- `src/workflows/work-study/CLAUDE.md` — document the kernel-based shape.

---

## Task 1: Rename `src/ucpath/` → `src/systems/ucpath/`

**Rationale:** This is a prerequisite for the work-study migration (so the new `workflow.ts` imports from `../../systems/ucpath/types.js`) and the foundation for every other Phase 2 migration that touches a per-system directory. Doing it as a standalone commit makes review easy: one commit is "just a rename", the next is "new workflow shape".

**Files:**
- Move: `src/ucpath/` → `src/systems/ucpath/` (via `git mv`)
- Move: `tests/unit/ucpath/` → `tests/unit/systems/ucpath/` (via `git mv`)
- Modify imports in: `src/workflows/work-study/workflow.ts`, `src/workflows/work-study/enter.ts`, `src/workflows/onboarding/workflow.ts`, `src/workflows/onboarding/enter.ts`, `src/workflows/separations/workflow.ts`, `src/workflows/emergency-contact/workflow.ts`, `src/workflows/emergency-contact/enter.ts`, `src/workflows/eid-lookup/search.ts`
- Modify imports in: `tests/unit/systems/ucpath/action-plan.test.ts`, `tests/unit/systems/ucpath/types.test.ts`
- Modify path references in: `CLAUDE.md` (root), `tests/CLAUDE.md`, `src/workflows/emergency-contact/CLAUDE.md`

- [ ] **Step 1: Create the `src/systems/` directory and move `src/ucpath/` into it**

Run (single atomic `git mv`):
```bash
mkdir -p src/systems
git mv src/ucpath src/systems/ucpath
```

Expected: `src/systems/ucpath/` now contains the 7 files from the old dir, and `git status` shows them as renames (not delete+add). Run `git status -s` to confirm — output should look like:
```
R  src/ucpath/action-plan.ts -> src/systems/ucpath/action-plan.ts
R  src/ucpath/index.ts -> src/systems/ucpath/index.ts
R  src/ucpath/job-summary.ts -> src/systems/ucpath/job-summary.ts
R  src/ucpath/navigate.ts -> src/systems/ucpath/navigate.ts
R  src/ucpath/personal-data.ts -> src/systems/ucpath/personal-data.ts
R  src/ucpath/transaction.ts -> src/systems/ucpath/transaction.ts
R  src/ucpath/types.ts -> src/systems/ucpath/types.ts
R  src/ucpath/CLAUDE.md -> src/systems/ucpath/CLAUDE.md
```

- [ ] **Step 2: Move the test directory**

Run:
```bash
mkdir -p tests/unit/systems
git mv tests/unit/ucpath tests/unit/systems/ucpath
```

Expected: `tests/unit/systems/ucpath/` contains `action-plan.test.ts` and `types.test.ts`, both shown as renames in `git status -s`.

- [ ] **Step 3: Update imports in prod files — set A (workflows that use `../../ucpath/`)**

In each of these 8 files, replace every occurrence of `"../../ucpath/` with `"../../systems/ucpath/` (keep the `.js` suffixes, keep the closing quote):

- `src/workflows/work-study/workflow.ts`
- `src/workflows/work-study/enter.ts`
- `src/workflows/onboarding/workflow.ts`
- `src/workflows/onboarding/enter.ts`
- `src/workflows/separations/workflow.ts`
- `src/workflows/emergency-contact/workflow.ts`
- `src/workflows/emergency-contact/enter.ts`
- `src/workflows/eid-lookup/search.ts`

Use the Edit tool with `replace_all: true`. Example for `src/workflows/work-study/workflow.ts`:
```
old_string: "../../ucpath/
new_string: "../../systems/ucpath/
replace_all: true
```

- [ ] **Step 4: Update imports in test files**

The test files were at `tests/unit/ucpath/` and are now at `tests/unit/systems/ucpath/`. Their imports go up four levels now (was three) and then into `src/systems/ucpath/`.

In `tests/unit/systems/ucpath/action-plan.test.ts` and `tests/unit/systems/ucpath/types.test.ts`, replace `"../../../src/ucpath/` with `"../../../../src/systems/ucpath/` (use `replace_all: true`). Note the extra `../` — because the test file moved one directory deeper, its relative path up must gain one more hop.

- [ ] **Step 5: Update the root `CLAUDE.md` architecture tree**

In `CLAUDE.md` (root), find the `src/` tree block that lists top-level per-system dirs. Locate the line describing `ucpath/`:

```
  ucpath/           # UCPath PeopleSoft navigation, person search, Smart HR transactions
```

Replace it with:
```
  systems/
    ucpath/           # UCPath PeopleSoft navigation, person search, Smart HR transactions (moved from src/ucpath/ in Phase 2)
```

Also scan the file for any other literal `src/ucpath` string and update to `src/systems/ucpath`. Leave phrases like "UCPath iframe" alone — those are about the product, not the path.

- [ ] **Step 6: Update `tests/CLAUDE.md` path reference**

Open `tests/CLAUDE.md`. Find any literal `src/ucpath` and replace with `src/systems/ucpath`. Also, if the file documents the test directory layout, update any reference to `tests/unit/ucpath/` → `tests/unit/systems/ucpath/`.

- [ ] **Step 7: Update `src/workflows/emergency-contact/CLAUDE.md` path reference**

Open `src/workflows/emergency-contact/CLAUDE.md`. Find any literal `src/ucpath` and replace with `src/systems/ucpath`. (Leave `ucpath` mentions that refer to the system name, not a path, alone.)

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck && npm run typecheck:all`

Expected: both commands exit 0 with no output. If typecheck fails with "Cannot find module '../../ucpath/...'", a file was missed in Step 3 — go back and grep for `"../../ucpath/` across the repo, then re-run.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`

Expected: all 160 tests pass (same count as after `kernel-build-complete`). If a test fails with a module-resolution error, its import path wasn't updated — fix and re-run.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(systems): rename src/ucpath/ → src/systems/ucpath/

First per-system directory move in Phase 2 of the kernel refactor.
All 8 prod consumers updated to import from "../../systems/ucpath/",
the test directory moved in lockstep, and root + tests +
emergency-contact CLAUDE.md references updated.

No behavior change. Typecheck clean on both tsconfigs; full suite passes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify with `git log -1 --stat` — should show 10+ renames and ~3 documentation edits.

---

## Task 2: Rewrite `src/workflows/work-study/workflow.ts` on the kernel

**Rationale:** Replaces the raw `launchBrowser` + `loginToUCPath` + `withTrackedWorkflow` + `withLogContext` stack with a single `defineWorkflow` call. The ActionPlan (`buildWorkStudyPlan`) and its per-step helpers stay untouched — the kernel only owns orchestration.

**Files:**
- Modify (rewrite): `src/workflows/work-study/workflow.ts`
- Modify: `src/workflows/work-study/index.ts` (add export for `workStudyWorkflow`)

- [ ] **Step 1: Replace `src/workflows/work-study/workflow.ts` with the kernel-based implementation**

Fully replace the file contents with:

```typescript
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath } from "../../auth/login.js";
import { buildWorkStudyPlan, type WorkStudyContext } from "./enter.js";
import { WorkStudyInputSchema, type WorkStudyInput } from "./schema.js";
import { updateWorkStudyTracker } from "./tracker.js";

export interface WorkStudyOptions {
  dryRun?: boolean;
}

const workStudySteps = ["ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the work-study PayPath workflow.
 *
 * Exports a RegisteredWorkflow. Run it via `runWorkflow(workStudyWorkflow, input)`
 * or invoke the CLI adapter `runWorkStudy` below (which handles dry-run + failure
 * tracker writes).
 */
export const workStudyWorkflow = defineWorkflow({
  name: "work-study",
  systems: [
    { id: "ucpath", login: loginToUCPath },
  ],
  steps: workStudySteps,
  schema: WorkStudyInputSchema,
  tiling: "single",
  authChain: "sequential",
  detailFields: ["emplId", "effectiveDate"],
  handler: async (ctx, input) => {
    const wsCtx: WorkStudyContext = { employeeName: "" };

    // Surface input data to the dashboard before the first step fires.
    ctx.updateData({ emplId: input.emplId, effectiveDate: input.effectiveDate });

    // Step 1: auth — Session already kicked off loginToUCPath; the first
    // ctx.page() call blocks until that promise resolves, so wrapping it in
    // a step gives the dashboard a clean "ucpath-auth" phase.
    await ctx.step("ucpath-auth", async () => {
      await ctx.page("ucpath");
    });

    // Step 2: execute the PayPath transaction plan.
    await ctx.step("transaction", async () => {
      const page = await ctx.page("ucpath");
      const plan = buildWorkStudyPlan(input, page, wsCtx);
      await plan.execute();
      ctx.updateData({ name: wsCtx.employeeName });
    });

    // Success tracker row. Non-fatal if Excel write fails.
    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: wsCtx.employeeName,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Done",
        error: "",
        timestamp: new Date().toISOString(),
      });
      log.success("Tracker updated: work-study-tracker.xlsx");
    } catch (trackerErr) {
      log.error(`Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`);
    }
  },
});

/**
 * CLI adapter. Handles --dry-run (preview only, no browser) and failure-path
 * Excel tracker writes. Real runs delegate to the kernel.
 */
export async function runWorkStudy(
  input: WorkStudyInput,
  options: WorkStudyOptions = {},
): Promise<void> {
  if (options.dryRun) {
    const wsCtx: WorkStudyContext = { employeeName: "" };
    const plan = buildWorkStudyPlan(input, null as never, wsCtx);
    log.step("=== DRY RUN MODE ===");
    plan.preview();
    log.success("Dry run complete -- no changes made to UCPath");
    return;
  }

  try {
    await runWorkflow(workStudyWorkflow, input);
    log.success("Work study transaction completed successfully");
  } catch (err) {
    // Failure tracker row — name is unknown here (kernel boundary), so we
    // write "" for employeeName. Dashboard JSONL has the richer record.
    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: "",
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Failed",
        error: errorMessage(err),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — original tracker error already logged.
    }

    log.error(`Work study failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
```

Key facts about this implementation:
- `detailFields: ["emplId", "effectiveDate"]` — the kernel type restricts to `keyof WorkStudyInput`, so `"name"` (populated via `updateData`) can't be listed here. The frontend `WF_CONFIG` continues to surface `name` via its own `getName` callback — known debt tracked for Session 4.
- `authChain: "sequential"` is redundant for 1 system (the Session defaults to sequential when `systems.length === 1`), but making it explicit clarifies intent.
- `tiling: "single"` is likewise defaulted by `Session.launch` but kept explicit.
- No `preAssignedRunId` — work-study doesn't support batch mode.
- Error classification is handled inside `ctx.step`; the CLI catch block only sees a classified-or-raw error string.

- [ ] **Step 2: Update `src/workflows/work-study/index.ts`**

Fully replace the file with:

```typescript
export { WorkStudyInputSchema } from "./schema.js";
export type { WorkStudyInput } from "./schema.js";
export { buildWorkStudyPlan } from "./enter.js";
export type { WorkStudyContext } from "./enter.js";
export { runWorkStudy, workStudyWorkflow } from "./workflow.js";
export type { WorkStudyOptions } from "./workflow.js";
export { updateWorkStudyTracker } from "./tracker.js";
export type { WorkStudyTrackerRow } from "./tracker.js";
```

The only addition is `workStudyWorkflow` in the `runWorkStudy` export line. Keeping the rest identical preserves the existing `src/cli.ts` import surface.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck && npm run typecheck:all`

Expected: exit 0 with no output. If a type error fires around `handler: async (ctx, input)`, verify the `steps` tuple was declared with `as const` — without it the `Ctx<TSteps, ...>` inference collapses to `string[]` and `ctx.step` rejects its name argument.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: 160/160 pass. No new tests added (work-study doesn't have unit tests). If a test fails with `defineWorkflow` registry double-registration warnings, they're benign; the registry is a `Map.set` by name.

- [ ] **Step 5: Dry-run smoke test (no browser)**

Run:
```bash
npm run work-study:dry 10862930 07/01/2026
```

Expected output ends with `Dry run complete -- no changes made to UCPath` (log.success). Before that it prints the plan preview — a numbered list of ~8 actions starting with "Navigate to PayPath Actions" and ending with "Fill Initiator's Comments: ...". No browser should open.

Compare to the pre-migration output (save both to a scratchpad): the action list should be identical — dry-run behavior hasn't changed, only the non-dry-run path.

If the Empl ID / date format validation fails, it's because `WorkStudyInputSchema` hasn't changed — the error messages will match the old ones exactly ("Employee ID must be numeric (5+ digits)" / "Effective date must be in MM/DD/YYYY format").

- [ ] **Step 6: Commit**

```bash
git add src/workflows/work-study/workflow.ts src/workflows/work-study/index.ts
git commit -m "$(cat <<'EOF'
refactor(work-study): migrate to src/core/ kernel via defineWorkflow

Replaces the raw launchBrowser + withTrackedWorkflow + withLogContext
stack with a single defineWorkflow call. ActionPlan (buildWorkStudyPlan)
and tracker.ts are unchanged; the kernel owns orchestration only.

Shape:
- 1 system (UCPath, sequential auth, single tiling)
- 2 steps: ucpath-auth → transaction
- Dry-run stays in the CLI adapter (runWorkStudy), no browser

Known tradeoff: failure tracker rows lose employeeName (kernel boundary).
Dashboard JSONL retains the full record. Acceptable.

Pending: real-run verification, CLAUDE.md update, kernel-migration-work-study tag.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Real-run verification (user-driven)

**This task is user-driven — a subagent cannot approve Duo MFA. Pause here after Task 2 commits and confirm with the user before proceeding.**

**What the user does:**

1. Open a second terminal and start the dashboard: `npm run dashboard`. Open http://localhost:5173.
2. In the primary terminal, run against a real (or test) Empl ID + future effective date:
   ```bash
   npm run work-study <emplId> <MM/DD/YYYY>
   ```
3. Approve Duo MFA on phone when prompted.
4. Observe the dashboard:
   - Queue shows an entry for the Empl ID.
   - Step pipeline lights up "UCPath Auth" first, then "Transaction" after Duo.
   - Detail grid populates with Empl ID + Effective Date immediately, then Employee name after the search step inside the plan.
   - Final status is `done` once the plan finishes. (The Save & Submit action is commented out in `enter.ts:237-240` — the form will be filled but not submitted. Expected.)
5. Observe the terminal:
   - Log lines prefixed with "[NAV]" during SSO redirect, then UCPath auth success.
   - Plan execution logs for each action.
   - Final "Work study transaction completed successfully" + tracker xlsx update line.

**Pass criteria:**
- Dashboard entry transitions pending → running (ucpath-auth) → running (transaction) → done.
- Detail grid shows `Employee: <name>`, `Empl ID: <id>` (after transaction step).
- `src/workflows/work-study/work-study-tracker.xlsx` has a new row under today's sheet with `Status: Done`.
- No uncaught exceptions in terminal; exit code 0.

**Fail criteria (any triggers rollback):**
- Dashboard never shows the entry, or gets stuck on a step without an error emission.
- Exit code non-zero on a run the old implementation handled.
- Detail grid remains empty after the transaction step.

**Rollback on failure:** `git revert HEAD` (undoes Task 2's commit). Task 1 (directory rename) stays — other migrations need it. Investigate in isolation before retrying.

- [ ] **Step 1: Confirm with user that the real run passed.** Do not proceed to Task 4 until the user has explicitly said the run succeeded.

---

## Task 4: Update workflow CLAUDE.md

**Files:**
- Modify: `src/workflows/work-study/CLAUDE.md`

- [ ] **Step 1: Rewrite `src/workflows/work-study/CLAUDE.md`**

Fully replace the file with:

```markdown
# Work-Study Workflow

Updates employee position pool and compensation data for work-study awards in UCPath PayPath Actions.

**Kernel-based.** The workflow is declared via `defineWorkflow` in `workflow.ts` and executed by `src/core/runWorkflow`. The kernel owns browser launch, auth, tracker emission, and error handling — this directory contains only schema + plan + CLI-adapter.

## Files

- `schema.ts` — Zod `WorkStudyInput` schema (emplId: 5+ digits, effectiveDate: MM/DD/YYYY)
- `enter.ts` — `buildWorkStudyPlan(input, page, ctx)` builds the PayPath ActionPlan: navigate → collapse sidebar → search Empl ID → fill position data (reason "JRL", pool "F") → Job Data / Additional Pay tabs → save/submit
- `tracker.ts` — Appends rows to `work-study-tracker.xlsx` (Excel-only; JSONL is emitted by the kernel)
- `workflow.ts` — `workStudyWorkflow` (kernel definition) + `runWorkStudy` (CLI adapter for dry-run + failure-tracker writes)
- `index.ts` — Barrel exports

## Data Flow

```
CLI: emplId + effectiveDate
  → runWorkStudy (CLI adapter)
    → dry-run branch: plan.preview(), done
    → real-run branch: runWorkflow(workStudyWorkflow, input)
      → Kernel Session.launch: 1 browser, sequential UCPath auth
      → Handler step 1 "ucpath-auth": awaits ctx.page('ucpath') → Duo approval
      → Handler step 2 "transaction": executes the PayPath plan
        → Navigate to PayPath Actions
        → Search employee by Empl ID (captures employeeName)
        → Fill Position Data (pool F, reason JRL)
        → Job Data comments → Additional Pay comments → Save & Submit (commented out pending test)
      → Success tracker row via updateWorkStudyTracker
```

## Kernel Config

| Field | Value | Why |
|-------|-------|-----|
| `systems` | `[{ id: "ucpath", login: loginToUCPath }]` | Single system, sequential auth |
| `steps` | `["ucpath-auth", "transaction"] as const` | Dashboard pipeline |
| `tiling` | `"single"` | Only 1 browser |
| `authChain` | `"sequential"` | Explicit, matches default |
| `detailFields` | `["emplId", "effectiveDate"]` | Schema-keyed. `name` is pushed via `updateData` and picked up by `WF_CONFIG.getName` — a known dashboard-metadata limitation Session 4 resolves |

## Gotchas

- **Save & Submit is commented out** in `enter.ts` (line ~237-240) — pending test completion.
- Position Pool hardcoded to `"F"`, Position Change Reason to `"JRL"`.
- Comments template: `"Updated pool id to F per work study award {effectiveDate}"`.
- Employee name extracted from PeopleSoft header (multiple selector variants) — mutated into `wsCtx.employeeName` and surfaced via `ctx.updateData({ name })`.
- Sidebar must be auto-collapsed to prevent click interception on iframe buttons.
- 3-5 second waits required after PeopleSoft iframe reloads.
- PeopleSoft alerts (payroll-in-progress warnings) are auto-dismissed.
- Uses `getContentFrame()` for all iframe interactions — same pattern as onboarding.
- **Failure tracker rows lose employeeName.** The kernel boundary means the CLI-adapter catch block doesn't have access to `wsCtx`. The dashboard JSONL retains the richer record; the Excel fallback is name-less on failures. Acceptable tradeoff.

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-15: Migrated to kernel.** The workflow file is now a `defineWorkflow` call plus a CLI adapter. Don't reintroduce `launchBrowser` / `withTrackedWorkflow` / `withLogContext` calls here — those live in `src/core/`. New fields for the dashboard detail grid: add them to `detailFields` (if schema-keyed) or populate via `ctx.updateData` and let `WF_CONFIG.getName` / etc. read them.
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/work-study/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(work-study): document kernel-based workflow shape

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tag the migration

**Prerequisite:** Task 3 (real-run verification) passed and Task 4's commit is on master.

- [ ] **Step 1: Tag the commit**

```bash
git tag kernel-migration-work-study
git log -1 --oneline
```

Expected: tag points at the CLAUDE.md-update commit (Task 4). Verify with `git tag --verify kernel-migration-work-study` → should print the commit it points to.

- [ ] **Step 2: Confirm Phase 2 progress**

After this tag, git should show three tags on this refactor arc:
- `kernel-build-complete` (end of Phase 1)
- `kernel-migration-work-study` (this plan)

Run `git tag | grep kernel` to confirm.

**Do not proceed to the emergency-contact migration in the same session.** Pause here. The next migration (emergency-contact) requires resolving debt item #1 (`runWorkflowBatch` sequential mode doesn't wrap each item in `withTrackedWorkflow`) and should be scoped to its own plan.

---

## Verification Summary

After all 5 tasks:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run typecheck:all` exits 0
- [ ] `npm test` shows 160/160 passing
- [ ] `npm run work-study:dry <emplId> <date>` produces the same plan preview as before the migration
- [ ] A real run with the user watching completes end-to-end, dashboard shows both steps, detail grid populates, tracker xlsx appends a `Done` row
- [ ] `src/ucpath/` no longer exists; `src/systems/ucpath/` has all the files (git history preserved via rename)
- [ ] `src/workflows/work-study/workflow.ts` has no direct calls to `launchBrowser`, `withTrackedWorkflow`, or `withLogContext`
- [ ] `kernel-migration-work-study` tag exists on master
- [ ] `src/workflows/work-study/CLAUDE.md` describes the kernel-based shape

---

## Risk / Rollback

| Risk | Mitigation |
|------|-----------|
| Import path miss in Task 1 breaks a workflow we don't test on this plan (e.g. kronos-reports, separations) | `npm run typecheck:all` + `npm test` before committing. Both cover the full src/ + tests/ tree. |
| Kernel `ctx.step("ucpath-auth", () => ctx.page("ucpath"))` doesn't emit a tracker "running" event because the step body is trivially fast | Empirically verify during Task 3's real run by watching the dashboard. If it skips, wrap the auth step body with a `log.step` or add a sentinel await. Kernel code already emits on entry, so this should be fine. |
| Dry-run output shape changed subtly (ActionPlan `preview()` format evolved independently) | Step 5 of Task 2 explicitly compares pre/post preview output. If they diverge, the divergence is a bug in the migration — fix before committing. |
| Real run succeeds but dashboard shows wrong step names (e.g. kernel emits `ucpath-auth:failed:X` as literal step name) | This is documented in the checkpoint under "emitFailed: `${step}:failed:${error}`". Dashboard already handles this because frontend parsing is agnostic. Verify during Task 3. |
| Failure tracker row cannot be written (Excel file locked, disk full) | Failure is caught and swallowed — runWorkStudy exits 1 via `process.exit(1)` regardless. Matches old behavior. |

Rollback at any stage:
- After Task 1 only: `git reset --hard kernel-build-complete` (wipes the rename too — ok).
- After Task 2: `git revert <task-2-sha>` — restores old workflow.ts, keeps rename.
- After Task 4: `git revert <task-4-sha>` for docs only; tag with `git tag -d kernel-migration-work-study`.
