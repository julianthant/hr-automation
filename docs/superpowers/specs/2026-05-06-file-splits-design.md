# File Splits + Folder Reorgs — 2026-05-06

## Goal

Reduce navigation/edit friction in 8 oversized files (≥889 lines) and tighten folder cohesion in `src/core/` and `src/auth/`. Zero behavior change — pure code reorganization. Refactor rhythm: baseline tests green → make change → tests still green → commit.

## Non-goals

- No behavior changes of any kind.
- No work on `src/workflows/ocr/orchestrator.ts` (1119) — user excluded; U1 fan-out extraction already handled the obvious chunk.
- No remaining Pathfinder consolidations (U1/U4/U5 already done by user; N1/N2 explicitly skipped).
- No regroup of `src/dashboard/components/` by feature (separate refactor).
- No new abstractions, helpers, or "while we're here" cleanup.

## Current state (verified 2026-05-06)

| File | Lines | Phase |
|---|---|---|
| `src/tracker/dashboard-ops.ts` | 1569 | 2 |
| `src/core/task-store.ts` | 1239 | 1 |
| `src/dashboard/components/CaptureModal.tsx` | 1158 | 1 |
| `src/tracker/ocr-http.ts` | 1060 | 2 |
| `src/core/daemon.ts` | 1051 | 1 |
| `src/workflows/separations/workflow.ts` | 912 | 1 |
| `src/core/workflow.ts` | 889 | 1 |
| `src/auth/telegram-notify.ts` | 181 | 3 (move) |
| `src/core/` (folder) | 27 files | 3 (reorg) |

## Phase 1 — In-place file splits (low blast radius)

Each file becomes a folder of cohesive pieces; a barrel `index.ts` re-exports the original public surface so external imports do not change.

### 1.1 `src/dashboard/components/CaptureModal.tsx` (1158)

Convert to `src/dashboard/components/CaptureModal/` folder:
- `index.tsx` — top-level `CaptureModal` component + the props/types the parent uses
- `ModalChrome.tsx` — outer dialog/backdrop + close button
- `LeftColumn.tsx` — left pane composition (preview/PDF area)
- `RightColumn.tsx` — right pane composition (form area)
- `ActionRow.tsx` — bottom action buttons
- `ExpiryFooter.tsx` — expiry/countdown footer
- `ValidationBanner.tsx` — inline validation banner
- `state.ts` — local state hooks if any are extracted

External callers continue to `import { CaptureModal } from "./components/CaptureModal"` — folder-as-module resolves to `index.tsx`.

### 1.2 `src/core/task-store.ts` (1239)

Convert to `src/core/task-store/` folder:
- `index.ts` — `createTaskStore()` factory + public types; composes the modules below
- `enqueue.ts` — `enqueue` + queue-write helpers
- `claim.ts` — `claim` + worker-mutex
- `terminal.ts` — `markTaskTerminal`, done/failed/cancelled paths
- `child-state.ts` — child-state propagation logic
- `retry.ts` — retry/re-enqueue helpers (if not already in `find-input.ts`)

Each sub-module exports plain functions that take the SQLite handle (or whatever shared state the factory holds) as a parameter. The `index.ts` factory threads state into them. No module owns DB-handle lifecycle except `index.ts`.

### 1.3 `src/core/daemon.ts` (1051)

Extract neighbors (no folder yet — done in Phase 3 reorg):
- `src/core/daemon.ts` — keep `runWorkflowDaemon` main loop + queue claiming + in-flight tracking
- `src/core/daemon-http.ts` — `/cancel-current` HTTP server (`createServer`, listen, request handler)
- `src/core/daemon-keepalive.ts` — 15-minute idle `session.healthCheck` timer

`runWorkflowDaemon` calls `startDaemonHttpServer(...)` and `startKeepaliveTimer(...)` from the new files. The new files only export their start/stop functions — no shared mutable state lives in them.

### 1.4 `src/workflows/separations/workflow.ts` (912)

Convert to per-step files:
- `src/workflows/separations/workflow.ts` — `defineWorkflow(...)` + slim handler that calls into `steps/`
- `src/workflows/separations/steps/kuali-extract.ts`
- `src/workflows/separations/steps/kronos-search.ts`
- `src/workflows/separations/steps/ucpath-job-summary.ts`
- `src/workflows/separations/steps/ucpath-transaction.ts`
- `src/workflows/separations/steps/kuali-finalize.ts`
- `src/workflows/separations/cli.ts` — three CLI runner functions currently inlined in `workflow.ts`

Each step file exports an `async function (ctx, input, intermediateData) => result`. The handler in `workflow.ts` orchestrates via `ctx.step(...)` calls into these.

### 1.5 `src/core/workflow.ts` (889)

Extract:
- `src/core/run-one-item.ts` — the ~200-line `runOneItem` function (per audit)
- `src/core/workflow.ts` keeps `defineWorkflow`, `runWorkflow`, `runWorkflowBatch`, types

Already shrunk earlier via `batch-helpers.ts` extraction; this is the last sensible carve-out.

## Phase 2 — HTTP handler splits (integrate with existing hono routes)

Hono routes already live in `src/tracker/dashboard/hono/routes/`. The handler-builder factories in `dashboard-ops.ts` and `ocr-http.ts` are imported by those route files. We split the builders into a folder per origin file; route imports update to the new paths.

### 2.1 `src/tracker/dashboard-ops.ts` (1569)

Convert to `src/tracker/dashboard/ops/` folder:
- `index.ts` — re-exports the same public surface (every `buildXxxHandler` factory the hono route imports)
- `retry.ts` — `buildRetryHandler`, `buildRunWithDataHandler`, `reEnqueueEntry` (private helper)
- `cancel.ts` — `buildCancelQueuedHandler`, `buildCancelRunningHandler`, `buildForceStopHandler`, `buildKillBrowserHandler`
- `worker-control.ts` — drain/stop worker, daemon-info handlers
- `queue.ts` — queue-bump, find-input, save-data handlers
- `save-data.ts` — `buildSaveDataHandler` (if separable cleanly from `queue.ts`)

`src/tracker/dashboard/hono/routes/ops.ts` updates its imports to point at the new paths.

### 2.2 `src/tracker/ocr-http.ts` (1060)

Convert to `src/tracker/dashboard/ocr/` folder:
- `index.ts` — re-exports `buildOcrPrepareHandler`, `buildOcrApproveHandler`, `buildOcrDiscardHandler`, `buildOcrForceResearchHandler`, `buildOcrRetryPageHandler`, `buildOcrReocrWholePdfHandler`, `sweepStuckOcrRows`, `_resetSessionLockForTests`
- `prepare.ts` — `buildOcrPrepareHandler`
- `approve.ts` — `buildOcrApproveHandler`
- `discard.ts` — `buildOcrDiscardHandler`
- `force-research.ts` — `buildOcrForceResearchHandler`
- `retry-page.ts` — `buildOcrRetryPageHandler`
- `reocr-whole-pdf.ts` — `buildOcrReocrWholePdfHandler`
- `sweep.ts` — `sweepStuckOcrRows`
- `lock.ts` — per-sessionId in-memory lock + `_resetSessionLockForTests` (shared by approve/retry-page/reocr handlers)

`src/tracker/dashboard/hono/routes/ocr.ts` updates imports to the new paths.

## Phase 3 — Folder reorgs (broader import churn)

### 3.1 Move `src/auth/telegram-notify.ts` → `src/domain/notifications/telegram.ts`

Telegram is a notification channel, not auth. `src/domain/notifications/` does not yet exist; create it. Update every import path that references the old location (`grep` first to enumerate). Public symbol names unchanged.

### 3.2 Reorg `src/core/` into `src/core/kernel/` + `src/core/daemon/`

Current `src/core/` (after Phase 1.3 split = 28 files):

**Move to `src/core/kernel/`:**
- `workflow.ts`, `run-one-item.ts` (new), `pool.ts`, `session.ts`, `stepper.ts`, `ctx.ts`, `registry.ts`, `types.ts`, `screenshot.ts`, `shared-context-pool.ts`, `batch-helpers.ts`, `batch-lifecycle.ts`

**Move to `src/core/daemon/`:**
- `daemon.ts`, `daemon-http.ts` (new), `daemon-keepalive.ts` (new), `daemon-client.ts`, `daemon-queue.ts`, `daemon-registry.ts`, `daemon-types.ts`, `enqueue-dispatch.ts`, `worker-store.ts`, `in-process-runs.ts`

**Stay at `src/core/` root:**
- `index.ts` (barrel re-export — updates internals to point at subfolders)
- `task-store/` (folder from Phase 1.2 — its own concern, neither kernel nor daemon)
- `task-control.ts`, `task-display.ts` (task-related; either stay at root or join `task-store/`)
- `control-db.ts`, `control-schema.ts`, `find-input.ts` (control-DB layer; stay at root or new `core/control/` subfolder — decide during execution; default = stay at root)
- `workflow-loaders.ts` (workflow-name → module map; stays at root)

Imports across `src/` update wholesale. Strategy: do the file moves with `git mv`, then run a single mass find-and-replace for import paths, then `npm run typecheck` until clean.

The `src/core/index.ts` barrel keeps its existing public exports (`runWorkflow`, `defineWorkflow`, etc.); only its internal `import` lines change. External callers (`src/workflows/`, `src/auth/`, etc.) that currently `import { ... } from "../../core/index.js"` see no change.

## Verification

| When | Commands |
|---|---|
| Before each task | `npm run typecheck` (must already be green) |
| After each task | `npm run typecheck` — must pass |
| End of Phase 1 | `npm run typecheck && npm run test && npm run test:architecture` |
| End of Phase 2 | `npm run typecheck && npm run test && npm run test:architecture` |
| End of Phase 3 | `npm run typecheck:all && npm run test && npm run test:architecture && npm run build:dashboard` |
| Final smoke | Manual: `npm run dashboard` loads; `/api/workflows` returns; click through QueuePanel, LogPanel, CaptureModal once |

## Commit cadence

One commit per task. ~12 commits total. Prefix: `refactor(<subsystem>):`. Examples:
- `refactor(dashboard): split CaptureModal into folder of subcomponents`
- `refactor(core): split task-store into enqueue/claim/terminal/child-state files`
- `refactor(tracker): move dashboard-ops handlers into tracker/dashboard/ops/`
- `refactor(core): move daemon plumbing into core/daemon/, kernel into core/kernel/`

## Risks

1. **Phase 3 import churn breaks something invisible.** Mitigation: run `npm run typecheck:all` and `npm run test` before each Phase 3 commit; do moves in two commits (telegram first, core/ second) to bisect cleanly.
2. **Hono route + builder split must update atomically.** Mitigation: each Phase 2 split commit edits both the new `dashboard/ops/` (or `dashboard/ocr/`) files AND the corresponding `routes/ops.ts` (or `routes/ocr.ts`) import in the same commit.
3. **Daemon HTTP server extraction must preserve port/handler binding.** Mitigation: extract function signature `startDaemonHttpServer({ port, onCancelCurrent })` returning a `{ stop }` handle; daemon main loop calls and disposes via the existing teardown path.
4. **Folder-as-module resolution for `CaptureModal/index.tsx`.** Mitigation: TypeScript already resolves this (used elsewhere in repo, e.g. `src/dashboard/components/ocr/`); no tsconfig change needed.
5. **`task-store/` factory split could spread DB-handle lifecycle across modules.** Mitigation: only `index.ts` opens/closes the handle and binds it; sub-modules export pure functions taking the handle as parameter.
6. **Spreading any single change across more than ~30 files makes one commit hard to review.** Mitigation: Phase 3.2 is the worst offender — commit it separately; PR description points reviewers at `git log --stat` for that commit.

## Subagent dispatch structure (for writing-plans)

Each task = one Sonnet subagent dispatch. Tasks within a phase touching disjoint files are parallel-eligible; cross-phase ordering is strict.

**Phase 1 (parallel-eligible — 5 dispatches):**
- T1.1 CaptureModal split — touches only `src/dashboard/components/CaptureModal*`
- T1.2 task-store split — touches only `src/core/task-store*`
- T1.3 daemon split — touches `src/core/daemon.ts` + new neighbors
- T1.4 separations split — touches only `src/workflows/separations/*`
- T1.5 workflow.ts extract — touches `src/core/workflow.ts` + new `src/core/run-one-item.ts`

T1.3 and T1.5 both touch `src/core/`; safe in parallel because no file overlap. Run all 5 in parallel, then verify with full test suite.

**Phase 2 (sequential — 2 dispatches):**
- T2.1 dashboard-ops split — touches `src/tracker/dashboard-ops.ts` + new `src/tracker/dashboard/ops/` + `routes/ops.ts`
- T2.2 ocr-http split — touches `src/tracker/ocr-http.ts` + new `src/tracker/dashboard/ocr/` + `routes/ocr.ts`

Disjoint at the file level — safe in parallel. Conservative choice: run sequentially so test failures are easier to attribute. Default plan: parallel.

**Phase 3 (sequential — 2 dispatches):**
- T3.1 Move telegram-notify — small, ~10 import sites
- T3.2 core/{kernel,daemon} reorg — large, ~30+ import sites; must serialize after T3.1 because a clean typecheck baseline is required before kicking off the big move

Sequential within phase. Phase 3 starts only after Phase 1+2 land cleanly.

**Total: 9 task dispatches across 3 phases.**

## Final review

After all 9 tasks land cleanly: `codex:rescue` over the combined diff. Codex reports findings only; Opus orchestrator implements fixes (using subagents again if mechanical).
