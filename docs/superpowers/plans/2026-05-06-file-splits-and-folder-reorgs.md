# File Splits + Folder Reorgs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to dispatch each task as one Sonnet subagent. Tasks within a phase that touch disjoint files run in parallel (multiple Agent tool calls in one message). This is **refactor work, not TDD** — rhythm is `typecheck green → split → typecheck still green → commit`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split 8 oversized files (≥889 lines) into folders of cohesive pieces, and reorganize `src/core/` into `kernel/` + `daemon/` subfolders. Zero behavior change.

**Architecture:** Each oversized file becomes a folder with a barrel `index.ts` that re-exports the original public surface — external callers see no API change. HTTP handler factories in `tracker/` integrate with the existing hono routes at `src/tracker/dashboard/hono/routes/`. Folder reorgs (Phase 3) update import paths wholesale via `git mv` + find-and-replace.

**Tech Stack:** TypeScript (NodeNext), tsx, React (TSX), Hono, Vite, Vitest. Source design: `docs/superpowers/specs/2026-05-06-file-splits-design.md`.

---

## Global pre-conditions (verify before EVERY task)

Before dispatching any task, the orchestrator confirms:

- [ ] On `master`: `git rev-parse --abbrev-ref HEAD` → `master`
- [ ] Working tree clean *for files this task will touch* (other unrelated `M` files are okay): `git status --short`
- [ ] Typecheck currently green: `npm run typecheck`
- [ ] Unit tests currently green: `npm run test`

If any of those fail, **do not dispatch** — surface the failure to the user instead.

## Subagent dispatch defaults

Every task dispatch uses:

- **`subagent_type`**: `general-purpose` (full tool access; Sonnet by default per global CLAUDE.md)
- **`model`**: `sonnet`
- **No `isolation: "worktree"`** — work happens directly on `master`. The orchestrator commits between tasks.

## Universal task wrapper (every task does these)

Every per-task subagent prompt MUST end with this block, repeated verbatim:

```
Verification (must pass before commit):
1. Run `npm run typecheck` — output must end with "0 errors" (no TypeScript errors).
2. Run any unit-test files that import the affected modules (find with `grep -lR "from \"<old-path>\"" tests/` or similar). Must pass.
3. Show `git status --short` and `git diff --stat` so the result is auditable.

Commit:
- Use the exact commit message specified in the task.
- One commit per task.
- Do NOT amend prior commits.
- Do NOT push.

Out of scope (do NOT do):
- No behavior changes.
- No new features, helpers, or "while we're here" cleanup.
- No comment additions/removals beyond what the move strictly requires.
- No formatting changes (no Prettier/ESLint mass runs).
- No dependency updates.
- Do NOT touch any file outside the task's explicit Files: list.
```

---

## File structure (full inventory of changes)

### Phase 1 — Created files

```
src/dashboard/components/CaptureModal/
  index.tsx                  # parent component (was CaptureModal.tsx body)
  ModalChrome.tsx
  LeftColumn.tsx
  RightColumn.tsx
  ActionRow.tsx
  ExpiryFooter.tsx
  ValidationBanner.tsx

src/core/task-store/
  index.ts                   # createTaskStore() factory + public surface
  enqueue.ts
  claim.ts
  terminal.ts
  child-state.ts
  retry.ts                   # may be empty if retry stays in claim.ts — okay

src/core/daemon-http.ts      # /cancel-current HTTP server (extracted)
src/core/daemon-keepalive.ts # 15-min healthcheck timer (extracted)
src/core/run-one-item.ts     # extracted from workflow.ts

src/workflows/separations/steps/
  kuali-extract.ts
  kronos-search.ts
  ucpath-job-summary.ts
  ucpath-transaction.ts
  kuali-finalize.ts
src/workflows/separations/cli.ts  # 3 CLI runners extracted from workflow.ts
```

### Phase 1 — Deleted files

```
src/dashboard/components/CaptureModal.tsx   # replaced by CaptureModal/ folder
src/core/task-store.ts                       # replaced by task-store/ folder
```

### Phase 1 — Modified files (in place)

```
src/core/daemon.ts                            # imports from new daemon-http.ts + daemon-keepalive.ts
src/core/workflow.ts                          # imports runOneItem from new file
src/workflows/separations/workflow.ts         # slim handler delegating to steps/
src/workflows/separations/index.ts            # may need barrel update
src/core/index.ts                             # may need barrel update for task-store + run-one-item
```

### Phase 2 — Created files

```
src/tracker/dashboard/ops/
  index.ts                   # barrel re-exporting all builders
  retry.ts                   # buildRetryHandler, buildRunWithDataHandler, reEnqueueEntry
  cancel.ts                  # buildCancel*Handler family
  worker-control.ts          # drain/stop worker, daemon-info
  queue.ts                   # queue-bump, find-input, save-data
  # save-data.ts is OPTIONAL — collapse into queue.ts if not cleanly separable

src/tracker/dashboard/ocr/
  index.ts                   # barrel re-exporting all builders
  prepare.ts
  approve.ts
  discard.ts
  force-research.ts
  retry-page.ts
  reocr-whole-pdf.ts
  sweep.ts                   # sweepStuckOcrRows
  lock.ts                    # _resetSessionLockForTests + per-sessionId lock
```

### Phase 2 — Deleted files

```
src/tracker/dashboard-ops.ts   # replaced by tracker/dashboard/ops/
src/tracker/ocr-http.ts        # replaced by tracker/dashboard/ocr/
```

### Phase 2 — Modified files (import-path updates only)

```
src/tracker/dashboard/hono/routes/ops.ts    # imports from new dashboard/ops/
src/tracker/dashboard/hono/routes/ocr.ts    # imports from new dashboard/ocr/
src/tracker/index.ts                         # if it re-exported from old paths
src/tracker/dashboard.ts                     # may import from old paths
```

### Phase 3 — Created files / folders

```
src/domain/notifications/
  telegram.ts                # was src/auth/telegram-notify.ts

src/core/kernel/             # destination for kernel files
src/core/daemon/             # destination for daemon files
```

### Phase 3 — Moved files

```
src/auth/telegram-notify.ts   →  src/domain/notifications/telegram.ts

# Into src/core/kernel/:
src/core/workflow.ts
src/core/run-one-item.ts
src/core/pool.ts
src/core/session.ts
src/core/stepper.ts
src/core/ctx.ts
src/core/registry.ts
src/core/types.ts
src/core/screenshot.ts
src/core/shared-context-pool.ts
src/core/batch-helpers.ts
src/core/batch-lifecycle.ts

# Into src/core/daemon/:
src/core/daemon.ts
src/core/daemon-http.ts          (new from Phase 1.3)
src/core/daemon-keepalive.ts     (new from Phase 1.3)
src/core/daemon-client.ts
src/core/daemon-queue.ts
src/core/daemon-registry.ts
src/core/daemon-types.ts
src/core/enqueue-dispatch.ts
src/core/worker-store.ts
src/core/in-process-runs.ts

# Stays at src/core/ root:
src/core/index.ts
src/core/task-store/             (Phase 1 folder)
src/core/task-control.ts
src/core/task-display.ts
src/core/control-db.ts
src/core/control-schema.ts
src/core/find-input.ts
src/core/workflow-loaders.ts
```

### Phase 3 — Modified files (import-path updates)

Every TS/TSX file across `src/` and `tests/` that imports from any moved path. Estimated ~30+ files for the `core/` reorg, ~10 files for the telegram move. Use `git grep` to enumerate before each move.

---

## Phase 1 — In-place file splits (parallel-eligible)

**Parallelism:** Tasks 1.1, 1.2, 1.3, 1.4, 1.5 touch disjoint files. Dispatch all 5 in parallel (one message with five Agent tool calls).

**Phase gate (after all 5 land):**
```
npm run typecheck && npm run test && npm run test:architecture && npm run typecheck:all
```

All four must pass before starting Phase 2.

---

### Task 1.1: Split `src/dashboard/components/CaptureModal.tsx` (1158 lines)

**Files:**
- Read: `src/dashboard/components/CaptureModal.tsx`
- Create: `src/dashboard/components/CaptureModal/index.tsx`
- Create: `src/dashboard/components/CaptureModal/ModalChrome.tsx`
- Create: `src/dashboard/components/CaptureModal/LeftColumn.tsx`
- Create: `src/dashboard/components/CaptureModal/RightColumn.tsx`
- Create: `src/dashboard/components/CaptureModal/ActionRow.tsx`
- Create: `src/dashboard/components/CaptureModal/ExpiryFooter.tsx`
- Create: `src/dashboard/components/CaptureModal/ValidationBanner.tsx`
- Delete: `src/dashboard/components/CaptureModal.tsx`

- [ ] **Step 1: Read source file in full**

```bash
wc -l src/dashboard/components/CaptureModal.tsx
```

Read the whole file. Identify the named subcomponents (look for `function ModalChrome(`, `function LeftColumn(`, etc., or `const X = (props) => {...}`). The audit identified 11 named subcomponents — count what's actually there.

- [ ] **Step 2: Verify external import sites**

```bash
git grep -n "from .*CaptureModal" -- 'src/**/*.ts' 'src/**/*.tsx'
```

External callers should resolve via folder-as-module — they will continue to import `from "./CaptureModal"` or `from "../CaptureModal"` and TypeScript resolves it to `index.tsx` automatically. **No external import edits in this task.**

- [ ] **Step 3: Create subcomponent files**

For each named subcomponent identified in Step 1:
- Create `src/dashboard/components/CaptureModal/<Name>.tsx`.
- Move the `function <Name>(...)` (or `const <Name> = ...`) declaration into the new file.
- Preserve all type imports, prop types, helper functions used only by this subcomponent.
- Add `export function <Name>(...)` (or `export const <Name>`) so the parent can import it.
- Re-create any imports the subcomponent needs (React, shared types, sibling components).

If a subcomponent uses a helper function/constant defined elsewhere in the original file:
- If the helper is used by **multiple** subcomponents → leave it in `index.tsx` and have subcomponents import it from `"./index.js"` or extract to a `state.ts`/`utils.ts` (default: leave in index unless cleaner).
- If the helper is used by **one** subcomponent → move the helper to that subcomponent's file.

- [ ] **Step 4: Create `index.tsx` with parent component**

`src/dashboard/components/CaptureModal/index.tsx` contains:
- All imports the original file had at the top
- The top-level `export function CaptureModal(...)` (the parent component) — same body as before, but render JSX delegates to the imported subcomponents
- `import { ModalChrome } from "./ModalChrome.js"` etc. for each subcomponent
- Any prop type / interface declarations that the parent and subcomponents share (or move them to a `types.ts` if cleaner)

- [ ] **Step 5: Delete the original file**

```bash
git rm src/dashboard/components/CaptureModal.tsx
```

- [ ] **Step 6: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. If it fails, the most likely cause is a missing import in one of the new subcomponent files — re-add the import from the source file.

- [ ] **Step 7: Verify unit tests**

```bash
npm run test -- CaptureModal
```

Any existing `CaptureModal.test.tsx` should still pass (the parent component's public API didn't change).

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/components/CaptureModal/ src/dashboard/components/CaptureModal.tsx
git commit -m "refactor(dashboard): split CaptureModal into folder of subcomponents"
```

(`git add` of the deleted file path picks up the deletion.)

---

### Task 1.2: Split `src/core/task-store.ts` (1239 lines)

**Files:**
- Read: `src/core/task-store.ts`
- Create: `src/core/task-store/index.ts`
- Create: `src/core/task-store/enqueue.ts`
- Create: `src/core/task-store/claim.ts`
- Create: `src/core/task-store/terminal.ts`
- Create: `src/core/task-store/child-state.ts`
- Create: `src/core/task-store/retry.ts` (may be omitted if retry logic fits cleanly into claim.ts)
- Delete: `src/core/task-store.ts`
- Possibly modify: `src/core/index.ts` (if it re-exports from task-store directly)

- [ ] **Step 1: Read source file in full and inventory**

```bash
wc -l src/core/task-store.ts
```

Read the whole file. The file exports `createTaskStore(...)` — a factory that returns an object with ~20 methods. Inventory each method into one of these buckets:

| Bucket | New file | Method names (typical) |
|---|---|---|
| Enqueue | `enqueue.ts` | `enqueue`, `enqueueChildren`, related queue-write helpers |
| Claim | `claim.ts` | `claim`, `releaseClaim`, worker-mutex helpers |
| Terminal | `terminal.ts` | `markTaskTerminal`, `markDone`, `markFailed`, `markCancelled` |
| Child state | `child-state.ts` | child-state propagation (whatever method names appear) |
| Retry | `retry.ts` (optional) | `retryTask` or similar |

If a method's bucket is unclear, leave it in `index.ts`. The goal is moving the obvious ~80% — anything ambiguous stays in `index.ts`.

- [ ] **Step 2: Verify external import sites**

```bash
git grep -n "from .*core/task-store" -- 'src/**/*.ts' 'tests/**/*.ts'
```

External callers import from `"../core/task-store.js"` (or similar). Folder-as-module will resolve `task-store/` to `task-store/index.ts` automatically. **No external import edits.**

- [ ] **Step 3: Decide handle-passing convention**

The factory holds shared state (DB handle, internal maps, etc.). Sub-modules cannot close over factory-local variables. Pattern: each sub-module exports plain functions whose first parameter is the shared state.

Example:
```ts
// enqueue.ts
import type { Database } from "better-sqlite3";
export function enqueue(db: Database, /* other params */) {
  // body moved from createTaskStore
}
```

`index.ts` opens the DB handle, then binds each sub-module function with the handle:
```ts
// index.ts
import { enqueue as enqueueImpl } from "./enqueue.js";
export function createTaskStore(opts) {
  const db = /* open DB */;
  return {
    enqueue: (args) => enqueueImpl(db, args),
    // ...
  };
}
```

If the original methods close over multiple internal helpers (not just the DB), pass an internal `state` object instead of individual handles:
```ts
type TaskStoreState = { db: Database; locks: Map<string, ...>; /* etc */ };
export function enqueue(state: TaskStoreState, ...) { ... }
```

Choose whichever is mechanically cleaner; do not introduce new abstractions.

- [ ] **Step 4: Create sub-module files**

For each bucket, create the new file. Move the method bodies verbatim. Adjust each method to take `state` (or `db`) as its first parameter. Import any types used by that method.

- [ ] **Step 5: Create `index.ts`**

`src/core/task-store/index.ts`:
- All top-level imports the original file had
- All type/interface exports the original file had (preserved verbatim — public surface)
- The `createTaskStore(opts)` factory: opens internal state, then composes the sub-module functions into the returned object
- Any methods that did NOT cleanly bucket (kept inline)

- [ ] **Step 6: Delete original file**

```bash
git rm src/core/task-store.ts
```

- [ ] **Step 7: Update `src/core/index.ts` barrel** (only if it currently re-exports from `task-store`)

```bash
grep -n "task-store" src/core/index.ts
```

If the barrel had `export * from "./task-store.js"`, change to `export * from "./task-store/index.js"`. (NodeNext resolves `"./task-store.js"` to the folder's `index.js` automatically, so the import may not need editing — verify with typecheck.)

- [ ] **Step 8: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. If it fails, common cause: a sub-module function is missing a parameter type, or `index.ts` has a type-mismatch in how it composes the bound functions.

- [ ] **Step 9: Verify unit tests**

```bash
npm run test -- task-store
```

If there are tests for `createTaskStore`, they should pass unchanged.

- [ ] **Step 10: Commit**

```bash
git add src/core/task-store/ src/core/task-store.ts src/core/index.ts
git commit -m "refactor(core): split task-store into enqueue/claim/terminal/child-state files"
```

---

### Task 1.3: Extract `daemon-http` and `daemon-keepalive` from `src/core/daemon.ts` (1051 lines)

**Files:**
- Read: `src/core/daemon.ts`
- Create: `src/core/daemon-http.ts`
- Create: `src/core/daemon-keepalive.ts`
- Modify: `src/core/daemon.ts` (slimmer)

- [ ] **Step 1: Read source file in full**

```bash
wc -l src/core/daemon.ts
```

Read the whole file. Identify three regions:

1. **HTTP `/cancel-current` server.** Look for `createServer(`, listening on a port, request handler with `req.url === "/cancel-current"` (or similar). Includes the listen + close lifecycle.
2. **Keepalive timer.** Look for `setInterval` (or recursive `setTimeout`) calling `session.healthCheck(...)` every 15 minutes (`15 * 60 * 1000`).
3. **Main daemon loop.** `runWorkflowDaemon` — claims items from queue, processes them, tracks in-flight, etc. Stays in `daemon.ts`.

- [ ] **Step 2: Create `src/core/daemon-http.ts`**

Export a single function:
```ts
export interface DaemonHttpOpts {
  port: number;
  onCancelCurrent: () => void | Promise<void>;
  // any other parameters the original code passed in
}
export interface DaemonHttpHandle {
  stop(): Promise<void>;
}
export function startDaemonHttpServer(opts: DaemonHttpOpts): DaemonHttpHandle {
  // body moved from daemon.ts
}
```

Move:
- The `createServer(...)` call
- The request-handler function
- The `listen(...)` call
- Any helpers used only by the HTTP server
- Imports `node:http` (or whatever the original used)

The `stop()` method calls `server.close()` (or whatever cleanup the original lifecycle did).

- [ ] **Step 3: Create `src/core/daemon-keepalive.ts`**

Export a start function:
```ts
export interface KeepaliveOpts {
  session: import("./session.js").Session;
  systems: string[]; // or whatever the original iteration source was
  intervalMs?: number; // default 15 * 60 * 1000
}
export interface KeepaliveHandle {
  stop(): void;
}
export function startKeepaliveTimer(opts: KeepaliveOpts): KeepaliveHandle {
  const interval = setInterval(/* original body */, opts.intervalMs ?? 15 * 60 * 1000);
  return { stop: () => clearInterval(interval) };
}
```

Adjust signature to match what the original code actually needs. Move only the timer setup — call sites stay in `daemon.ts`.

- [ ] **Step 4: Update `src/core/daemon.ts`**

In `runWorkflowDaemon`:
- Replace inline `createServer` block with `const httpHandle = startDaemonHttpServer({ port, onCancelCurrent: ... })`.
- Replace inline `setInterval` block with `const keepaliveHandle = startKeepaliveTimer({ session, systems })`.
- In the daemon's existing teardown path (likely on SIGINT or graceful shutdown), call `httpHandle.stop()` and `keepaliveHandle.stop()` instead of the inline cleanup.

Add imports at the top:
```ts
import { startDaemonHttpServer } from "./daemon-http.js";
import { startKeepaliveTimer } from "./daemon-keepalive.js";
```

Remove now-unused imports from `daemon.ts` (e.g. `node:http` if nothing else uses it).

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. If it fails, common causes: missing parameter on the new `startDaemonHttpServer` opts shape, or the daemon's teardown path expected a return shape that the new handle doesn't expose.

- [ ] **Step 6: Verify unit tests**

```bash
npm run test -- daemon
```

If there are tests around the daemon's HTTP cancel endpoint or keepalive, they should pass unchanged (behavior is preserved).

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon.ts src/core/daemon-http.ts src/core/daemon-keepalive.ts
git commit -m "refactor(core): extract daemon-http and daemon-keepalive from daemon.ts"
```

---

### Task 1.4: Split `src/workflows/separations/workflow.ts` (912 lines)

**Files:**
- Read: `src/workflows/separations/workflow.ts`
- Create: `src/workflows/separations/steps/kuali-extract.ts`
- Create: `src/workflows/separations/steps/kronos-search.ts`
- Create: `src/workflows/separations/steps/ucpath-job-summary.ts`
- Create: `src/workflows/separations/steps/ucpath-transaction.ts`
- Create: `src/workflows/separations/steps/kuali-finalize.ts`
- Create: `src/workflows/separations/cli.ts`
- Modify: `src/workflows/separations/workflow.ts` (slimmer; orchestrates via `ctx.step` calls)

- [ ] **Step 1: Read source file in full**

```bash
wc -l src/workflows/separations/workflow.ts
```

Identify:
- The `defineWorkflow({...})` call (kept in `workflow.ts`).
- The `handler: async (ctx, input) => {...}` body — contains `ctx.step("kuali-extraction", ...)`, `ctx.step("kronos-search", ...)`, etc. Each step body is moved to its own file under `steps/`.
- The 3 CLI runner functions (likely `runSeparation`, `runSeparationBatch`, `runSeparationSingle` or similar — find by `export async function run...`). Move all 3 to `cli.ts`.

- [ ] **Step 2: Verify external imports of the CLI runners**

```bash
git grep -n "from .*workflows/separations" -- 'src/**/*.ts'
```

CLI imports from `src/cli.ts` and `src/cli-daemon.ts` will need to update if they import the runners directly from `workflow.ts` (vs. from a barrel `index.ts`).

- [ ] **Step 3: Create one file per step**

For each `ctx.step("<name>", async () => { /* body */ })` call in the handler:
- Create `src/workflows/separations/steps/<kebab-name>.ts`.
- Export an `async` function:
  ```ts
  import type { Ctx } from "../../../core/types.js";
  import type { SeparationData } from "../schema.js";
  export async function runKualiExtract(ctx: Ctx<SeparationData, ...>, input: SeparationInput): Promise<...> {
    // body moved from inline ctx.step callback
  }
  ```
  Use whatever ctx/input type the original handler had. Return type matches what the inline body returned (often `void` or an intermediate-data object).
- Move any helper functions used only by this step into the same file.
- Move imports the step needs.

The 5 expected step files (verify against actual `ctx.step` calls):
1. `kuali-extract.ts`
2. `kronos-search.ts`
3. `ucpath-job-summary.ts`
4. `ucpath-transaction.ts`
5. `kuali-finalize.ts`

If actual step names in the handler differ, name the files to match the step names verbatim (kebab-case).

- [ ] **Step 4: Create `cli.ts`**

`src/workflows/separations/cli.ts`:
- Move all CLI runner functions verbatim (`runSeparation`, `runSeparationBatch`, etc.)
- Re-create their imports
- Export each one with the same name

- [ ] **Step 5: Slim `workflow.ts`**

`src/workflows/separations/workflow.ts` becomes:
- All top-level imports the original had, PLUS imports of each step function from `./steps/<name>.js` and re-exports of the CLI runners from `./cli.js`
- The `defineWorkflow({...})` call
- A slim `handler` that calls into the imported step functions:
  ```ts
  handler: async (ctx, input) => {
    // any pre-step setup that stays in workflow.ts
    const extracted = await ctx.step("kuali-extraction", () => runKualiExtract(ctx, input));
    const kronos = await ctx.step("kronos-search", () => runKronosSearch(ctx, input, extracted));
    // ... etc
  },
  ```
- Re-export CLI runners so existing import sites (`src/cli.ts`, `src/cli-daemon.ts`) continue to work:
  ```ts
  export { runSeparation, runSeparationBatch } from "./cli.js";
  ```

- [ ] **Step 6: Update barrel `index.ts`** if it exists

```bash
cat src/workflows/separations/index.ts 2>/dev/null
```

If `index.ts` exists and re-exports from `workflow.ts`, leave it alone — `workflow.ts` still re-exports the CLI runners.

- [ ] **Step 7: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. Common failure: a step function captures a closure variable from the original handler scope. Fix: pass that variable as an explicit parameter.

- [ ] **Step 8: Verify unit + architecture tests**

```bash
npm run test -- separations
npm run test:architecture
```

Architecture tests may flag if step files use inline `page.locator(...)` selectors — they shouldn't, since selectors moved earlier; but verify.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/separations/
git commit -m "refactor(separations): split workflow.ts into per-step files + cli.ts"
```

---

### Task 1.5: Extract `runOneItem` from `src/core/workflow.ts` (889 lines)

**Files:**
- Read: `src/core/workflow.ts`
- Create: `src/core/run-one-item.ts`
- Modify: `src/core/workflow.ts` (smaller)

- [ ] **Step 1: Read source file**

```bash
wc -l src/core/workflow.ts
```

Identify the `runOneItem` function (or whatever name it has — search for the ~200-line function called by both `runWorkflow` and `runWorkflowBatch`/`runWorkflowPool`). Per CLAUDE.md note: it lives in `workflow.ts` around line 164.

```bash
grep -n "function runOneItem\|const runOneItem" src/core/workflow.ts
```

If the function is named differently, use its actual name throughout this task.

- [ ] **Step 2: Inventory dependencies**

What does `runOneItem` need from `workflow.ts`?
- Types (`WorkflowConfig`, `Ctx`, `RunOpts`, etc.) — these likely come from `./types.js`, so importing them from `run-one-item.ts` is straightforward.
- Helpers (`makeCtx`, `withTrackedWorkflow`, etc.) — these come from sibling files (`./ctx.js`, `../tracker/jsonl.js`, etc.). Re-import in the new file.
- Module-private helpers in `workflow.ts` — if `runOneItem` calls a function defined nearby in `workflow.ts`, decide:
  - If used **only** by `runOneItem` → move it too.
  - If used by other functions in `workflow.ts` → leave in `workflow.ts` and have `run-one-item.ts` import it from `./workflow.js` (creates a small circular-export that NodeNext handles fine, but cleaner: extract the shared helper to `./types.js` or a new `./helpers.js` only if mechanically obvious).

- [ ] **Step 3: Create `src/core/run-one-item.ts`**

```ts
// imports of types and helpers identified in Step 2
import type { ... } from "./types.js";
import { makeCtx } from "./ctx.js";
// etc.

export async function runOneItem(...) {
  // body verbatim from workflow.ts
}
```

If `runOneItem` is exported from `workflow.ts` for tests, ensure the new file exports it too.

- [ ] **Step 4: Update `src/core/workflow.ts`**

- Delete the `runOneItem` function body.
- Add `import { runOneItem } from "./run-one-item.js";` at the top.
- If `runOneItem` was exported from `workflow.ts`, add `export { runOneItem } from "./run-one-item.js";` to keep the public surface stable (some test or caller may import it from `workflow.js`).

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. If `runOneItem` referenced a `workflow.ts`-private helper that wasn't moved, decide per Step 2 (move helper or import from `./workflow.js`).

- [ ] **Step 6: Verify unit tests**

```bash
npm run test -- core
```

- [ ] **Step 7: Commit**

```bash
git add src/core/workflow.ts src/core/run-one-item.ts
git commit -m "refactor(core): extract runOneItem from workflow.ts"
```

---

### Phase 1 verification gate (orchestrator runs after all 5 tasks land)

```bash
npm run typecheck
npm run typecheck:all
npm run test
npm run test:architecture
```

All four must report success. If any fails, do NOT proceed to Phase 2 — surface to the user.

---

## Phase 2 — HTTP handler splits (parallel-eligible)

**Parallelism:** Tasks 2.1 and 2.2 touch disjoint files. Dispatch both in parallel.

**Phase gate (after both land):** same four commands as Phase 1.

---

### Task 2.1: Split `src/tracker/dashboard-ops.ts` (1569 lines)

**Files:**
- Read: `src/tracker/dashboard-ops.ts`
- Create: `src/tracker/dashboard/ops/index.ts`
- Create: `src/tracker/dashboard/ops/retry.ts`
- Create: `src/tracker/dashboard/ops/cancel.ts`
- Create: `src/tracker/dashboard/ops/worker-control.ts`
- Create: `src/tracker/dashboard/ops/queue.ts`
- (Optional) Create: `src/tracker/dashboard/ops/save-data.ts` — only if `buildSaveDataHandler` is large enough to merit its own file; otherwise inline in `queue.ts`
- Delete: `src/tracker/dashboard-ops.ts`
- Modify: `src/tracker/dashboard/hono/routes/ops.ts` (import paths)
- Possibly modify: `src/tracker/index.ts`, `src/tracker/dashboard.ts` (if they re-export from old path)

- [ ] **Step 1: Read source file and inventory builders**

```bash
wc -l src/tracker/dashboard-ops.ts
grep -n "^export function build\|^export async function build" src/tracker/dashboard-ops.ts
```

You should find ~25+ `buildXxxHandler` functions. Bucket them:

| Bucket | New file | Builder names (typical — verify in code) |
|---|---|---|
| Retry | `retry.ts` | `buildRetryHandler`, `buildRunWithDataHandler`, plus the private `reEnqueueEntry` helper |
| Cancel | `cancel.ts` | `buildCancelQueuedHandler`, `buildCancelRunningHandler`, `buildForceStopHandler`, `buildKillBrowserHandler` |
| Worker control | `worker-control.ts` | drain/stop worker handlers, `buildDaemonInfoHandler` |
| Queue + data | `queue.ts` | `buildQueueBumpHandler`, `buildFindInputHandler`, `buildSaveDataHandler` |

If a builder doesn't fit clearly, leave it in `index.ts`.

- [ ] **Step 2: Find current import sites**

```bash
git grep -n "from .*tracker/dashboard-ops" -- 'src/**/*.ts'
```

Expected results:
- `src/tracker/dashboard/hono/routes/ops.ts` — primary consumer
- Possibly `src/tracker/index.ts` if it re-exports
- Possibly `src/tracker/dashboard.ts` for backwards-compat re-exports

Each of these gets one import-path edit.

- [ ] **Step 3: Create per-bucket files**

For each bucket file:
- Move the builder functions verbatim
- Move any private helpers used only by these builders (e.g. `reEnqueueEntry` lives with `retry.ts`)
- Import shared types and shared helpers (`findLatestEntryData`, etc.) from their existing modules
- Export each builder with the same name as before

- [ ] **Step 4: Create `index.ts` barrel**

`src/tracker/dashboard/ops/index.ts`:
```ts
export * from "./retry.js";
export * from "./cancel.js";
export * from "./worker-control.js";
export * from "./queue.js";
// also re-export anything that stayed inline
```

This preserves the original public surface — every `buildXxxHandler` name is still importable from `src/tracker/dashboard/ops`.

- [ ] **Step 5: Update `src/tracker/dashboard/hono/routes/ops.ts`**

Change every import from `"../../../dashboard-ops.js"` (or `"../../dashboard-ops.js"`) to `"../../ops/index.js"` (relative path will differ — use VSCode's auto-import or hand-compute from `src/tracker/dashboard/hono/routes/ops.ts` to `src/tracker/dashboard/ops/index.ts`).

- [ ] **Step 6: Update other importers**

For each other file from Step 2, swap the import from `dashboard-ops.js` to `dashboard/ops/index.js`. (NodeNext may resolve `dashboard/ops.js` automatically when there's an `index.ts` — try the shortest path first; verify with typecheck.)

- [ ] **Step 7: Delete original file**

```bash
git rm src/tracker/dashboard-ops.ts
```

- [ ] **Step 8: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. Most likely failure: an importer not updated in Step 6 — re-run the `git grep` and fix.

- [ ] **Step 9: Verify unit tests**

```bash
npm run test -- dashboard
npm run test -- ops
```

- [ ] **Step 10: Commit**

```bash
git add src/tracker/dashboard/ops/ src/tracker/dashboard-ops.ts src/tracker/dashboard/hono/routes/ops.ts src/tracker/index.ts src/tracker/dashboard.ts
git commit -m "refactor(tracker): split dashboard-ops.ts into per-concern files under tracker/dashboard/ops/"
```

---

### Task 2.2: Split `src/tracker/ocr-http.ts` (1060 lines)

**Files:**
- Read: `src/tracker/ocr-http.ts`
- Create: `src/tracker/dashboard/ocr/index.ts`
- Create: `src/tracker/dashboard/ocr/prepare.ts`
- Create: `src/tracker/dashboard/ocr/approve.ts`
- Create: `src/tracker/dashboard/ocr/discard.ts`
- Create: `src/tracker/dashboard/ocr/force-research.ts`
- Create: `src/tracker/dashboard/ocr/retry-page.ts`
- Create: `src/tracker/dashboard/ocr/reocr-whole-pdf.ts`
- Create: `src/tracker/dashboard/ocr/sweep.ts`
- Create: `src/tracker/dashboard/ocr/lock.ts`
- Delete: `src/tracker/ocr-http.ts`
- Modify: `src/tracker/dashboard/hono/routes/ocr.ts` (import paths)
- Possibly modify: `src/tracker/index.ts`, `src/tracker/dashboard.ts`

- [ ] **Step 1: Read source file and inventory exports**

```bash
wc -l src/tracker/ocr-http.ts
grep -n "^export " src/tracker/ocr-http.ts
```

Per `src/tracker/CLAUDE.md`, the file exports:
- `buildOcrPrepareHandler`
- `buildOcrApproveHandler`
- `buildOcrDiscardHandler`
- `buildOcrForceResearchHandler`
- `buildOcrFormsHandler` (verify — may exist or may be elsewhere)
- `sweepStuckOcrRows`
- `_resetSessionLockForTests`

Plus possibly `buildOcrRetryPageHandler` and `buildOcrReocrWholePdfHandler` (per the per-page-retry feature shipped 2026-05-01).

Identify the per-sessionId in-memory lock — it's shared by approve/retry-page/reocr handlers. Goes in `lock.ts`.

- [ ] **Step 2: Find current import sites**

```bash
git grep -n "from .*tracker/ocr-http" -- 'src/**/*.ts' 'tests/**/*.ts'
```

- [ ] **Step 3: Create `lock.ts` first** (other files depend on it)

`src/tracker/dashboard/ocr/lock.ts`:
- Move the `Map<string, ...>` lock declaration
- Move helper functions that acquire/release the lock
- Export `_resetSessionLockForTests` for tests
- Export the lock-acquire and lock-release functions other handlers need

- [ ] **Step 4: Create one file per handler**

For each `buildOcr*Handler` and for `sweepStuckOcrRows`:
- Create the corresponding file under `src/tracker/dashboard/ocr/`
- Move the handler builder verbatim
- Import the lock helpers from `./lock.js` if needed
- Re-create all other imports

- [ ] **Step 5: Create `index.ts` barrel**

```ts
export * from "./prepare.js";
export * from "./approve.js";
export * from "./discard.js";
export * from "./force-research.js";
export * from "./retry-page.js";
export * from "./reocr-whole-pdf.js";
export * from "./sweep.js";
export { _resetSessionLockForTests } from "./lock.js";
```

- [ ] **Step 6: Update importers**

Update `src/tracker/dashboard/hono/routes/ocr.ts` and any other importer found in Step 2 to import from `src/tracker/dashboard/ocr/index.js`.

- [ ] **Step 7: Delete original file**

```bash
git rm src/tracker/ocr-http.ts
```

- [ ] **Step 8: Verify typecheck**

```bash
npm run typecheck
```

- [ ] **Step 9: Verify unit tests**

```bash
npm run test -- ocr
```

The OCR HTTP tests may exercise `_resetSessionLockForTests` between tests — confirm they still pass.

- [ ] **Step 10: Commit**

```bash
git add src/tracker/dashboard/ocr/ src/tracker/ocr-http.ts src/tracker/dashboard/hono/routes/ocr.ts
git commit -m "refactor(tracker): split ocr-http.ts into per-handler files under tracker/dashboard/ocr/"
```

---

### Phase 2 verification gate

```bash
npm run typecheck && npm run typecheck:all && npm run test && npm run test:architecture
```

All four must pass before starting Phase 3.

---

## Phase 3 — Folder reorgs (sequential)

**Parallelism:** Sequential. Task 3.1 must land cleanly before Task 3.2 starts (clean baseline for the larger move).

---

### Task 3.1: Move `src/auth/telegram-notify.ts` → `src/domain/notifications/telegram.ts`

**Files:**
- Move: `src/auth/telegram-notify.ts` → `src/domain/notifications/telegram.ts`
- Modify: every import site found by `git grep`

- [ ] **Step 1: Confirm destination folder doesn't exist (or does, partially)**

```bash
ls src/domain/notifications/ 2>/dev/null
ls src/domain/ 2>/dev/null
```

`src/domain/` likely exists already (per CLAUDE.md mentions of `src/domain/identity/`, etc.). Create `src/domain/notifications/` directory if absent.

- [ ] **Step 2: Find every import site**

```bash
git grep -n "auth/telegram-notify" -- 'src/**/*.ts' 'tests/**/*.ts'
```

Record all results — each line needs an import-path update.

- [ ] **Step 3: Move the file with `git mv`**

```bash
mkdir -p src/domain/notifications
git mv src/auth/telegram-notify.ts src/domain/notifications/telegram.ts
```

- [ ] **Step 4: Update every import site from Step 2**

For each result, change:
```
from "../auth/telegram-notify.js"
```
to (relative path will vary):
```
from "../domain/notifications/telegram.js"
```

Use search-and-replace per file rather than a global replace, so relative depths stay correct.

- [ ] **Step 5: Update `src/auth/index.ts`** if it re-exported the move

```bash
grep -n "telegram-notify" src/auth/index.ts 2>/dev/null
```

If `src/auth/index.ts` re-exports `telegram-notify`, remove that re-export (Telegram is no longer in `auth/`).

- [ ] **Step 6: Verify typecheck**

```bash
npm run typecheck
```

Expected: `0 errors`. If imports broke, the most likely culprit is a relative-path miscalculation — recompute from the new location.

- [ ] **Step 7: Verify unit tests**

```bash
npm run test
```

Run the full suite — telegram-notify is small but may be tested via integration paths.

- [ ] **Step 8: Commit**

```bash
git add src/domain/notifications/ src/auth/telegram-notify.ts src/auth/index.ts $(git grep -l "domain/notifications/telegram")
git commit -m "refactor(domain): move telegram-notify from auth/ to domain/notifications/"
```

---

### Task 3.2: Reorg `src/core/` into `src/core/kernel/` + `src/core/daemon/`

**This is the highest-blast-radius task in the plan. ~30+ import sites updated.**

**Files:**
- Move 12 files into `src/core/kernel/`
- Move 10 files into `src/core/daemon/`
- Update `src/core/index.ts` (internal imports only)
- Update every import site across `src/` and `tests/` that points at moved paths

- [ ] **Step 1: Verify clean baseline**

```bash
npm run typecheck
git status --short
```

Typecheck must be green and no stray uncommitted files. If anything is dirty, surface and stop.

- [ ] **Step 2: Enumerate import sites for every file about to move**

```bash
for f in workflow run-one-item pool session stepper ctx registry types screenshot shared-context-pool batch-helpers batch-lifecycle daemon daemon-http daemon-keepalive daemon-client daemon-queue daemon-registry daemon-types enqueue-dispatch worker-store in-process-runs; do
  echo "=== $f ==="
  git grep -l "core/$f" -- 'src/**/*.ts' 'tests/**/*.ts' 2>/dev/null
done
```

Save the full list — every file mentioned will need import-path updates.

- [ ] **Step 3: Create destination folders**

```bash
mkdir -p src/core/kernel src/core/daemon
```

- [ ] **Step 4: Move kernel files**

```bash
git mv src/core/workflow.ts        src/core/kernel/workflow.ts
git mv src/core/run-one-item.ts    src/core/kernel/run-one-item.ts
git mv src/core/pool.ts            src/core/kernel/pool.ts
git mv src/core/session.ts         src/core/kernel/session.ts
git mv src/core/stepper.ts         src/core/kernel/stepper.ts
git mv src/core/ctx.ts             src/core/kernel/ctx.ts
git mv src/core/registry.ts        src/core/kernel/registry.ts
git mv src/core/types.ts           src/core/kernel/types.ts
git mv src/core/screenshot.ts      src/core/kernel/screenshot.ts
git mv src/core/shared-context-pool.ts src/core/kernel/shared-context-pool.ts
git mv src/core/batch-helpers.ts   src/core/kernel/batch-helpers.ts
git mv src/core/batch-lifecycle.ts src/core/kernel/batch-lifecycle.ts
```

- [ ] **Step 5: Move daemon files**

```bash
git mv src/core/daemon.ts            src/core/daemon/daemon.ts
git mv src/core/daemon-http.ts       src/core/daemon/http.ts
git mv src/core/daemon-keepalive.ts  src/core/daemon/keepalive.ts
git mv src/core/daemon-client.ts     src/core/daemon/client.ts
git mv src/core/daemon-queue.ts      src/core/daemon/queue.ts
git mv src/core/daemon-registry.ts   src/core/daemon/registry.ts
git mv src/core/daemon-types.ts      src/core/daemon/types.ts
git mv src/core/enqueue-dispatch.ts  src/core/daemon/enqueue-dispatch.ts
git mv src/core/worker-store.ts      src/core/daemon/worker-store.ts
git mv src/core/in-process-runs.ts   src/core/daemon/in-process-runs.ts
```

(Daemon files: also strip the `daemon-` prefix on rename — they live under `daemon/` now, so `daemon-http.ts` becomes `http.ts`, etc. The original `daemon.ts` stays as `daemon.ts` since it's the main file.)

- [ ] **Step 6: Update sibling imports inside the moved files**

After the moves, files inside `kernel/` and `daemon/` have broken imports for sibling files (e.g. `kernel/workflow.ts` imports `./types.js` — which still works because `types.ts` moved to `kernel/` too — but it may import `../tracker/jsonl.js` which now needs `../../tracker/jsonl.js` because depth changed).

For each moved file, update its imports:
- Sibling imports (`./other-kernel-file.js`) — STILL CORRECT, no change.
- Cross-folder imports (`../../tracker/...`, `../../utils/...`, etc.) — depth increased by 1, so `..` must become `../..`, `../..` must become `../../..`, etc.
- Imports of files that **moved within `core/`** but to a different sibling (e.g. `kernel/workflow.ts` imports `daemon/queue.ts`) — change relative path accordingly.

Cross-folder examples (inside `kernel/workflow.ts`):
```ts
// before:    import { X } from "../tracker/jsonl.js";
// after:     import { X } from "../../tracker/jsonl.js";

// before:    import { X } from "./daemon-queue.js";
// after:     import { X } from "../daemon/queue.js";
```

Approach: run `npm run typecheck` and fix each error in order. Don't try to do all 22 files in one pass — let the compiler tell you what's broken.

- [ ] **Step 7: Update external import sites**

For every file from Step 2's enumeration (outside `src/core/`), update import paths. Examples:

```ts
// before
import { runWorkflow } from "../../core/workflow.js";
// after
import { runWorkflow } from "../../core/kernel/workflow.js";

// before
import { spawnDaemon } from "../core/daemon-client.js";
// after
import { spawnDaemon } from "../core/daemon/client.js";  // also note prefix drop
```

Note daemon files lost their `daemon-` prefix when moved (`daemon-http.ts` → `daemon/http.ts`, etc., but `daemon.ts` stays `daemon.ts`).

- [ ] **Step 8: Update `src/core/index.ts` barrel**

The barrel re-exports symbols from kernel/daemon files. Update its internal imports:
```ts
// before
export * from "./workflow.js";
// after
export * from "./kernel/workflow.js";

// before
export { spawnDaemon } from "./daemon-client.js";
// after
export { spawnDaemon } from "./daemon/client.js";
```

External callers of `src/core/index.js` see no change — public surface is preserved.

- [ ] **Step 9: Verify typecheck**

```bash
npm run typecheck
```

Iterate fixes until `0 errors`. This step may take multiple passes — expected.

- [ ] **Step 10: Verify typecheck-all and tests**

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

`typecheck:all` covers tests/. The architecture test may have rules tied to `src/core/` paths — if it fails, read the failure and update either the test or the directory layout (prefer updating the test if the failure is just a path-pattern mismatch).

- [ ] **Step 11: Verify dashboard build**

```bash
npm run build:dashboard
```

The frontend uses Vite which has its own module-resolution; this catches any cross-bundle import-path issues.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(core): split into kernel/ and daemon/ subfolders

Move 12 kernel files into src/core/kernel/ and 10 daemon files into
src/core/daemon/. Daemon files lose their daemon- prefix (now under
daemon/). External import sites updated wholesale. src/core/index.ts
barrel preserves public surface — no API change."
```

(Multi-line commit message because this is the largest commit and reviewers benefit from the context.)

---

### Phase 3 verification gate

```bash
npm run typecheck
npm run typecheck:all
npm run test
npm run test:architecture
npm run build:dashboard
```

All five must pass.

---

## Final review (after all phases land)

The orchestrator runs `codex:rescue` over the combined diff against `master` HEAD-from-before-the-refactor (use `git log --oneline` to find the pre-refactor SHA — likely the commit before `ecb95f1`).

```bash
# orchestrator command (NOT for subagents):
# Codex reports findings only — does NOT fix.
# Implement Codex findings via additional subagent dispatches if mechanical.
```

---

## Self-review checklist

The orchestrator skims this plan once more before dispatching anything:

- [ ] Every task lists exact file paths to create/modify/delete.
- [ ] Every task has explicit `npm run typecheck` step before commit.
- [ ] No "TBD" / "TODO" / "implement later" / "handle edge cases" placeholders.
- [ ] Function/symbol names referenced in later tasks match their definitions in earlier tasks (`runOneItem`, `startDaemonHttpServer`, `startKeepaliveTimer`, `createTaskStore`, the `buildXxx` builder family, etc.).
- [ ] Phase 3.2 paths in Step 4 (kernel) and Step 5 (daemon) match the destination paths in Step 7's import-update examples.
- [ ] Each task's commit message format matches `refactor(<subsystem>): <imperative summary>`.
- [ ] Universal task wrapper (verification + out-of-scope) is referenced by every task — orchestrator inlines it into each subagent dispatch prompt.

---

## STOP HERE

After this plan is committed, the orchestrator does NOT auto-execute. It reports the plan path to the user and waits for explicit "execute" / "start implementing" / "run plan" instruction. Per global CLAUDE.md, plans are deliverables — execution is a separate gate.
