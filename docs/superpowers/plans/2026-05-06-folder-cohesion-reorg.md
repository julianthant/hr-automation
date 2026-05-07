# Folder Cohesion Reorg (Pass 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to dispatch each task as one Sonnet subagent. Phase 1 tasks are independent and dispatch in **parallel via worktrees** (one Agent call per task in a single message). Phase 2 starts only after all Phase 1 worktrees have been merged into `master`. This is **refactor work, not TDD** — rhythm is `typecheck green → move → typecheck still green → commit`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Higher-level cohesion reorg on top of the file-splits work that landed in `bc72db0..master` (commits 4cd0118..bc72db0). Group flat dashboard components by feature; split `src/tracker/` into `tracker/` (state) + `server/` (HTTP API); consolidate `core/` orphans; normalize workflow folder shapes; move `src/match/` into `src/domain/`; mirror new structures in `tests/`. **Zero behavior change.**

**Architecture:** Every move uses `git mv` to preserve history. Imports are updated by running `npm run typecheck` after each batch of moves and fixing the broken imports the compiler reports. Folder boundaries are based on cohesion (files that change together live together), not on file count alone. The two top-level conceptual pairings after this pass are: `src/dashboard/` (UI) ↔ `src/server/` (API), and `src/core/kernel/` (workflow engine) ↔ `src/core/daemon/` (long-lived processes that drive it).

**Tech Stack:** TypeScript (NodeNext), tsx, React (TSX), Hono, Vite, Vitest. Imports use `.js` extensions throughout (ESM convention).

**Source brainstorm:** alignment captured in conversation on 2026-05-06; no separate spec doc per global CLAUDE.md.

---

## Global pre-conditions (verify before EVERY phase dispatch)

Before dispatching any phase, the orchestrator confirms:

- [ ] On `master`: `git rev-parse --abbrev-ref HEAD` → `master`
- [ ] Working tree clean: `git status --short` → empty
- [ ] Typecheck currently green: `npm run typecheck` → ends with no errors
- [ ] Unit tests currently green: `npm run test` → all passing
- [ ] Architecture guards green: `npm run test:architecture` → all passing

If any fail, **do not dispatch** — surface the failure to the user instead.

## Subagent dispatch model

This plan uses **two phases**:

**Phase 1 — Parallel via worktrees.** Five independent tasks, each in its own worktree on a named branch. After all five subagents finish, the orchestrator merges each branch into `master` with `git merge --no-ff`, then removes the worktree. Each Phase 1 task dispatch:

- **`subagent_type`**: `general-purpose`
- **`model`**: `sonnet`
- **`isolation`**: `"worktree"`
- **branch name**: as specified per task (`refactor/dashboard-grouping`, etc.)

**Phase 2 — Parallel on master.** Three tasks dispatched in parallel directly on `master` (no worktrees needed — they touch fully disjoint trees and run after Phase 1 has landed). Each Phase 2 task dispatch:

- **`subagent_type`**: `general-purpose`
- **`model`**: `sonnet`
- **No `isolation`** — work happens on `master`, orchestrator does nothing between concurrent commits because the trees don't overlap.

If two parallel commits race, the second push fails harmlessly — the user can re-run. We're never pushing in this plan, so this is academic.

## Universal task wrapper (every task ends with this verbatim)

Every per-task subagent prompt MUST end with this block, repeated verbatim, with the **commit message** filled in:

```
Verification (must pass before commit):
1. Run `npm run typecheck` — must report 0 errors.
2. Run `npm run test` — every test that was green at task start must still be green. Tests that were already failing before the task started are out of scope (do not "fix" them).
3. Run `npm run test:architecture` — must pass.
4. Show `git status --short` and `git diff --stat` so the result is auditable.

Commit policy:
- Use the EXACT commit message specified for the task (one or more `git commit` calls with the messages given).
- Do NOT amend prior commits.
- Do NOT push.
- Use `git mv` for renames so history is preserved.

Out of scope (do NOT do):
- No behavior changes anywhere.
- No new features, helpers, "while we're here" cleanup, comment additions/removals beyond what the move strictly requires.
- No formatting changes (no Prettier/ESLint mass runs).
- No dependency updates.
- Do NOT touch any file outside the task's explicit Files: list AND its transitive importers (which you discover via grep / typecheck errors).
- Do NOT modify other unrelated files even if they look broken — surface them to the user instead.
```

## Import-update playbook (referenced by every task)

Every task moves files. Imports across the codebase break. Mechanical recipe a subagent follows:

1. Make all the moves in this task using `git mv` (and `mkdir -p` for new folders).
2. Update the **moved files' own internal relative imports** if their depth into `src/` changed (e.g., a file moving from `src/dashboard/components/EntryItem.tsx` to `src/dashboard/components/queue/EntryItem.tsx` now needs `../../hooks/...` instead of `../hooks/...`).
3. Run `npm run typecheck`. The compiler lists every broken import.
4. For each error of the form `Cannot find module '<old-relative-path>'`, fix the import in the file the error names. Use the `Edit` tool. Do not bulk-sed across the codebase — false positives. Fix one file at a time, re-run typecheck periodically.
5. When typecheck is green, run `npm run test` and `npm run test:architecture`. Both must pass.
6. **Update CLAUDE.md references** that point to the old paths. Use `grep -rln "<old-path>" src/ tests/ docs/` and update each prose reference. Reference updates are fact-only (the path changed); do not rephrase surrounding text.
7. Commit per task spec.

If a moved file is referenced by a `package.json` script, the script must be updated in the same commit. If by `vite.dashboard.config.ts` or any other config, same rule.

---

## File structure (full inventory)

### Phase 1 changes

#### Task 1 — Dashboard component grouping (`src/dashboard/components/`)

**New folders (created):**
```
src/dashboard/components/run-controls/
  RunModal.tsx
  RunSelector.tsx
  QuickRunPanel.tsx
  TopBarRunButton.tsx
  WorkflowRail.tsx
  WorkflowBox.tsx

src/dashboard/components/queue/
  QueuePanel.tsx
  EntryItem.tsx
  QueueItemControls.tsx
  RetryButton.tsx
  RetryAllButton.tsx
  CancelRunningButton.tsx
  StatPills.tsx
  EmptyState.tsx
  entry-display.ts
  queue-status.ts
  status-styles.ts

src/dashboard/components/logs/
  LogPanel.tsx
  LogStream.tsx
  LogLine.tsx
  TerminalDrawer.tsx
  log-display.ts
  log-fallback.ts

src/dashboard/components/screenshots/
  ScreenshotCard.tsx
  ScreenshotLightbox.tsx
  ScreenshotsPanel.tsx
  SelectorWarningsPanel.tsx

src/dashboard/components/capture-photo/
  CapturePhotoLightbox.tsx
  CapturePhotoTile.tsx
  capture-types.ts

src/dashboard/components/inbox/
  ApprovalInbox.tsx
  SearchBar.tsx
  SearchResults.tsx

src/dashboard/components/navbar/
  TopBar.tsx
  TopBarCaptureButton.tsx
  FailureBell.tsx
  LiveIndicator.tsx
  BrowserChip.tsx
```

**Stays flat at `src/dashboard/components/`:**
```
EditDataTab.tsx
StepPipeline.tsx
PdfPagePreview.tsx
SharePointDownloadButton.tsx
types.ts                  ← split in Task 6 (Phase 2), not this task
```

**Untouched subfolders:** `CaptureModal/`, `hooks/`, `oath-upload/`, `ocr/`, `ui/`.

#### Task 2 — Backend split (`src/tracker/` → `src/tracker/` + `src/server/`)

**New folder created at top of src/:**
```
src/server/
  index.ts                   ← was src/tracker/dashboard.ts (main entry; bootstraps the server)
  CLAUDE.md                  ← new file; minimal pointer to API layer (see Task 2 step 9)
  server.ts                  ← was src/tracker/dashboard/server.ts
  app.ts                     ← was src/tracker/dashboard/hono/app.ts
  context.ts                 ← was src/tracker/dashboard/hono/context.ts
  manifest.ts                ← was src/tracker/dashboard/hono/manifest.ts
  multipart.ts               ← was src/tracker/dashboard/hono/multipart.ts
  responses.ts               ← was src/tracker/dashboard/hono/responses.ts
  sse.ts                     ← was src/tracker/dashboard/hono/sse.ts
  routes/                    ← was src/tracker/dashboard/hono/routes/ (all 16 files, unchanged within)
  ocr/                       ← was src/tracker/dashboard/ocr/ (all 10 files, unchanged within)
  ops/                       ← was src/tracker/dashboard/ops/ (all 6 files, unchanged within)
  tasks/                     ← was src/tracker/tasks/ (all 5 files, unchanged within)

  capture-state.ts           ← was src/tracker/dashboard/capture-state.ts
  failures.ts                ← was src/tracker/dashboard/failures.ts
  prep-rows.ts               ← was src/tracker/dashboard/prep-rows.ts
  preview-inbox.ts           ← was src/tracker/dashboard/preview-inbox.ts
  run-timelines.ts           ← was src/tracker/dashboard/run-timelines.ts
  screenshots.ts             ← was src/tracker/dashboard/screenshots.ts
  search.ts                  ← was src/tracker/dashboard/search.ts
  selector-warnings.ts       ← was src/tracker/dashboard/selector-warnings.ts
  session-state.ts           ← was src/tracker/dashboard/session-state.ts
  sweeps.ts                  ← was src/tracker/dashboard/sweeps.ts
  workflows.ts               ← was src/tracker/dashboard/workflows.ts

  multipart-helper.ts        ← was src/tracker/multipart-helper.ts (HTTP-only utility)
  oath-upload-http.ts        ← was src/tracker/oath-upload-http.ts (HTTP-specific routes)
```

**Stays in `src/tracker/`** (the persistent observability layer):
```
src/tracker/
  CLAUDE.md           ← updated to reflect the split
  index.ts            ← may need export-list edits (drop re-exports of moved files)
  jsonl.ts
  state/              (8 files, unchanged)
  auth-observer.ts
  duo-queue.ts
  export-excel.ts
  failure-detector.ts
  files.ts
  locked.ts
  notify.ts           ← desktop osascript notifier; stays (state-side concern)
  pdf-cache.ts
  session-events.ts
  spreadsheet.ts
  watch-child-runs.ts
```

**Removed from src/tracker/:** the entire `dashboard/` subtree, the `tasks/` subtree, `dashboard.ts`, `multipart-helper.ts`, `oath-upload-http.ts`.

**Files updated outside the move zone** (Task 2 also updates these):
- `src/cli.ts` — `dashboard` command currently imports from `./tracker/dashboard.js`; rewrite to `./server/index.js`.
- `src/core/workflow-loaders.ts` — JSDoc references `src/tracker/dashboard.ts`; update to `src/server/index.ts`.
- `src/capture/CLAUDE.md` — prose reference to `src/tracker/dashboard.ts`; update.
- `src/core/CLAUDE.md` — multiple prose references; update.
- `src/workflows/CLAUDE.md` — prose reference to `src/tracker/dashboard-ops.ts` (already moved into `dashboard/ops/`; rewrite to `src/server/ops/`).
- `src/workflows/emergency-contact/CLAUDE.md` — prose reference; update.
- `src/workflows/sharepoint-download/CLAUDE.md` and `index.ts` — prose comment; update.
- `src/tracker/CLAUDE.md` — many references to `src/tracker/dashboard.ts` line numbers; update path AND drop now-stale line numbers (they'll be wrong after the rename).
- `src/dashboard/components/types.ts` — JSDoc references `src/tracker/dashboard.ts`; update.
- `tests/integration/oath-upload-smoke.test.ts` — likely imports the server entry; update.
- Any `*.test.ts` under `tests/unit/tracker/` that imports from `src/tracker/dashboard/...` — update path. (The TEST FILES themselves do NOT move in this task — that's Task 8.)

#### Task 3 — `core/` root cleanup

**Moves:**
```
src/core/task-store/          → src/core/tasks/store/
src/core/task-control.ts      → src/core/tasks/control.ts
src/core/task-display.ts      → src/core/tasks/display.ts

src/core/find-input.ts        → src/core/kernel/find-input.ts
src/core/workflow-loaders.ts  → src/core/kernel/workflow-loaders.ts
```

**Unchanged:**
```
src/core/CLAUDE.md
src/core/index.ts             ← may need export-path edits but no content changes
src/core/control-db.ts        ← stays flat (only 2-file pair, see Q5)
src/core/control-schema.ts    ← stays flat
src/core/kernel/              ← contents unchanged except for the 2 added files
src/core/daemon/              ← unchanged
```

#### Task 4 — Workflow folder consistency

**Add `steps/` folder + move step-shaped files** in 3 workflows:

```
src/workflows/oath-upload/steps/
  handler.ts                  ← was src/workflows/oath-upload/handler.ts
  fill-form.ts                ← was src/workflows/oath-upload/fill-form.ts
  duplicate-check.ts          ← was src/workflows/oath-upload/duplicate-check.ts
  wait-ocr-approval.ts        ← was src/workflows/oath-upload/wait-ocr-approval.ts

src/workflows/onboarding/steps/
  download.ts                 ← was src/workflows/onboarding/download.ts
  enter.ts                    ← was src/workflows/onboarding/enter.ts
  extract.ts                  ← was src/workflows/onboarding/extract.ts
  positional.ts               ← was src/workflows/onboarding/positional.ts

src/workflows/ocr/steps/
  carry-forward.ts            ← was src/workflows/ocr/carry-forward.ts
  force-research.ts           ← was src/workflows/ocr/force-research.ts
  retry-page.ts               ← was src/workflows/ocr/retry-page.ts
  eid-lookup-results.ts       ← was src/workflows/ocr/eid-lookup-results.ts
```

**Verify-then-delete:**
```
src/workflows/separations/cli.ts   ← delete IF no caller exists
```

**Doc consolidation:**
```
src/workflows/eid-lookup/CLAUDE.md          ← append the contents of EID-LOOKUP-NOTES.md
src/workflows/eid-lookup/EID-LOOKUP-NOTES.md ← delete after fold
```

**Stays untouched:** `active-check/`, `eid-lookup/` (other than notes fold), `emergency-contact/` (only 2 step-shaped files; below the bar), `oath-signature/`, `old-kronos-reports/`, `separations/` (already has `steps/`), `sharepoint-download/`, `work-study/`.

#### Task 5 — Move `src/match/` → `src/domain/match/`

**Moves (whole folder):**
```
src/match/index.ts          → src/domain/match/index.ts
src/match/levenshtein.ts    → src/domain/match/levenshtein.ts
src/match/match.ts          → src/domain/match/match.ts
src/match/roster-loader.ts  → src/domain/match/roster-loader.ts
```

**`src/match/` directory is removed entirely.**

**Importers to update** (verified by grep on 2026-05-06 — re-verify before committing in case the set drifted):
```
src/ocr/lookup-suggestions.ts                     ← "../match/index.js"        → "../domain/match/index.js"
src/ocr/forms/emergency-contact.ts                ← "../../match/index.js"     → "../../domain/match/index.js"
src/ocr/forms/oath.ts                             ← "../../match/index.js"     → "../../domain/match/index.js"
src/workflows/ocr/retry-page.ts                   ← (2 imports)                → ../../domain/match/...
src/workflows/ocr/orchestrator.ts                 ← (2 imports)                → ../../domain/match/...
src/workflows/ocr/carry-forward.ts                ← "../../match/index.js"     → "../../domain/match/index.js"
src/workflows/emergency-contact/roster-verify.ts  ← "../../match/index.js"     → "../../domain/match/index.js"
src/workflows/emergency-contact/enter.ts          ← "../../match/index.js"     → "../../domain/match/index.js"
src/tracker/dashboard/hono/routes/base.ts         ← "../../../../match/roster-loader.js"
                                                     → "../../../../domain/match/roster-loader.js"
                                                     (NOTE: this file ALSO moves in Task 2;
                                                      Task 5 only updates the relative path
                                                      from match/ → domain/match/. If Task 2
                                                      lands first the source path differs.
                                                      Either order works — fix imports based
                                                      on whatever the merged tree actually
                                                      shows post-Phase-1.)
```

**Test files to update** (also need their import paths fixed; these test files do NOT move):
```
tests/unit/match/levenshtein.test.ts       ← "../../../src/match/levenshtein.js"   → "../../../src/domain/match/levenshtein.js"
tests/unit/match/match.test.ts             ← "../../../src/match/match.js"
tests/unit/match/roster-loader.test.ts     ← "../../../src/match/roster-loader.js"
tests/unit/match/disambiguate-wiring.test.ts ← "../../../src/match/match.js"
```

**Note on test folder:** Per Q8 we are NOT mirroring strictly across all test folders — `tests/unit/match/` stays where it is; only its imports are fixed. (The user's strict-mirroring scope was limited to `tests/unit/core/` and `tests/unit/tracker/`.)

### Phase 2 changes

#### Task 6 — Split `src/dashboard/components/types.ts` into per-feature `types.ts`

`types.ts` is 405 lines. Each new feature folder from Task 1 gets its own `types.ts` containing the types used by files in that folder. Types that span multiple folders stay in the root `types.ts` (or move to the most-natural owning folder if they have a clear primary owner).

**Process** (judgment-heavy — the subagent reads and decides):
1. Read all of `src/dashboard/components/types.ts`.
2. For each exported type/interface/const, grep for `import type? { <Name> } from "../types"` (and `./types`, etc.) under `src/dashboard/`.
3. Group types by which feature folder uses them most. Types used by exactly one feature folder move into that folder's `types.ts`. Types used by 2+ folders stay in `src/dashboard/components/types.ts`.
4. Update import paths in each consuming file.

**Concrete file list** to be created/modified:
```
src/dashboard/components/queue/types.ts          ← (new) types used only by queue/
src/dashboard/components/logs/types.ts           ← (new) types used only by logs/
src/dashboard/components/screenshots/types.ts    ← (new, if any)
src/dashboard/components/capture-photo/types.ts  ← (new, if any)
src/dashboard/components/inbox/types.ts          ← (new, if any)
src/dashboard/components/navbar/types.ts         ← (new, if any)
src/dashboard/components/run-controls/types.ts   ← (new, if any)
src/dashboard/components/types.ts                ← (modified) only the cross-feature types remain
```

If a folder has zero types of its own (no new file needed), do not create an empty file.

#### Task 7 — Mirror `tests/unit/core/` to new `core/` structure

**Moves under `tests/unit/core/`:**
```
Existing flat files                                           → mirrored subfolder

batch-lifecycle.test.ts          → tests/unit/core/kernel/batch-lifecycle.test.ts
batch.test.ts                    → tests/unit/core/kernel/batch.test.ts
ctx.test.ts                      → tests/unit/core/kernel/ctx.test.ts
empty-systems.test.ts            → tests/unit/core/kernel/empty-systems.test.ts
handler-throw-screenshot.test.ts → tests/unit/core/kernel/handler-throw-screenshot.test.ts
initial-data.test.ts             → tests/unit/core/kernel/initial-data.test.ts
name-id-computation.test.ts      → tests/unit/core/kernel/name-id-computation.test.ts
observer-wiring.test.ts          → tests/unit/core/kernel/observer-wiring.test.ts
pool.test.ts                     → tests/unit/core/kernel/pool.test.ts
prefilled.test.ts                → tests/unit/core/kernel/prefilled.test.ts
registry.test.ts                 → tests/unit/core/kernel/registry.test.ts
retry.test.ts                    → tests/unit/core/kernel/retry.test.ts
richness-warning.test.ts         → tests/unit/core/kernel/richness-warning.test.ts
run-one-item.test.ts             → tests/unit/core/kernel/run-one-item.test.ts
screenshot.test.ts               → tests/unit/core/kernel/screenshot.test.ts
session-capture.test.ts          → tests/unit/core/kernel/session-capture.test.ts
session-isolated-dir.test.ts     → tests/unit/core/kernel/session-isolated-dir.test.ts
session.test.ts                  → tests/unit/core/kernel/session.test.ts
shared-context-pool.test.ts      → tests/unit/core/kernel/shared-context-pool.test.ts
stepper.test.ts                  → tests/unit/core/kernel/stepper.test.ts
updatedata-types.test.ts         → tests/unit/core/kernel/updatedata-types.test.ts
workflow.test.ts                 → tests/unit/core/kernel/workflow.test.ts
workflow-loaders.test.ts         → tests/unit/core/kernel/workflow-loaders.test.ts
                                  (moved alongside the source per Task 3)

daemon-client.test.ts            → tests/unit/core/daemon/client.test.ts (rename!)
daemon-queue.test.ts             → tests/unit/core/daemon/queue.test.ts (rename!)
daemon-registry.test.ts          → tests/unit/core/daemon/registry.test.ts (rename!)
daemon.test.ts                   → tests/unit/core/daemon/daemon.test.ts
enqueue-dispatch.test.ts         → tests/unit/core/daemon/enqueue-dispatch.test.ts
in-process-runs.test.ts          → tests/unit/core/daemon/in-process-runs.test.ts
worker-store.test.ts             → tests/unit/core/daemon/worker-store.test.ts

task-display-control.test.ts     → tests/unit/core/tasks/display-control.test.ts (rename!)
task-store.test.ts               → tests/unit/core/tasks/store.test.ts (rename!)

control-db.test.ts               → tests/unit/core/control-db.test.ts (UNCHANGED — stays flat
                                                                       because src equivalent
                                                                       stays flat)
```

**Notes:**
- The `daemon-*.test.ts` and `task-*.test.ts` files lose the redundant prefix (the folder name carries the namespace now).
- The subject-under-test imports inside each file (e.g. `import ... from "../../../src/core/kernel/stepper.js"`) need depth fixed (one extra `../`).

#### Task 8 — Rename `tests/unit/tracker/` → `tests/unit/server/` with mirrored structure

This task depends on Task 2 having landed (so the destination structure exists). Mirror the new `src/server/` tree:

**Top-level rename:**
```
tests/unit/tracker/         → tests/unit/server/  (the entire folder is renamed)
```

**Within the new tests/unit/server/, mirror `src/server/` structure** by moving these test files into subfolders:

```
dashboard-hono.test.ts                    → tests/unit/server/api/app.test.ts (rename!)
dashboard-hono-capture.test.ts            → tests/unit/server/routes/capture.test.ts (rename!)
dashboard-hono-oath-upload.test.ts        → tests/unit/server/routes/oath-upload.test.ts
dashboard-hono-ocr.test.ts                → tests/unit/server/routes/ocr.test.ts
dashboard-hono-ops.test.ts                → tests/unit/server/routes/ops.test.ts
dashboard-hono-retirement.test.ts         → tests/unit/server/routes/retirement.test.ts
dashboard-hono-sse.test.ts                → tests/unit/server/sse.test.ts (rename!)

dashboard.test.ts                         → tests/unit/server/dashboard-init.test.ts (rename
                                            ONLY if there's a name collision; otherwise keep flat
                                            at tests/unit/server/dashboard.test.ts — NB the source
                                            file no longer exists at src/tracker/dashboard.ts; the
                                            test now points at src/server/index.ts so the test name
                                            should reflect that. Subagent picks the best name.)

dashboard-ops.test.ts                     → tests/unit/server/ops/index.test.ts
dashboard-responses.test.ts               → tests/unit/server/responses.test.ts
dashboard-screenshots.test.ts             → tests/unit/server/screenshots.test.ts

events-failure-counts.test.ts             → tests/unit/server/routes/events-failure-counts.test.ts
events-runid-fallback.test.ts             → tests/unit/server/routes/events-runid-fallback.test.ts
run-events-sse.test.ts                    → tests/unit/server/routes/run-events-sse.test.ts

failure-detector.test.ts                  → tests/unit/tracker/failure-detector.test.ts ← STAYS in tracker/
                                            (because src/tracker/failure-detector.ts stays in tracker/)

failures-endpoint.test.ts                 → tests/unit/server/failures.test.ts (rename!)
file-registry.test.ts                     → tests/unit/tracker/file-registry.test.ts ← STAYS (src files.ts stays)
jsonl.test.ts                             → tests/unit/tracker/jsonl.test.ts ← STAYS
multipart-helper.test.ts                  → tests/unit/server/multipart-helper.test.ts (moves to server)
oath-upload-http.test.ts                  → tests/unit/server/oath-upload-http.test.ts
ocr-http.test.ts                          → tests/unit/server/routes/ocr-http.test.ts
pdf-cache.test.ts                         → tests/unit/tracker/pdf-cache.test.ts ← STAYS
preassigned-instance.test.ts              → tests/unit/server/routes/preassigned-instance.test.ts (or wherever its src target landed; subagent verifies)
preview-inbox.test.ts                     → tests/unit/server/preview-inbox.test.ts
screenshot-events.test.ts                 → tests/unit/server/screenshot-events.test.ts
screenshots-endpoint.test.ts              → tests/unit/server/routes/screenshots.test.ts
search-endpoint.test.ts                   → tests/unit/server/routes/search.test.ts
selector-warnings-endpoint.test.ts        → tests/unit/server/routes/selector-warnings.test.ts
session-events-runid.test.ts              → tests/unit/tracker/session-events-runid.test.ts ← STAYS
session-events.test.ts                    → tests/unit/tracker/session-events.test.ts ← STAYS
signal-listeners.test.ts                  → tests/unit/server/signal-listeners.test.ts (verify src location)
state-db.test.ts                          → tests/unit/tracker/state/db.test.ts (mirror state/)
state-jsonl-live-apply.test.ts            → tests/unit/tracker/state/jsonl-live-apply.test.ts
state-projector.test.ts                   → tests/unit/tracker/state/projector.test.ts
state-queries.test.ts                     → tests/unit/tracker/state/queries.test.ts
step-change-dedup.test.ts                 → tests/unit/server/routes/step-change-dedup.test.ts (verify)
timestamp-normalization.test.ts           → tests/unit/server/timestamp-normalization.test.ts (verify)
watch-child-runs.test.ts                  → tests/unit/tracker/watch-child-runs.test.ts ← STAYS
workflows-endpoint.test.ts                → tests/unit/server/workflows.test.ts
auth-observer.test.ts                     → tests/unit/tracker/auth-observer.test.ts ← STAYS

tasks/http.test.ts                        → tests/unit/server/tasks/http.test.ts
tasks/ocr-continuation.test.ts            → tests/unit/server/tasks/ocr-continuation.test.ts
tasks/scheduler.test.ts                   → tests/unit/server/tasks/scheduler.test.ts
tasks/store.test.ts                       → tests/unit/server/tasks/store.test.ts
```

**Important:** the `STAYS` notes mean those test files stay in `tests/unit/tracker/` (which still exists, just smaller). After the moves, `tests/unit/tracker/` should contain only the tests for files that stayed in `src/tracker/`. The subagent verifies the source-side location post-Task-2 before deciding each file's destination.

---

## Tasks

### Task 1 — Dashboard component grouping

**Branch:** `refactor/dashboard-grouping`

**Files:** see "Phase 1 changes — Task 1" above. ~38 file moves into 7 new folders.

**Commit message:**
```
refactor(dashboard): group flat components into 7 feature folders

Group 38 top-level files in src/dashboard/components/ into run-controls/,
queue/, logs/, screenshots/, capture-photo/, inbox/, and navbar/ by feature
cohesion. EditDataTab.tsx, StepPipeline.tsx, PdfPagePreview.tsx,
SharePointDownloadButton.tsx, and types.ts stay at the root (types.ts is
split in a follow-up task). All imports updated; behavior unchanged.
```

- [ ] **Step 1: Establish baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

Expected: all green. If anything fails, abort the task and report.

- [ ] **Step 2: Create the 7 destination folders**

```bash
cd src/dashboard/components
mkdir -p run-controls queue logs screenshots capture-photo inbox navbar
```

- [ ] **Step 3: Move files (use `git mv` for every file so history is preserved)**

```bash
# run-controls/
git mv RunModal.tsx run-controls/
git mv RunSelector.tsx run-controls/
git mv QuickRunPanel.tsx run-controls/
git mv TopBarRunButton.tsx run-controls/
git mv WorkflowRail.tsx run-controls/
git mv WorkflowBox.tsx run-controls/

# queue/
git mv QueuePanel.tsx queue/
git mv EntryItem.tsx queue/
git mv QueueItemControls.tsx queue/
git mv RetryButton.tsx queue/
git mv RetryAllButton.tsx queue/
git mv CancelRunningButton.tsx queue/
git mv StatPills.tsx queue/
git mv EmptyState.tsx queue/
git mv entry-display.ts queue/
git mv queue-status.ts queue/
git mv status-styles.ts queue/

# logs/
git mv LogPanel.tsx logs/
git mv LogStream.tsx logs/
git mv LogLine.tsx logs/
git mv TerminalDrawer.tsx logs/
git mv log-display.ts logs/
git mv log-fallback.ts logs/

# screenshots/
git mv ScreenshotCard.tsx screenshots/
git mv ScreenshotLightbox.tsx screenshots/
git mv ScreenshotsPanel.tsx screenshots/
git mv SelectorWarningsPanel.tsx screenshots/

# capture-photo/
git mv CapturePhotoLightbox.tsx capture-photo/
git mv CapturePhotoTile.tsx capture-photo/
git mv capture-types.ts capture-photo/

# inbox/
git mv ApprovalInbox.tsx inbox/
git mv SearchBar.tsx inbox/
git mv SearchResults.tsx inbox/

# navbar/
git mv TopBar.tsx navbar/
git mv TopBarCaptureButton.tsx navbar/
git mv FailureBell.tsx navbar/
git mv LiveIndicator.tsx navbar/
git mv BrowserChip.tsx navbar/
```

- [ ] **Step 4: Run typecheck — let the compiler show what's broken**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck 2>&1 | head -200
```

Expected: many `Cannot find module` errors. Each error names a file with a broken import. Use the import-update playbook (above) to fix each one. Common patterns:

- Files INSIDE the new folders that imported each other now need `./X` instead of `./X` (no change for siblings) but `../hooks/X` instead of `./hooks/X` for hooks/, ui/ imports.
- Files OUTSIDE the new folders (App.tsx, workflows-context.tsx, sibling components, OCR subfolder, oath-upload subfolder) that imported `./Foo` now need `./<feature>/Foo`.

Iterate: edit one file, re-run `npm run typecheck`, repeat until 0 errors.

- [ ] **Step 5: Run all verification gates**

```bash
npm run typecheck     # 0 errors
npm run test          # all green (snapshot tests may rebuild — that's fine)
npm run test:architecture  # all green
```

- [ ] **Step 6: Update the dashboard CLAUDE.md component tree**

Open `src/dashboard/CLAUDE.md` and find the component tree section. Update file paths to reflect the new folder structure. Add a one-line "2026-05-06: grouped flat components into 7 feature folders" entry to the Lessons Learned section if one exists. Do not rewrite the whole file.

- [ ] **Step 7: Show diff & commit**

```bash
git status --short
git diff --stat
git add -A
git commit -m "$(cat <<'EOF'
refactor(dashboard): group flat components into 7 feature folders

Group 38 top-level files in src/dashboard/components/ into run-controls/,
queue/, logs/, screenshots/, capture-photo/, inbox/, and navbar/ by feature
cohesion. EditDataTab.tsx, StepPipeline.tsx, PdfPagePreview.tsx,
SharePointDownloadButton.tsx, and types.ts stay at the root (types.ts is
split in a follow-up task). All imports updated; behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 2 — Backend split (`src/tracker/` → `src/tracker/` + `src/server/`)

**Branch:** `refactor/server-split`

**Files:** see "Phase 1 changes — Task 2" above. New top-level `src/server/` folder.

**Commit message:**
```
refactor(server): split src/tracker/ HTTP layer into src/server/

Move the Hono app, routes, ocr/ops handlers, and HTTP-specific helpers
(multipart-helper, oath-upload-http) out of src/tracker/dashboard/ into a
new top-level src/server/. Flatten the redundant hono/ subfolder. The
src/tracker/dashboard.ts entry becomes src/server/index.ts. State DB,
JSONL, watchers, and PDF cache stay in src/tracker/. Top-level layout now
reads as src/dashboard/ (UI) ↔ src/server/ (API).
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 2: Create the destination folders**

```bash
cd src
mkdir -p server/routes server/ocr server/ops server/tasks
```

- [ ] **Step 3: Move the Hono layer**

```bash
git mv tracker/dashboard.ts            server/index.ts
git mv tracker/dashboard/server.ts     server/server.ts
git mv tracker/dashboard/hono/app.ts        server/app.ts
git mv tracker/dashboard/hono/context.ts    server/context.ts
git mv tracker/dashboard/hono/manifest.ts   server/manifest.ts
git mv tracker/dashboard/hono/multipart.ts  server/multipart.ts
git mv tracker/dashboard/hono/responses.ts  server/responses.ts
git mv tracker/dashboard/hono/sse.ts        server/sse.ts

# routes (whole folder)
for f in tracker/dashboard/hono/routes/*.ts; do
  git mv "$f" "server/routes/$(basename "$f")"
done

# ocr handlers
for f in tracker/dashboard/ocr/*.ts; do
  git mv "$f" "server/ocr/$(basename "$f")"
done

# ops handlers
for f in tracker/dashboard/ops/*.ts; do
  git mv "$f" "server/ops/$(basename "$f")"
done

# loose handler/state-query files at tracker/dashboard/ root
git mv tracker/dashboard/capture-state.ts        server/capture-state.ts
git mv tracker/dashboard/failures.ts             server/failures.ts
git mv tracker/dashboard/prep-rows.ts            server/prep-rows.ts
git mv tracker/dashboard/preview-inbox.ts        server/preview-inbox.ts
git mv tracker/dashboard/run-timelines.ts        server/run-timelines.ts
git mv tracker/dashboard/screenshots.ts          server/screenshots.ts
git mv tracker/dashboard/search.ts               server/search.ts
git mv tracker/dashboard/selector-warnings.ts    server/selector-warnings.ts
git mv tracker/dashboard/session-state.ts        server/session-state.ts
git mv tracker/dashboard/sweeps.ts               server/sweeps.ts
git mv tracker/dashboard/workflows.ts            server/workflows.ts

# HTTP-specific files at tracker/ root
git mv tracker/multipart-helper.ts   server/multipart-helper.ts
git mv tracker/oath-upload-http.ts   server/oath-upload-http.ts

# tasks subtree (HTTP scheduler)
for f in tracker/tasks/*.ts; do
  git mv "$f" "server/tasks/$(basename "$f")"
done

# clean up the now-empty subtrees
rmdir tracker/dashboard/hono/routes tracker/dashboard/hono \
      tracker/dashboard/ocr tracker/dashboard/ops tracker/dashboard \
      tracker/tasks
```

- [ ] **Step 4: Update `src/cli.ts` `dashboard` command import**

Open `src/cli.ts`, find the import that resolves to `./tracker/dashboard.js` (used by the `dashboard` subcommand). Change it to `./server/index.js`. Verify with `grep -n 'tracker/dashboard\|server/index' src/cli.ts`.

- [ ] **Step 5: Run typecheck and fix the storm of broken imports**

```bash
npm run typecheck 2>&1 | head -300
```

There will be many errors. Use the import-update playbook. Most broken imports will be:
- Files inside `server/` that imported each other through the old `dashboard/hono/...` paths — fix to local `./X.js` or `./routes/X.js`.
- Files outside (`tracker/state/`, `tracker/jsonl.ts`, `core/`, `workflows/`, `capture/`, `dashboard/` UI) that imported from `tracker/dashboard/...` or `tracker/multipart-helper.js` etc. — fix to `server/...`.

Iterate until 0 errors.

- [ ] **Step 6: Run all verification gates**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

If `tests/integration/oath-upload-smoke.test.ts` imports the old path, fix it. Tests under `tests/unit/tracker/` that reference moved files need their imports fixed too — but the test files themselves do NOT move yet (Task 8 handles that).

- [ ] **Step 7: Update CLAUDE.md prose references** (do not move test files yet)

```bash
grep -rln "src/tracker/dashboard" src/ docs/ 2>/dev/null
```

For each file the grep finds, change `src/tracker/dashboard.ts` → `src/server/index.ts`, and `src/tracker/dashboard/...` → `src/server/...` (with the appropriate sub-path collapse since `hono/` is gone). Drop any line numbers that referenced the old file — they're stale now.

- [ ] **Step 8: Update `src/tracker/CLAUDE.md` and `src/tracker/index.ts`**

`src/tracker/CLAUDE.md`: rewrite the top section to make clear the folder is the **state/observability layer** and the HTTP API has moved to `src/server/`. Keep the existing state/JSONL/PDF-cache documentation.

`src/tracker/index.ts`: drop any re-exports of files that moved to `src/server/`.

- [ ] **Step 9: Create `src/server/CLAUDE.md` (minimal)**

Create a small CLAUDE.md at the root of the new `src/server/` folder. Suggested content (adjust for accuracy after touring the moved files):

```markdown
# src/server — Dashboard backend (HTTP / SSE / API)

The HTTP API for the React dashboard frontend (`src/dashboard/`). Moved here
from `src/tracker/dashboard/` on 2026-05-06 to make the boundary explicit:
state lives in `src/tracker/`, the API that serves it lives here.

## Layout

- `index.ts` — entry point invoked by `src/cli.ts dashboard`. Bootstraps
  the server.
- `server.ts` — server lifecycle (start/stop, port, signal handlers).
- `app.ts` — Hono app construction, middleware wiring.
- `routes/` — one file per route group (events, capture, ocr, ops, ...).
- `ocr/`, `ops/` — handler implementations called by routes.
- `tasks/` — task scheduler + HTTP wrappers around `core/tasks/store/`.
- Loose `*.ts` at the root — read-state aggregators that shape responses
  (`run-timelines.ts`, `capture-state.ts`, `prep-rows.ts`, etc.).
- `multipart-helper.ts`, `multipart.ts`, `responses.ts`, `sse.ts` — HTTP
  utilities.

## Boundary

- Pure state I/O (JSONL append, state DB queries, file management) belongs
  in `src/tracker/`, not here.
- The frontend (`src/dashboard/`) talks to this layer via HTTP/SSE only —
  no direct imports across the boundary.
```

- [ ] **Step 10: Commit**

```bash
git status --short
git diff --stat
git add -A
git commit -m "$(cat <<'EOF'
refactor(server): split src/tracker/ HTTP layer into src/server/

Move the Hono app, routes, ocr/ops handlers, and HTTP-specific helpers
(multipart-helper, oath-upload-http) out of src/tracker/dashboard/ into a
new top-level src/server/. Flatten the redundant hono/ subfolder. The
src/tracker/dashboard.ts entry becomes src/server/index.ts. State DB,
JSONL, watchers, and PDF cache stay in src/tracker/. Top-level layout now
reads as src/dashboard/ (UI) ↔ src/server/ (API).
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 3 — `core/` root cleanup

**Branch:** `refactor/core-root-cleanup`

**Files:** see "Phase 1 changes — Task 3" above.

**Commit message:**
```
refactor(core): consolidate task-* into core/tasks/, move kernel orphans

Group task-store/, task-control.ts, task-display.ts under a new core/tasks/
folder (the parent-task → child-run delegation system, coherent enough to
share a folder). Move find-input.ts and workflow-loaders.ts into
core/kernel/ where they conceptually belong. control-db.ts/control-schema.ts
stay flat at core/ root. Behavior unchanged.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 2: Create destination folders and move files**

```bash
cd src/core
mkdir -p tasks

git mv task-store        tasks/store
git mv task-control.ts   tasks/control.ts
git mv task-display.ts   tasks/display.ts

git mv find-input.ts        kernel/find-input.ts
git mv workflow-loaders.ts  kernel/workflow-loaders.ts
```

- [ ] **Step 3: Update typecheck-discovered broken imports**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck 2>&1 | head -200
```

Common breaks:
- `from "../core/task-store/..."` → `from "../core/tasks/store/..."`
- `from "../core/task-control.js"` → `from "../core/tasks/control.js"`
- `from "../core/task-display.js"` → `from "../core/tasks/display.js"`
- `from "../core/find-input.js"` → `from "../core/kernel/find-input.js"`
- `from "../core/workflow-loaders.js"` → `from "../core/kernel/workflow-loaders.js"`

Iterate until 0 errors.

- [ ] **Step 4: Run all verification gates**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 5: Update `src/core/CLAUDE.md`**

Update the module map section to show `tasks/` exists and lists its three children. Note in a Lessons Learned entry (dated 2026-05-06) that the task-* trio was consolidated, and that `find-input` / `workflow-loaders` are kernel-internal.

- [ ] **Step 6: Update `src/core/index.ts` re-export paths if it re-exports any of the moved files**

```bash
grep -n 'task-store\|task-control\|task-display\|find-input\|workflow-loaders' src/core/index.ts
```

For every match, update the path. Do not change the export name.

- [ ] **Step 7: Commit**

```bash
git status --short
git diff --stat
git add -A
git commit -m "$(cat <<'EOF'
refactor(core): consolidate task-* into core/tasks/, move kernel orphans

Group task-store/, task-control.ts, task-display.ts under a new core/tasks/
folder (the parent-task → child-run delegation system, coherent enough to
share a folder). Move find-input.ts and workflow-loaders.ts into
core/kernel/ where they conceptually belong. control-db.ts/control-schema.ts
stay flat at core/ root. Behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 4 — Workflow folder consistency

**Branch:** `refactor/workflows-consistency`

**Files:** see "Phase 1 changes — Task 4" above.

**Commit message** (single commit covers all three sub-actions):
```
refactor(workflows): adopt steps/ folder; cleanup leftover cli.ts; fold notes

Add a steps/ folder for oath-upload, onboarding, and ocr (each has 3+ per-step
orchestration files). emergency-contact stays flat (only 2 step-shaped files).
Verify-then-delete the orphaned src/workflows/separations/cli.ts that was
left behind during the daemon-mode conversion. Fold EID-LOOKUP-NOTES.md into
eid-lookup/CLAUDE.md so each workflow folder has exactly one doc file.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 2: Move oath-upload step files**

```bash
cd src/workflows/oath-upload
mkdir -p steps
git mv handler.ts            steps/handler.ts
git mv fill-form.ts          steps/fill-form.ts
git mv duplicate-check.ts    steps/duplicate-check.ts
git mv wait-ocr-approval.ts  steps/wait-ocr-approval.ts
```

- [ ] **Step 3: Move onboarding step files**

```bash
cd /Users/julianhein/Documents/hr-automation/src/workflows/onboarding
mkdir -p steps
git mv download.ts    steps/download.ts
git mv enter.ts       steps/enter.ts
git mv extract.ts     steps/extract.ts
git mv positional.ts  steps/positional.ts
```

- [ ] **Step 4: Move ocr step files**

```bash
cd /Users/julianhein/Documents/hr-automation/src/workflows/ocr
mkdir -p steps
git mv carry-forward.ts        steps/carry-forward.ts
git mv force-research.ts       steps/force-research.ts
git mv retry-page.ts           steps/retry-page.ts
git mv eid-lookup-results.ts   steps/eid-lookup-results.ts
```

- [ ] **Step 5: Verify-then-delete `separations/cli.ts`**

```bash
cd /Users/julianhein/Documents/hr-automation
grep -rn "workflows/separations/cli\b" src tests scripts package.json
```

If the grep returns ZERO matches, delete:

```bash
git rm src/workflows/separations/cli.ts
```

If the grep returns matches, **do not delete** — surface the callers to the user instead and skip this sub-step. Continue with the rest of the task.

- [ ] **Step 6: Fold `EID-LOOKUP-NOTES.md` into `CLAUDE.md`**

```bash
cd src/workflows/eid-lookup
# Append the notes to CLAUDE.md under a new H2 section.
{
  echo
  echo "## Notes (folded from EID-LOOKUP-NOTES.md, 2026-05-06)"
  echo
  cat EID-LOOKUP-NOTES.md
} >> CLAUDE.md
git rm EID-LOOKUP-NOTES.md
git add CLAUDE.md
```

(If the existing CLAUDE.md already covers the notes' content, simply `git rm EID-LOOKUP-NOTES.md` without appending. Subagent uses judgment after reading both.)

- [ ] **Step 7: Fix typecheck imports**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck 2>&1 | head -200
```

Common breaks:
- `from "./handler.js"` (within oath-upload/workflow.ts) → `from "./steps/handler.js"`
- `from "./download.js"` (within onboarding/workflow.ts) → `from "./steps/download.js"`
- Within the moved step files, sibling step imports stay `./X.js`.
- Imports of step files from outside the workflow (e.g., tests) → `./steps/X.js`.

Iterate to 0 errors.

- [ ] **Step 8: Run all verification gates**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 9: Update CLAUDE.md files for the three affected workflows**

`src/workflows/oath-upload/CLAUDE.md`, `src/workflows/onboarding/CLAUDE.md`, `src/workflows/ocr/CLAUDE.md`: update file-tree sections to show the new `steps/` folder. Add a one-line dated lessons entry to each.

- [ ] **Step 10: Commit**

```bash
git status --short
git diff --stat
git add -A
git commit -m "$(cat <<'EOF'
refactor(workflows): adopt steps/ folder; cleanup leftover cli.ts; fold notes

Add a steps/ folder for oath-upload, onboarding, and ocr (each has 3+ per-step
orchestration files). emergency-contact stays flat (only 2 step-shaped files).
Verify-then-delete the orphaned src/workflows/separations/cli.ts that was
left behind during the daemon-mode conversion. Fold EID-LOOKUP-NOTES.md into
eid-lookup/CLAUDE.md so each workflow folder has exactly one doc file.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 5 — Move `src/match/` → `src/domain/match/`

**Branch:** `refactor/match-into-domain`

**Files:** see "Phase 1 changes — Task 5" above.

**Commit message:**
```
refactor(domain): move src/match/ → src/domain/match/

Name-matching (levenshtein, fuzzy match, roster loader) is domain logic
mislocated by history; relocating it next to domain/identity/ and
domain/hdh/. All importers in src/ocr/, src/workflows/, src/tracker/, and
tests updated. Behavior unchanged.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 2: Move the folder**

```bash
cd src
mkdir -p domain/match
git mv match/index.ts          domain/match/index.ts
git mv match/levenshtein.ts    domain/match/levenshtein.ts
git mv match/match.ts          domain/match/match.ts
git mv match/roster-loader.ts  domain/match/roster-loader.ts
rmdir match
```

- [ ] **Step 3: Update importers (full set, verified by grep)**

Run grep, then fix each file the playbook surfaces:

```bash
cd /Users/julianhein/Documents/hr-automation
grep -rn "from ['\"].*\\.\\./match" src tests 2>/dev/null
```

Edit each file to point at `domain/match/` instead of `match/`. Examples:

```typescript
// src/ocr/lookup-suggestions.ts
- import { normalizeEid } from "../match/index.js";
+ import { normalizeEid } from "../domain/match/index.js";

// src/workflows/ocr/steps/retry-page.ts (note: post-Task-4 it lives under steps/)
- import { loadRoster as realLoadRoster } from "../../match/index.js";
- import type { RosterRow as MatchRosterRow } from "../../match/match.js";
+ import { loadRoster as realLoadRoster } from "../../../domain/match/index.js";
+ import type { RosterRow as MatchRosterRow } from "../../../domain/match/match.js";
```

(NB: in the parallel-worktree setup, Task 5's worktree branched from `master` BEFORE Task 4 landed, so it sees `src/workflows/ocr/retry-page.ts` at the workflow root. The merge into master is sequential — the orchestrator will surface any conflict in `retry-page.ts` and the user resolves it. Keep the import-update logic the same regardless of source path; just verify the depth-of-relative-path matches what the file system actually shows.)

- [ ] **Step 4: Update test files** (paths only — tests do not move)

```bash
grep -rn "from ['\"].*src/match" tests 2>/dev/null
```

For each match, update `src/match/X.js` → `src/domain/match/X.js`.

- [ ] **Step 5: Run all verification gates**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 6: Update CLAUDE.md prose references**

```bash
grep -rln "src/match\b" src/ docs/
```

Update each prose mention. Common spots: root `CLAUDE.md` "Shared workflow primitives" list (if present), `src/workflows/CLAUDE.md`, `src/workflows/emergency-contact/CLAUDE.md`, `src/workflows/ocr/CLAUDE.md`.

- [ ] **Step 7: Commit**

```bash
git status --short
git diff --stat
git add -A
git commit -m "$(cat <<'EOF'
refactor(domain): move src/match/ → src/domain/match/

Name-matching (levenshtein, fuzzy match, roster loader) is domain logic
mislocated by history; relocating it next to domain/identity/ and
domain/hdh/. All importers in src/ocr/, src/workflows/, src/tracker/, and
tests updated. Behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

## Phase 1 merge sequence (orchestrator only)

After all five Phase 1 subagents complete and report success, the orchestrator (Opus) does the merges sequentially on `master`:

```bash
# Verify clean state
git checkout master
git status --short

# Merge each branch with --no-ff (one at a time; resolve any conflicts)
git merge --no-ff refactor/dashboard-grouping
npm run typecheck && npm run test && npm run test:architecture

git merge --no-ff refactor/server-split
npm run typecheck && npm run test && npm run test:architecture

git merge --no-ff refactor/core-root-cleanup
npm run typecheck && npm run test && npm run test:architecture

git merge --no-ff refactor/workflows-consistency
npm run typecheck && npm run test && npm run test:architecture

git merge --no-ff refactor/match-into-domain
npm run typecheck && npm run test && npm run test:architecture

# Clean up worktrees
git worktree remove <each path>
```

If any merge produces a conflict, resolve it manually (most likely place: `src/workflows/ocr/retry-page.ts` between Tasks 4 and 5, since both touch `src/workflows/ocr/`). Conflict resolution is part of the orchestrator's job, not the subagent's.

If any post-merge verification fails, **do not proceed to the next merge** — report and pause.

After all merges and worktree cleanup, Phase 2 can begin.

---

### Task 6 — Split `src/dashboard/components/types.ts`

**Phase:** 2 (runs after Phase 1 merges complete).
**No worktree** — direct on master.

**Files:** see "Phase 2 changes — Task 6" above.

**Commit message:**
```
refactor(dashboard): split components/types.ts into per-feature type files

Move types used by exactly one feature folder into that folder's own
types.ts. Types referenced by 2+ folders stay in the root types.ts. JSDoc
references to src/server/index.ts (formerly src/tracker/dashboard.ts) kept
intact. Behavior unchanged.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

- [ ] **Step 2: Read the existing types.ts and inventory its exports**

```bash
cd /Users/julianhein/Documents/hr-automation
grep -nE "^(export |export type |export interface |export const |export enum )" \
  src/dashboard/components/types.ts
```

Note each export's name.

- [ ] **Step 3: For each export, find where it's imported from**

For each export name `<Name>`:

```bash
grep -rln "import .* { .*\\b<Name>\\b.* } from .*['\"].*\\b/types['\"]" src/dashboard/
```

Build a map:
- `<Name>` is imported by [`run-controls/RunModal.tsx`, `queue/EntryItem.tsx`, ...]
- `<Name>` is imported by ONLY [`logs/LogPanel.tsx`, `logs/LogStream.tsx`] → owned by `logs/`
- etc.

(If the grep is noisy, narrow by listing files per folder and grepping each in turn.)

- [ ] **Step 4: For types owned by exactly one folder, create that folder's types.ts and move the type**

```typescript
// Example — src/dashboard/components/queue/types.ts (NEW FILE)
import type { Foo, Bar } from "../types.js";  // re-import any cross-feature deps

export interface QueueRowDisplay {
  // ... copied from root types.ts
}

export type QueueStatus = "idle" | "running" | "done";
```

Then delete those types from `src/dashboard/components/types.ts`. Keep export-name spelling identical.

- [ ] **Step 5: Update consuming imports**

For every file that imported one of the moved types from `../types` or `../../types`, change the path to point at the new per-folder `types.ts`:

```typescript
// before
- import type { QueueRowDisplay } from "../types.js";
// after
+ import type { QueueRowDisplay } from "./types.js";  // file is in queue/
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm run test && npm run test:architecture
```

If any new `types.ts` ended up empty (no types belonged solely to its folder), delete the empty file. Don't ship empty files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(dashboard): split components/types.ts into per-feature type files

Move types used by exactly one feature folder into that folder's own
types.ts. Types referenced by 2+ folders stay in the root types.ts. JSDoc
references to src/server/index.ts (formerly src/tracker/dashboard.ts) kept
intact. Behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 7 — Mirror `tests/unit/core/` to new core/ structure

**Phase:** 2.
**No worktree** — direct on master. Runs in parallel with Task 6 and Task 8 (disjoint trees).

**Files:** see "Phase 2 changes — Task 7" above.

**Commit message:**
```
test(core): mirror src/core/{kernel,daemon,tasks}/ subfolder structure

Split the flat tests/unit/core/ into kernel/, daemon/, and tasks/
subfolders mirroring src/core/ post-reorg. Drop the redundant
"daemon-" / "task-" filename prefixes (the folder name carries the
namespace). control-db.test.ts stays flat (its source equivalent stays
flat). Test behavior unchanged.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test
```

- [ ] **Step 2: Create destination subfolders**

```bash
cd tests/unit/core
mkdir -p kernel daemon tasks
```

- [ ] **Step 3: Move kernel tests**

```bash
git mv batch-lifecycle.test.ts          kernel/batch-lifecycle.test.ts
git mv batch.test.ts                    kernel/batch.test.ts
git mv ctx.test.ts                      kernel/ctx.test.ts
git mv empty-systems.test.ts            kernel/empty-systems.test.ts
git mv handler-throw-screenshot.test.ts kernel/handler-throw-screenshot.test.ts
git mv initial-data.test.ts             kernel/initial-data.test.ts
git mv name-id-computation.test.ts      kernel/name-id-computation.test.ts
git mv observer-wiring.test.ts          kernel/observer-wiring.test.ts
git mv pool.test.ts                     kernel/pool.test.ts
git mv prefilled.test.ts                kernel/prefilled.test.ts
git mv registry.test.ts                 kernel/registry.test.ts
git mv retry.test.ts                    kernel/retry.test.ts
git mv richness-warning.test.ts         kernel/richness-warning.test.ts
git mv run-one-item.test.ts             kernel/run-one-item.test.ts
git mv screenshot.test.ts               kernel/screenshot.test.ts
git mv session-capture.test.ts          kernel/session-capture.test.ts
git mv session-isolated-dir.test.ts     kernel/session-isolated-dir.test.ts
git mv session.test.ts                  kernel/session.test.ts
git mv shared-context-pool.test.ts      kernel/shared-context-pool.test.ts
git mv stepper.test.ts                  kernel/stepper.test.ts
git mv updatedata-types.test.ts         kernel/updatedata-types.test.ts
git mv workflow.test.ts                 kernel/workflow.test.ts
git mv workflow-loaders.test.ts         kernel/workflow-loaders.test.ts
```

- [ ] **Step 4: Move and rename daemon tests**

```bash
git mv daemon-client.test.ts        daemon/client.test.ts
git mv daemon-queue.test.ts         daemon/queue.test.ts
git mv daemon-registry.test.ts      daemon/registry.test.ts
git mv daemon.test.ts               daemon/daemon.test.ts
git mv enqueue-dispatch.test.ts     daemon/enqueue-dispatch.test.ts
git mv in-process-runs.test.ts      daemon/in-process-runs.test.ts
git mv worker-store.test.ts         daemon/worker-store.test.ts
```

- [ ] **Step 5: Move and rename tasks tests**

```bash
git mv task-display-control.test.ts  tasks/display-control.test.ts
git mv task-store.test.ts            tasks/store.test.ts
```

(`control-db.test.ts` stays flat at `tests/unit/core/control-db.test.ts`.)

- [ ] **Step 6: Fix relative imports inside each moved file**

Each test moved one level deeper, so subject-under-test imports need an extra `../`. Example:

```typescript
// before (in tests/unit/core/stepper.test.ts)
import { Stepper } from "../../../src/core/kernel/stepper.js";

// after (in tests/unit/core/kernel/stepper.test.ts)
import { Stepper } from "../../../../src/core/kernel/stepper.js";
```

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all 2>&1 | head -200
npm run test 2>&1 | tail -60
```

Fix import depths until both pass.

- [ ] **Step 7: Verify**

```bash
npm run typecheck:all && npm run test && npm run test:architecture
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(core): mirror src/core/{kernel,daemon,tasks}/ subfolder structure

Split the flat tests/unit/core/ into kernel/, daemon/, and tasks/
subfolders mirroring src/core/ post-reorg. Drop the redundant
"daemon-" / "task-" filename prefixes (the folder name carries the
namespace). control-db.test.ts stays flat (its source equivalent stays
flat). Test behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

### Task 8 — Rename `tests/unit/tracker/` → `tests/unit/server/` with mirrored structure

**Phase:** 2.
**No worktree** — direct on master. Runs in parallel with Tasks 6 and 7 (disjoint trees).

**Files:** see "Phase 2 changes — Task 8" above. The test files move; `tests/unit/tracker/` shrinks to only those tests whose source file stayed in `src/tracker/`.

**Commit message:**
```
test(server): mirror new src/server/ structure; tests/unit/tracker/ shrinks

Tests for files that moved into src/server/ (Hono routes, ocr/ops handlers,
HTTP utilities, scheduler tasks) move to tests/unit/server/ with subfolders
mirroring server/{routes,ocr,ops,tasks}/. Tests for files that stayed in
src/tracker/ (state DB, JSONL, watchers, PDF cache) stay in
tests/unit/tracker/. Drop the redundant "dashboard-hono-" / "-endpoint"
filename prefixes. Test behavior unchanged.
```

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test
```

- [ ] **Step 2: Determine destination per file by checking the source**

Before moving each test, the subagent confirms where its source-under-test landed by grepping `src/server/` and `src/tracker/`. The mapping in "Phase 2 — Task 8" is the planned mapping; if Task 2 or any later edit changed the source location, the test follows the source. Use `grep -rln "from ['\"].*src/" <test-file>` to surface the test's primary import.

- [ ] **Step 3: Create destination subfolders**

```bash
cd tests/unit
mkdir -p server/routes server/ocr server/ops server/tasks server/state
mkdir -p tracker/state
```

(`tracker/state/` is created so tests for `src/tracker/state/` files can mirror their source. The existing `tracker/` folder stays in place.)

- [ ] **Step 4: Move tests for moved-source files into `server/`**

```bash
cd /Users/julianhein/Documents/hr-automation/tests/unit/tracker

# routes/
git mv dashboard-hono-capture.test.ts          ../server/routes/capture.test.ts
git mv dashboard-hono-oath-upload.test.ts      ../server/routes/oath-upload.test.ts
git mv dashboard-hono-ocr.test.ts              ../server/routes/ocr.test.ts
git mv dashboard-hono-ops.test.ts              ../server/routes/ops.test.ts
git mv dashboard-hono-retirement.test.ts       ../server/routes/retirement.test.ts
git mv events-failure-counts.test.ts           ../server/routes/events-failure-counts.test.ts
git mv events-runid-fallback.test.ts           ../server/routes/events-runid-fallback.test.ts
git mv ocr-http.test.ts                        ../server/routes/ocr-http.test.ts
git mv preassigned-instance.test.ts            ../server/routes/preassigned-instance.test.ts
git mv run-events-sse.test.ts                  ../server/routes/run-events-sse.test.ts
git mv screenshots-endpoint.test.ts            ../server/routes/screenshots.test.ts
git mv search-endpoint.test.ts                 ../server/routes/search.test.ts
git mv selector-warnings-endpoint.test.ts      ../server/routes/selector-warnings.test.ts

# server/ root
git mv dashboard-hono.test.ts                  ../server/app.test.ts
git mv dashboard-hono-sse.test.ts              ../server/sse.test.ts
git mv dashboard-responses.test.ts             ../server/responses.test.ts
git mv dashboard-screenshots.test.ts           ../server/screenshots.test.ts
git mv dashboard.test.ts                       ../server/server.test.ts   # if name clash, suffix -init
git mv multipart-helper.test.ts                ../server/multipart-helper.test.ts
git mv oath-upload-http.test.ts                ../server/oath-upload-http.test.ts
git mv preview-inbox.test.ts                   ../server/preview-inbox.test.ts
git mv screenshot-events.test.ts               ../server/screenshot-events.test.ts
git mv signal-listeners.test.ts                ../server/signal-listeners.test.ts
git mv step-change-dedup.test.ts               ../server/step-change-dedup.test.ts
git mv timestamp-normalization.test.ts         ../server/timestamp-normalization.test.ts
git mv workflows-endpoint.test.ts              ../server/workflows.test.ts
git mv failures-endpoint.test.ts               ../server/failures.test.ts
git mv dashboard-ops.test.ts                   ../server/ops/index.test.ts

# tasks/
git mv tasks/http.test.ts              ../server/tasks/http.test.ts
git mv tasks/ocr-continuation.test.ts  ../server/tasks/ocr-continuation.test.ts
git mv tasks/scheduler.test.ts         ../server/tasks/scheduler.test.ts
git mv tasks/store.test.ts             ../server/tasks/store.test.ts
rmdir tasks
```

- [ ] **Step 5: Move state tests into a state/ subfolder under tracker/ (mirror src)**

```bash
git mv state-db.test.ts                state/db.test.ts
git mv state-jsonl-live-apply.test.ts  state/jsonl-live-apply.test.ts
git mv state-projector.test.ts         state/projector.test.ts
git mv state-queries.test.ts           state/queries.test.ts
```

- [ ] **Step 6: Files that stay flat in tests/unit/tracker/**

These don't move (their source stayed in `src/tracker/`):
- `auth-observer.test.ts`
- `failure-detector.test.ts`
- `file-registry.test.ts`
- `jsonl.test.ts`
- `pdf-cache.test.ts`
- `session-events.test.ts`
- `session-events-runid.test.ts`
- `watch-child-runs.test.ts`

Confirm by listing post-move:

```bash
ls /Users/julianhein/Documents/hr-automation/tests/unit/tracker
```

Expected: only the files above plus the new `state/` subfolder.

- [ ] **Step 7: Fix relative imports in every moved file**

For tests that moved from `tests/unit/tracker/X.test.ts` to `tests/unit/server/Y.test.ts`, the relative path to `src/` is unchanged (both are 2 levels deep under `tests/`). For tests that moved an extra level deeper (e.g., into `server/routes/` or `server/tasks/`), add one extra `../`. For tests moved into `tests/unit/tracker/state/`, add one extra `../`.

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all 2>&1 | head -200
npm run test 2>&1 | tail -60
```

Fix imports until both pass. Common patterns to update:
- `from "../../../src/tracker/dashboard/..."` → `from "../../../src/server/..."` (path within src changed)
- `from "../../../src/tracker/multipart-helper.js"` → `from "../../../src/server/multipart-helper.js"` (likewise)
- Path depth: `../../../` from `tests/unit/server/X.test.ts` is correct; `../../../../` from `tests/unit/server/routes/X.test.ts` is correct.

- [ ] **Step 8: Verify**

```bash
npm run typecheck:all && npm run test && npm run test:architecture
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(server): mirror new src/server/ structure; tests/unit/tracker/ shrinks

Tests for files that moved into src/server/ (Hono routes, ocr/ops handlers,
HTTP utilities, scheduler tasks) move to tests/unit/server/ with subfolders
mirroring server/{routes,ocr,ops,tasks}/. Tests for files that stayed in
src/tracker/ (state DB, JSONL, watchers, PDF cache) stay in
tests/unit/tracker/. Drop the redundant "dashboard-hono-" / "-endpoint"
filename prefixes. Test behavior unchanged.
EOF
)"
```

**Apply the universal task wrapper above before submitting.**

---

## Self-review (orchestrator runs this once after all 8 tasks land)

After all 8 tasks have been merged into master:

- [ ] **Architecture guards still green:**

```bash
npm run typecheck:all && npm run test && npm run test:architecture
```

- [ ] **No orphan paths in CLAUDE.md files:**

```bash
grep -rln "src/tracker/dashboard\|src/match\b\|src/core/task-store\|src/core/task-control\|src/core/task-display\|src/core/find-input\|src/core/workflow-loaders" \
  src/ docs/ 2>/dev/null
```

Expected: zero results. Any remaining hits = stale prose; fix.

- [ ] **No left-behind empty folders:**

```bash
find src tests -type d -empty
```

Expected: zero results. Remove any empty dirs that linger.

- [ ] **Manual smoke (UI):**

Per global CLAUDE.md, frontend changes need a browser smoke. Run `npm run dashboard`, open the dashboard, scroll the queue, expand a row, open the run modal, open the OCR pane. Confirm no rendering / interaction regressions. (Behavior should be unchanged but components moved — visual smoke catches stray import / barrel mistakes the type-checker missed.)

- [ ] **Run codex:rescue over the combined diff for an outside-eye review.**

```bash
# from the orchestrator session
/codex rescue
```

Codex reports findings only; the orchestrator implements any fixes.

---

## Plan-coverage check (pre-execution)

- [x] Dashboard components grouped (Task 1)
- [x] Backend split (Task 2)
- [x] core/ root cleanup (Task 3)
- [x] Workflows steps/ folder + cli.ts cleanup + notes fold (Task 4)
- [x] src/match/ → src/domain/match/ (Task 5)
- [x] Dashboard types.ts split (Task 6)
- [x] tests/unit/core/ mirror (Task 7)
- [x] tests/unit/tracker/ → tests/unit/server/ rename + mirror (Task 8)

All 8 alignment items covered.

---

## Mechanical vs. judgment-required tasks

For the orchestrator's planning:

| Task | Type | Why |
|------|------|-----|
| 1 | Mostly mechanical | Move + import-fix, no decisions per-file |
| 2 | Mechanical with light judgment | A handful of borderline files (notify.ts, multipart-helper.ts) decided in the plan; subagent verifies but doesn't pick |
| 3 | Fully mechanical | All destinations specified |
| 4 | Mechanical | Move + delete + fold; one verify-then-delete check |
| 5 | Fully mechanical | Move + import-fix |
| 6 | **Judgment-heavy** | Subagent reads types.ts and decides which type belongs to which folder by usage |
| 7 | Mechanical | Move + rename + import-depth fix |
| 8 | Mechanical with light judgment | Subagent verifies each test's source-under-test before moving (the plan's mapping might drift if an earlier task placed a source slightly differently) |

If Task 6 (types.ts split) becomes ambiguous mid-execution — types that are genuinely shared by 2-3 folders, or types whose ownership isn't clear — the subagent stops and surfaces the ambiguity to the orchestrator rather than guessing.
