# Plan B — Kernel Batch Helpers (Pathfinder U2 + U3)

> **For agentic workers:** This plan is structured for **subagent-driven execution**. The orchestrator (Opus) dispatches one Sonnet subagent per Task. The orchestrator does NOT review subagent diffs between tasks. Final review is by Codex over the combined diff (after all three plans land), per `~/.claude/CLAUDE.md`.

**Goal:** Extract two small helpers (`validateAndPrepareItems`, `awaitAllSystemsReady`) so the three batch runners (`runWorkflowBatch`, `runWorkflowPool`, `runWorkflowSharedContextPool`) stop independently re-implementing identical pre-flight + system-await loops.

**Architecture:** New file `src/core/batch-helpers.ts` exports two pure functions. Each runner replaces ~10–15 lines of boilerplate with a one-line call. Behavior is byte-identical; this is purely DRY cleanup on the kernel.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Source Pathfinder artifacts:**
- `PATHFINDER-2026-05-06/02-duplication-report.md` — findings A2, A3
- `PATHFINDER-2026-05-06/03-unified-proposal.md` — section U2+U3
- `PATHFINDER-2026-05-06/04-handoff-prompts.md` — Prompt 2

**Branch & worktree:**
- Branch off `master` (clean — not from `codex/active-check-dry-run-ocr-e2e`).
- Recommended: `git checkout -b pathfinder/plan-b-batch-helpers master`.
- Worktree recommended (`git worktree add ../hr-automation-plan-b pathfinder/plan-b-batch-helpers master`) so Plan A or C can run in another session without contention.

**Risk profile:** MEDIUM. The kernel runners are how every workflow executes; even a typo in `validateAndPrepareItems` could regress every workflow. Trust the existing kernel test suite (`tests/unit/core/`) — but if those tests are thin, that's worth flagging back to the orchestrator before continuing.

**Parallelism:**
- **Within this plan:** Task 1 must complete before Task 2 (both touch `src/core/batch-helpers.ts`; Task 2 adds a second export to the file Task 1 creates). DO NOT dispatch Tasks 1 and 2 in parallel — they share a file.
- **Across plans (Plans A / B / C):** Plan B touches kernel files only. Plan A touches dashboard/daemon-queue/work-study. Plan C touches `ocr/orchestrator.ts`. All disjoint. Plans A, B, C can run in parallel sessions.

**Anti-pattern guards (apply to every task):**
- DO NOT change the public API of `runWorkflowBatch`, `runWorkflowPool`, or `runWorkflowSharedContextPool` — signatures stay identical.
- DO NOT fold these helpers into `batch-lifecycle.ts`. That helper owns lifecycle (instance, SIGINT, observer); these helpers own pre-flight and a session-wait. Different concerns.
- DO NOT add `preEmitPending` into the helpers — that's a caller-choice callback that stays on each runner.
- DO NOT add comments explaining what code does. Comments only for non-obvious WHY.
- DO NOT introduce new types beyond what's strictly needed to type the helpers.

---

## Task 1 — U2: `validateAndPrepareItems` extraction

**Subagent model:** Sonnet.

**Goal:** Replace the duplicated "validate items → derive itemIds → build perItem array → fire `onPreEmitPending`" block in all three runners with one helper. The helper returns the per-item array; the `onPreEmitPending` fan-out can move into the helper (it's parameterized by the same `opts.onPreEmitPending` and `wf.config.batch?.preEmitPending`).

**Note about `runWorkflowBatch`:** It does extra work that the other two runners don't — calls `splitPrefilled` before `wf.config.schema.parse`, to strip the `prefilledData` channel before validation. The helper must preserve this. Read `splitPrefilled` in `src/core/workflow.ts:63-78` to understand the shape; then accept it as a default behavior in the helper (all three modes go through it — `pool.ts` and `shared-context-pool.ts` currently don't, but the prefilledData channel is a kernel-level contract that should apply uniformly. **Verify with the orchestrator before changing this** — pool/shared-context-pool not stripping might be intentional, or it might be a latent bug. If unsure, preserve current behavior: `runWorkflowBatch` strips, the other two don't.)

**Files:**
- Create: `src/core/batch-helpers.ts`
- Modify: `src/core/workflow.ts` (lines ~807–842, validation + perItem + preEmitPending)
- Modify: `src/core/pool.ts` (lines ~40–58, validation + perItem + preEmitPending)
- Modify: `src/core/shared-context-pool.ts` (lines ~37–55, validation + perItem + preEmitPending)

### Steps

- [ ] **Step 1.1: Confirm baseline tests green.**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all
npm run test -- tests/unit/core
npm run test:architecture
```

Expected: green.

- [ ] **Step 1.2: Read all three current implementations side-by-side.**

```bash
sed -n '805,845p' src/core/workflow.ts
sed -n '38,60p' src/core/pool.ts
sed -n '35,57p' src/core/shared-context-pool.ts
```

Confirm the variations:
- `workflow.ts` (sequential): `items.forEach(item => { const { cleaned } = splitPrefilled(item); wf.config.schema.parse(cleaned); ... })` — uses `splitPrefilled`.
- `pool.ts`: `items.forEach(item => { wf.config.schema.parse(item) })` — does NOT use `splitPrefilled`.
- `shared-context-pool.ts`: same as `pool.ts`.

Decision (preserve current behavior unless orchestrator says otherwise): take a `useSplitPrefilled: boolean` flag on the helper, or have the caller pass a `validate(item)` function. Cleaner option = pass a validator function.

- [ ] **Step 1.3: Create `src/core/batch-helpers.ts`.**

```ts
import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, RunOpts } from './types.js'
import { deriveItemId } from './workflow.js'

export interface PerItem<TData> {
  item: TData
  itemId: string
  runId: string
}

/**
 * Validate items, derive itemIds + runIds, and fire pre-emit-pending if
 * the workflow opts in. Returns one entry per input item, in input order.
 *
 * Pass `validate` from the caller — `runWorkflowBatch` strips the
 * `prefilledData` channel via splitPrefilled before parsing, the pool
 * runners parse the raw item. This is a behavioral difference between
 * the runners that the helper preserves rather than papers over.
 */
export function validateAndPrepareItems<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts,
  validate: (item: TData) => void,
): PerItem<TData>[] {
  items.forEach((item) => {
    try {
      validate(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  const itemIdFn = opts.deriveItemId
    ?? wf.config.deriveItemId
    ?? ((item: unknown) => deriveItemId(item, randomUUID()))
  const perItem: PerItem<TData>[] = items.map((item) => ({
    item,
    itemId: itemIdFn(item),
    runId: randomUUID(),
  }))

  const callerPreEmits = Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
  if (callerPreEmits) {
    for (const { item, runId } of perItem) opts.onPreEmitPending!(item, runId)
  }

  return perItem
}

/**
 * Indicates whether the caller pre-emitted pending rows. Computed the
 * same way every runner does: `wf.config.batch?.preEmitPending`
 * AND `opts.onPreEmitPending` is provided.
 */
export function callerPreEmitsPending(
  wf: RegisteredWorkflow<unknown, readonly string[]>,
  opts: RunOpts,
): boolean {
  return Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
}
```

The helper omits the actual `callerPreEmits` boolean from its return value because every caller currently re-derives it for its `runOneItem` call. The `callerPreEmitsPending` helper makes that re-derivation a one-liner. Both helpers are small enough that this slight overhead beats overloading the return type.

- [ ] **Step 1.4: Update `src/core/workflow.ts` (sequential `runWorkflowBatch`).**

Replace lines ~807–842 (everything from `// Sequential mode: validate all items upfront.` through the `if (callerPreEmits) { for (...) ... }` block) with:

```ts
import { validateAndPrepareItems, callerPreEmitsPending } from './batch-helpers.js'
import { splitPrefilled } from './workflow.js'  // already in scope; just confirm

const perItem = validateAndPrepareItems(wf, items, opts, (item) => {
  const { cleaned } = splitPrefilled(item)
  wf.config.schema.parse(cleaned)
})
const callerPreEmits = callerPreEmitsPending(wf, opts)
```

`perItem` and `callerPreEmits` are consumed unchanged by the rest of the runner (the `withBatchLifecycle` call and the `runOneItem` loop).

- [ ] **Step 1.5: Update `src/core/pool.ts`.**

Replace lines ~40–58 with:

```ts
import { validateAndPrepareItems, callerPreEmitsPending } from './batch-helpers.js'

const perItem = validateAndPrepareItems(wf, items, opts, (item) => wf.config.schema.parse(item))
const callerPreEmits = callerPreEmitsPending(wf, opts)
```

The local `interface PoolItem<TData>` is now equivalent to the helper's `PerItem<TData>`. Either:
1. Delete the local `PoolItem` interface and use the helper's `PerItem`, OR
2. Keep `PoolItem` as a local type alias `type PoolItem<TData> = PerItem<TData>` if removing it would touch >5 lines.

Pick option 1 if straightforward; it removes a duplicate type.

- [ ] **Step 1.6: Update `src/core/shared-context-pool.ts`.**

Same change pattern as pool.ts, applied to lines ~37–55. Same dedup decision on the local `PoolItem<TData>` interface.

- [ ] **Step 1.7: Verify.**

```bash
npm run typecheck:all
npm run test -- tests/unit/core
npm run test
npm run test:architecture
```

Expected: green. Pay attention to test failures in:
- `tests/unit/core/workflow.test.ts` (sequential batch)
- `tests/unit/core/pool.test.ts`
- `tests/unit/core/shared-context-pool.test.ts`
- Any kernel-level integration tests that exercise `preEmitPending`.

If a test fails because validation error message changed: the helper wraps validation in `new Error('validation error: ...')`. All three runners did this before too — confirm the prefix is preserved.

- [ ] **Step 1.8: Commit.**

```bash
git add src/core/batch-helpers.ts src/core/workflow.ts src/core/pool.ts src/core/shared-context-pool.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract validateAndPrepareItems into batch-helpers.ts

All three batch runners (sequential, pool, shared-context-pool) now share
the validate → deriveItemId → randomUUID runId → onPreEmitPending pipeline
via one helper. Sequential mode preserves its splitPrefilled-before-parse
behavior by passing the unwrap as the validator argument.

No public API change. PerItem<TData> now lives in batch-helpers; pool runners
drop their duplicate local type.
EOF
)"
```

---

## Task 2 — U3: `awaitAllSystemsReady` extraction

**Subagent model:** Sonnet.

**Goal:** All three runners have an identical 3-line loop (`for (const sys of wf.config.systems) { try { await session.page(sys.id) } catch {} }`) that awaits every system's auth-ready promise before snapshotting `authTimings`. Extract to one helper.

**Files:**
- Modify: `src/core/batch-helpers.ts` (add second export)
- Modify: `src/core/workflow.ts` (lines ~863–865)
- Modify: `src/core/pool.ts` (lines ~82–84)
- Modify: `src/core/shared-context-pool.ts` (lines ~81–83)

### Steps

- [ ] **Step 2.1: Confirm Task 1 has landed and tests still pass.**

```bash
cd /Users/julianhein/Documents/hr-automation
git log --oneline -1  # should be Task 1's commit
npm run test -- tests/unit/core
```

Expected: green.

- [ ] **Step 2.2: Read the await-systems sites.**

```bash
sed -n '861,867p' src/core/workflow.ts
sed -n '80,86p' src/core/pool.ts
sed -n '79,85p' src/core/shared-context-pool.ts
```

Confirm all three have the same 3-line pattern with the same try/catch swallow.

- [ ] **Step 2.3: Add `awaitAllSystemsReady` to `src/core/batch-helpers.ts`.**

Append:

```ts
import type { Session } from './session.js'
import type { SystemConfig } from './types.js'

/**
 * Wait for every system's auth-ready promise to resolve. Auth failures
 * are swallowed — the failure path is owned by the observer / batch
 * lifecycle helper, which surfaces it via auth-failure tracker rows
 * and does not need this loop to throw.
 *
 * Must be called BEFORE snapshotting authTimings via the observer's
 * `getAuthTimings()` — `Session.launch` with `authChain: 'interleaved'`
 * returns once the FIRST system is ready, so timings for systems 2..N
 * are still being captured asynchronously.
 */
export async function awaitAllSystemsReady(
  session: Session,
  systems: readonly SystemConfig[],
): Promise<void> {
  for (const sys of systems) {
    try {
      await session.page(sys.id)
    } catch {
      // intentional swallow — see JSDoc above
    }
  }
}
```

- [ ] **Step 2.4: Replace the three call sites.**

In `src/core/workflow.ts` (around line 863):

```ts
// Was:
// for (const sys of wf.config.systems) {
//   try { await session.page(sys.id) } catch { /* auth failure surfaces elsewhere */ }
// }

await awaitAllSystemsReady(session, wf.config.systems)
```

In `src/core/pool.ts` (around line 82):

```ts
await awaitAllSystemsReady(session, wf.config.systems)
```

In `src/core/shared-context-pool.ts` (around line 81):

```ts
await awaitAllSystemsReady(parent, wf.config.systems)
```

Add the import at the top of each file:

```ts
import { awaitAllSystemsReady } from './batch-helpers.js'
```

(Or merge with the existing `batch-helpers` import added in Task 1.)

- [ ] **Step 2.5: Verify.**

```bash
npm run typecheck:all
npm run test -- tests/unit/core
npm run test
npm run test:architecture
```

Expected: green. The helper preserves the catch-and-swallow exactly, so behavior is byte-identical.

- [ ] **Step 2.6: Commit.**

```bash
git add src/core/batch-helpers.ts src/core/workflow.ts src/core/pool.ts src/core/shared-context-pool.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract awaitAllSystemsReady into batch-helpers.ts

All three batch runners (sequential, pool, shared-context-pool) now share
the auth-ready await loop via one helper. Behavior identical: per-system
session.page() with try/catch swallow, since auth failures surface via the
observer + withBatchLifecycle's auth-failure fanout, not by throwing here.
EOF
)"
```

---

## Final verification (after both tasks)

```bash
npm run typecheck:all
npm run test
npm run test:architecture
git log --oneline master..HEAD
```

Expected: 2 commits ahead of master, all tests green.

If the orchestrator wants extra confidence (kernel changes are higher-risk):

```bash
npm run work-study --help  # smoke: registry loads, daemon mode wires up
```

The `--help` command exercises the workflow loader without launching browsers. A real run is too heavy for the plan; trust the unit tests.

**Stop here.** Do NOT open a PR yet — wait for Plans A and C to complete and Codex final review.
