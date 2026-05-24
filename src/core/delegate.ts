/**
 * Kernel composition: `ctx.delegateTo` / `ctx.delegateToAll`.
 *
 * Contract 3 (Delegation API). Workflows compose **like functions** — a
 * parent handler calls a child workflow via a single kernel-owned call
 * that:
 *   - Stamps `parentRunId` from `ctx.runId` on every child row.
 *   - Pre-emits the child's pending row through `emitTrackerRow` with
 *     `data.archetype` stamped (Contract 1).
 *   - Persists the child's pristine original input on the task store for
 *     the daemon path (Contract 2 tier 1); for in-process delegation, the
 *     input rides on the pending row's `input` field (Contract 2 tier 2).
 *   - Awaits the child's terminal status (`done` / `failed` /
 *     `cancelled`) and returns a typed `ChildRunResult`. With
 *     `fireAndForget: true`, returns immediately after enqueue/launch with
 *     `status: "pending"` and no terminal data.
 *
 * The kernel handles all of the above — call sites in workflow handlers
 * should never reach for `runWorkflow(child, ..., { parentRunId })` or
 * `ensureDaemonsAndEnqueue(child, ..., { parentRunId })` directly. The
 * architecture guard at `tests/unit/architecture/delegate-to-usage.test.ts`
 * blocks new direct callers; `tests/unit/architecture/tracker-row-emission.test.ts`
 * guards the expected row-emission path.
 *
 * Routing:
 *   - `delegateTo(child, input, opts)` runs the child IN-PROCESS via
 *     `runWorkflow`. Use for single sequential children where the parent
 *     consumes the result immediately (OCR's roster-download, oath-upload's
 *     OCR delegation). The child can be daemon-capable or not; in-process
 *     delegation skips the daemon round-trip.
 *   - `delegateToAll(child, inputs, opts)` dispatches via
 *     `ensureDaemonsAndEnqueue` when the child workflow is daemon-capable
 *     (registered in `WORKFLOW_LOADERS`); otherwise iterates `runWorkflow`
 *     with a concurrency pool. Awaits all children via `watchChildRuns`
 *     for the daemon path; for the in-process path, terminal status comes
 *     from the per-run resolved/rejected promise.
 *
 * `renderAs` overrides:
 *   - "flat"    → child renders as a flat `delegation-member` surface row
 *                 (equivalent to OCR's existing `runtimePolicy.delegation
 *                 .utilityChildSurface = "delegation-member"` pattern).
 *                 Stamps `archetype: "passive-child"` so projections render
 *                 it under the parent without promoting to a group card.
 *   - "preview" → child renders as an `approval-delegation` preview row.
 *                 Stamps the child's natural archetype (`delegate-child`
 *                 for non-utility children); the preview affordance comes
 *                 from the child workflow's `runtimePolicy.preview`.
 *   - "batch"   → child renders as a `batch-delegation` group member.
 *                 Stamps `archetype: "delegate-child"`. Use for fan-outs
 *                 where many children belong to one parent card.
 *
 * When `renderAs` is omitted, the kernel derives the row archetype via
 * `deriveRowArchetype(child.archetype, parentRunId)`.
 */
import type {
  RegisteredWorkflow,
  Ctx,
  ChildRunResult,
  DelegateOpts,
  DelegateAllOpts,
  DelegateRenderAs,
} from "./kernel/types.js"
import { runWorkflow } from "./kernel/run-workflow.js"
import type { RowArchetype } from "../domain/row-archetype.js"
import { deriveRowArchetype } from "../domain/row-archetype.js"
import { listWorkflowNames } from "./workflow-loaders.js"
import { ensureDaemonsAndEnqueue } from "./daemon/client.js"
import { watchChildRuns, type ChildOutcome } from "../tracker/delegation/watch-child-runs.js"
import { emitTrackerRow, type StampedData } from "../tracker/jsonl.js"
import { buildPendingTrackerData } from "./pending-data.js"
import { errorMessage } from "../utils/errors.js"
import { log } from "../utils/log.js"
import { randomUUID } from "node:crypto"

export type {
  ChildRunResult,
  DelegateOpts,
  DelegateAllOpts,
  DelegateRenderAs,
} from "./kernel/types.js"

interface DelegateCoreArgs<TChildData, TChildSteps extends readonly string[]> {
  parentRunId: string
  trackerDir: string | undefined
  child: RegisteredWorkflow<TChildData, TChildSteps>
  input: TChildData
  renderAs?: DelegateRenderAs
  fireAndForget: boolean
  itemId?: string
  runId?: string
}

/** Map a `renderAs` override to the canonical `RowArchetype` to stamp. */
function resolveDelegateArchetype<TData, TSteps extends readonly string[]>(
  child: RegisteredWorkflow<TData, TSteps>,
  parentRunId: string,
  renderAs?: DelegateRenderAs,
): RowArchetype {
  if (renderAs === "flat") return "passive-child"
  if (renderAs === "batch" || renderAs === "preview") return "delegate-child"
  return deriveRowArchetype(child.archetype, parentRunId)
}

function isDaemonCapable(workflowName: string): boolean {
  return listWorkflowNames().includes(workflowName)
}

/**
 * Emit the child's pending row through `emitTrackerRow` with the resolved
 * archetype stamped + the pristine input attached as `entry.input`. The
 * daemon path also writes a pending row inside `ensureDaemonsAndEnqueue`
 * via `onPreEmitPending`; the in-process path goes through `runWorkflow`'s
 * own pending emit (we mirror it here so the dashboard shows the row
 * BEFORE `runWorkflow` reaches its first step).
 */
function preEmitPendingForChild<TChildData, TChildSteps extends readonly string[]>(args: {
  child: RegisteredWorkflow<TChildData, TChildSteps>
  input: TChildData
  parentRunId: string
  itemId: string
  runId: string
  archetype: RowArchetype
  trackerDir: string | undefined
}): void {
  const data = buildPendingTrackerData({
    workflow: args.child,
    input: args.input,
    parentRunId: args.parentRunId,
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
  })
  const stamped: StampedData = { ...data, archetype: args.archetype }
  emitTrackerRow(
    {
      workflow: args.child.config.name,
      timestamp: new Date().toISOString(),
      id: args.itemId,
      runId: args.runId,
      parentRunId: args.parentRunId,
      status: "pending",
      data: stamped,
      input: args.input as Record<string, unknown>,
    },
    args.trackerDir,
  )
}

/**
 * Result builder for in-process delegation. `runWorkflow` resolves on
 * success and throws on failure; map that to a typed `ChildRunResult`.
 */
async function runInProcessAndCollectResult<TChildData, TChildSteps extends readonly string[]>(
  args: DelegateCoreArgs<TChildData, TChildSteps> & { itemId: string; runId: string },
): Promise<ChildRunResult<TChildData>> {
  try {
    await runWorkflow(args.child, args.input, {
      itemId: args.itemId,
      preAssignedRunId: args.runId,
      ...(args.trackerDir ? { trackerDir: args.trackerDir } : {}),
      parentRunId: args.parentRunId,
    })
    return {
      workflow: args.child.config.name,
      runId: args.runId,
      itemId: args.itemId,
      status: "done",
    }
  } catch (err) {
    const message = errorMessage(err)
    const cancelled = err instanceof Error && err.name === "CancelledError"
    return {
      workflow: args.child.config.name,
      runId: args.runId,
      itemId: args.itemId,
      status: cancelled ? "cancelled" : "failed",
      error: { message },
    }
  }
}

/**
 * Implementation backing `ctx.delegateTo`. Routes daemon-capable children
 * through `dispatchToDaemonAndWait` so SQLite `tasks.original_input_json`
 * (Contract 2 tier 1) gets written — without that, a retry of a crashed
 * single-child delegation falls into the "no SQLite task record found"
 * branch in `ops/retry.ts`. Non-daemon-capable children (OCR,
 * sharepoint-download, etc.) stay on the in-process `runWorkflow` path
 * because they have no `WORKFLOW_LOADERS` entry to spawn a daemon for.
 *
 * Fire-and-forget always uses the in-process path. The daemon enqueue
 * returns before the worker even claims the row, but the parent still
 * holds a reference to the kernel run, so detaching is simpler when we
 * stay in-process.
 */
export async function delegateToImpl<TChildData, TChildSteps extends readonly string[]>(
  args: DelegateCoreArgs<TChildData, TChildSteps>,
): Promise<ChildRunResult<TChildData>> {
  const childItemId =
    args.itemId
    ?? args.child.config.deriveItemId?.(args.input)
    ?? `delegate-${randomUUID().slice(0, 8)}`
  const childRunId = args.runId ?? randomUUID()
  const archetype = resolveDelegateArchetype(args.child, args.parentRunId, args.renderAs)

  // Route daemon-capable, non-fire-and-forget children through the daemon
  // path so SQLite `tasks.original_input_json` lands (Contract 2 tier 1).
  // The daemon path itself derives its own itemId via the child config's
  // `deriveItemId`; when the caller pins an explicit itemId, we have to
  // pass a `deriveItemId` override that returns it unconditionally so the
  // SQLite row keys on the pinned id.
  if (!args.fireAndForget && isDaemonCapable(args.child.config.name)) {
    const results = await dispatchToDaemonAndWait({
      parentRunId: args.parentRunId,
      trackerDir: args.trackerDir,
      child: args.child,
      inputs: [args.input],
      ...(args.renderAs ? { renderAs: args.renderAs } : {}),
      fireAndForget: false,
      deriveItemId: args.itemId ? () => childItemId : undefined,
    })
    return results[0]
  }

  preEmitPendingForChild({
    child: args.child,
    input: args.input,
    parentRunId: args.parentRunId,
    itemId: childItemId,
    runId: childRunId,
    archetype,
    trackerDir: args.trackerDir,
  })

  if (args.fireAndForget) {
    // Spawn the child but don't await it — caller asked us not to.
    void runWorkflow(args.child, args.input, {
      itemId: childItemId,
      preAssignedRunId: childRunId,
      ...(args.trackerDir ? { trackerDir: args.trackerDir } : {}),
      parentRunId: args.parentRunId,
    }).catch((err) => {
      log.warn(`[delegateTo] fire-and-forget child '${args.child.config.name}/${childItemId}' crashed: ${errorMessage(err)}`)
    })
    return {
      workflow: args.child.config.name,
      runId: childRunId,
      itemId: childItemId,
      status: "pending",
    }
  }

  return runInProcessAndCollectResult({
    ...args,
    itemId: childItemId,
    runId: childRunId,
  })
}

/**
 * Build a `ChildOutcome` → `ChildRunResult` mapper. `watchChildRuns`
 * returns one `ChildOutcome` per expected itemId with status `"done"` or
 * `"failed"` (the watcher merges cancelled tasks into `"failed"`); we
 * preserve that mapping here so the parent's `ChildRunResult` shape is
 * consistent across paths.
 */
function outcomeToResult<_TChildData>(
  outcome: ChildOutcome,
): ChildRunResult<_TChildData> {
  const result: ChildRunResult<_TChildData> = {
    workflow: outcome.workflow,
    runId: outcome.runId,
    itemId: outcome.itemId,
    status: outcome.status,
  }
  if (outcome.data && Object.keys(outcome.data).length > 0) {
    result.data = outcome.data
  }
  if (outcome.error) {
    result.error = { message: outcome.error }
  }
  return result
}

/**
 * In-process fan-out with optional concurrency limit. Used by
 * `delegateToAll` when the child workflow is not daemon-capable.
 */
async function runInProcessPool<TChildData, TChildSteps extends readonly string[]>(args: {
  parentRunId: string
  trackerDir: string | undefined
  child: RegisteredWorkflow<TChildData, TChildSteps>
  inputs: readonly TChildData[]
  renderAs?: DelegateRenderAs
  fireAndForget: boolean
  concurrency?: number
}): Promise<ChildRunResult<TChildData>[]> {
  const results: ChildRunResult<TChildData>[] = new Array(args.inputs.length)
  const concurrency = Math.max(1, args.concurrency ?? args.inputs.length)
  let nextIdx = 0
  const workers = Array.from({ length: Math.min(concurrency, args.inputs.length) }, async () => {
    while (true) {
      const i = nextIdx++
      if (i >= args.inputs.length) return
      results[i] = await delegateToImpl({
        parentRunId: args.parentRunId,
        trackerDir: args.trackerDir,
        child: args.child,
        input: args.inputs[i],
        ...(args.renderAs ? { renderAs: args.renderAs } : {}),
        fireAndForget: args.fireAndForget,
      })
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Daemon-dispatched fan-out. Uses `ensureDaemonsAndEnqueue` to write
 * SQLite task rows + pre-emit pending tracker rows for every child, then
 * awaits all terminal statuses via `watchChildRuns` (unless
 * `fireAndForget: true`).
 *
 * `onPreparedItems` is forwarded verbatim to `ensureDaemonsAndEnqueue` —
 * see its docstring. Used by OCR to attach SQLite task-dependency rows
 * after itemIds/runIds are assigned but before the pending emit fires.
 */
async function dispatchToDaemonAndWait<TChildData, TChildSteps extends readonly string[]>(args: {
  parentRunId: string
  trackerDir: string | undefined
  child: RegisteredWorkflow<TChildData, TChildSteps>
  inputs: readonly TChildData[]
  renderAs?: DelegateRenderAs
  fireAndForget: boolean
  deriveItemId?: (input: TChildData) => string
  buildPendingExtras?: (input: TChildData, itemId: string) => Record<string, unknown>
  onPreparedItems?: (items: Array<{ itemId: string; runId: string; input: TChildData }>) => Promise<void> | void
}): Promise<ChildRunResult<TChildData>[]> {
  if (args.inputs.length === 0) return []

  const archetype = resolveDelegateArchetype(args.child, args.parentRunId, args.renderAs)
  const expectedItemIds: string[] = []
  // Parallel to expectedItemIds: index → assigned childRunId from the
  // daemon enqueue path. Captured here so the fire-and-forget branch can
  // return ChildRunResults with the real runIds (instead of empty strings)
  // — the caller may want to query the child's status later.
  const expectedRunIds: string[] = []

  await ensureDaemonsAndEnqueue(
    args.child,
    args.inputs as TChildData[],
    {},
    {
      ...(args.trackerDir ? { trackerDir: args.trackerDir } : {}),
      parentRunId: args.parentRunId,
      ...(args.deriveItemId
        ? { deriveItemId: args.deriveItemId }
        : (args.child.config.deriveItemId ? { deriveItemId: args.child.config.deriveItemId } : {})),
      ...(args.onPreparedItems
        ? {
            onPreparedItems: async (prepared) =>
              args.onPreparedItems!(
                prepared.map((p) => ({ itemId: p.itemId, runId: p.runId, input: p.input as TChildData })),
              ),
          }
        : {}),
      onPreEmitPending: (item, childRunId, parentRunIdFwd, itemId) => {
        expectedItemIds.push(itemId)
        expectedRunIds.push(childRunId)
        const extras = args.buildPendingExtras?.(item as TChildData, itemId) ?? {}
        const data = buildPendingTrackerData({
          workflow: args.child,
          input: item,
          parentRunId: parentRunIdFwd,
          useInitialTrackerSeed: true,
          nameIdStamp: "always-on-seed",
          extraData: extras,
        })
        const stamped: StampedData = { ...data, archetype }
        emitTrackerRow(
          {
            workflow: args.child.config.name,
            timestamp: new Date().toISOString(),
            id: itemId,
            runId: childRunId,
            ...(parentRunIdFwd ? { parentRunId: parentRunIdFwd } : {}),
            status: "pending",
            data: stamped,
            input: item as Record<string, unknown>,
          },
          args.trackerDir,
        )
      },
    },
  )

  if (args.fireAndForget) {
    return expectedItemIds.map<ChildRunResult<TChildData>>((itemId, i) => ({
      workflow: args.child.config.name,
      runId: expectedRunIds[i] ?? "",
      itemId,
      status: "pending",
    }))
  }

  const outcomes = await watchChildRuns({
    workflow: args.child.config.name,
    expectedItemIds,
    ...(args.trackerDir ? { trackerDir: args.trackerDir } : {}),
  })
  // Preserve input order in the returned results — watchChildRuns may
  // resolve in completion order.
  const byItem = new Map(outcomes.map((o) => [o.itemId, o]))
  return expectedItemIds.map<ChildRunResult<TChildData>>((itemId) => {
    const outcome = byItem.get(itemId)
    if (!outcome) {
      return {
        workflow: args.child.config.name,
        runId: "",
        itemId,
        status: "failed",
        error: { message: "watchChildRuns returned no outcome for child" },
      }
    }
    return outcomeToResult<TChildData>(outcome)
  })
}

/**
 * Implementation backing `ctx.delegateToAll`. Routes to daemon enqueue
 * when the child is daemon-capable, in-process pool otherwise.
 *
 * **Orchestrator escape hatch.** The `deriveItemId`, `buildPendingExtras`,
 * and `onPreparedItems` hooks exist for OCR orchestrator's specialized
 * eid-lookup fan-out (deriving stable per-record item IDs, attaching
 * formType/pageNum metadata, and chaining SQLite task dependencies for
 * downstream waits). They are NOT part of the public `ctx.delegateToAll`
 * API and should not be added to it.
 *
 * If a second consumer plausibly needs these hooks, that's the signal to
 * promote them to `ctx.delegateToAll`'s options object — and add explicit
 * tests covering each one. Until then, the only caller is
 * `src/workflows/ocr/orchestrator.ts`.
 */
export async function delegateToAllImpl<TChildData, TChildSteps extends readonly string[]>(args: {
  parentRunId: string
  trackerDir: string | undefined
  child: RegisteredWorkflow<TChildData, TChildSteps>
  inputs: readonly TChildData[]
  renderAs?: DelegateRenderAs
  fireAndForget: boolean
  concurrency?: number
  deriveItemId?: (input: TChildData) => string
  buildPendingExtras?: (input: TChildData, itemId: string) => Record<string, unknown>
  onPreparedItems?: (items: Array<{ itemId: string; runId: string; input: TChildData }>) => Promise<void> | void
}): Promise<ChildRunResult<TChildData>[]> {
  if (args.inputs.length === 0) return []
  if (isDaemonCapable(args.child.config.name)) {
    return dispatchToDaemonAndWait(args)
  }
  return runInProcessPool(args)
}

/**
 * Construct the `delegateTo` + `delegateToAll` methods bound to the
 * parent's runId + trackerDir. Called from `makeCtx` and the scenario
 * runtime so the rest of the kernel can stay unchanged.
 */
export function buildDelegateApi(parent: {
  runId: string
  trackerDir: string | undefined
}): Pick<Ctx<readonly string[], unknown>, "delegateTo" | "delegateToAll"> {
  const delegateTo = <TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    input: TChildData,
    opts: DelegateOpts = {},
  ): Promise<ChildRunResult<TChildData>> =>
    delegateToImpl({
      parentRunId: parent.runId,
      trackerDir: parent.trackerDir,
      child,
      input,
      ...(opts.renderAs ? { renderAs: opts.renderAs } : {}),
      fireAndForget: opts.fireAndForget ?? false,
      ...(opts.itemId ? { itemId: opts.itemId } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
    })

  const delegateToAll = <TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    inputs: readonly TChildData[],
    opts: DelegateAllOpts = {},
  ): Promise<ChildRunResult<TChildData>[]> =>
    delegateToAllImpl({
      parentRunId: parent.runId,
      trackerDir: parent.trackerDir,
      child,
      inputs,
      ...(opts.renderAs ? { renderAs: opts.renderAs } : {}),
      fireAndForget: opts.fireAndForget ?? false,
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    })

  return { delegateTo, delegateToAll } as unknown as Pick<
    Ctx<readonly string[], unknown>,
    "delegateTo" | "delegateToAll"
  >
}
