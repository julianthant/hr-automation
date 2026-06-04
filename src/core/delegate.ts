/**
 * Kernel composition: `ctx.delegateTo` / `ctx.delegateToAll`.
 *
 * Contract 3 (Delegation API). Workflows compose **like functions** — a
 * parent handler calls a child workflow via a single kernel-owned call
 * that:
 *   - Stamps `parentRunId` from `ctx.runId` on every child row.
 *   - Pre-emits the child's pending row through `emitTrackerRow` with
 *     `data.archetype` stamped (Contract 1).
 *   - Persists the child input on the task store for the daemon path
 *     (Contract 2 tier 1); for in-process delegation, the input rides on
 *     the pending row's `input` field (Contract 2 tier 2).
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
 *     signature delegation). The child can be daemon-capable or not; in-process
 *     delegation skips the daemon round-trip.
 *   - `delegateToAll(child, inputs, opts)` dispatches via
 *     `ensureDaemonsAndEnqueue` when the child workflow is daemon-capable
 *     (registered in `WORKFLOW_LOADERS`); otherwise iterates `runWorkflow`
 *     with a concurrency pool. Awaits all children via `watchChildRuns`
 *     for the daemon path; for the in-process path, terminal status comes
 *     from the per-run resolved/rejected promise.
 *
 * `renderAs` controls how delegated child rows relate to the parent:
 *   - "flat"    → child renders as a flat single row.
 *   - "preview" → child renders as a preview card row.
 *   - "batch"   → child is stamped as a batch-member under the parent row.
 *
 * The kernel always derives the row archetype via
 * `deriveRowArchetype(child.archetype, parentRunId, opts)`.
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
import {
  deriveRowArchetype,
  resolveArchetype,
  type RowArchetype,
} from "../domain/row-archetype.js"
import { listWorkflowNames } from "./workflow-loaders.js"
import { ensureDaemonsAndEnqueue } from "./daemon/client.js"
import type { DaemonFlags } from "./daemon/types.js"
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
  /**
   * Provenance code for the child's trace-id prefix — the delegating parent's
   * 2-char workflow `code`, so a delegated row traces back to the workflow that
   * spawned it. Threaded from `buildDelegateApi` (the parent ctx's code). When
   * absent (top-level run), the child stamps its own code. See the root-vs-
   * immediate-parent note in `buildDelegateApi`.
   */
  rootCode?: string
  /**
   * Inherited ROOT trace PREFIX for trace-id propagation (trace/span model) —
   * the originating run's `<code>-<HHMMSS>` prefix, forwarded transitively so
   * every descendant SHARES the prefix while composing its OWN `runId4` tail
   * (`<prefix>-<runId4>`). Carried on `__runtimeOptions` so the daemon worker
   * re-emit recomposes it. Threaded from `buildDelegateApi`'s
   * `forwardRootTracePrefix`.
   */
  rootTracePrefix?: string
  /**
   * Parent run's `AbortSignal`. Forwarded into `runWorkflow`'s `parentSignal`
   * opt so the child's per-run controller aborts when the parent cancels —
   * closes the Contract 5 gap for in-process delegated children (OCR,
   * sharepoint-download) that previously kept running after parent cancel.
   * The daemon-dispatched path doesn't need this — `cancel_task` worker
   * commands reach the daemon directly.
   */
  parentSignal?: AbortSignal
}

function resolveDelegateArchetype<TData, TSteps extends readonly string[]>(
  child: RegisteredWorkflow<TData, TSteps>,
  input: TData,
  parentRunId: string,
  renderAs?: DelegateRenderAs,
): RowArchetype {
  return deriveRowArchetype(
    resolveArchetype(child.config, input),
    parentRunId,
    renderAs === "batch" ? { member: true } : undefined,
  )
}

function withBatchMemberRuntimeOptions<TInput>(input: TInput, renderAs?: DelegateRenderAs): TInput {
  if (renderAs !== "batch" || !input || typeof input !== "object" || Array.isArray(input)) {
    return input
  }
  const current = (input as Record<string, unknown>).__runtimeOptions
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rowShape: "batch-member",
    },
  } as TInput
}

/**
 * Carry the delegating parent's `code` AND the inherited root trace PREFIX on
 * the child input's `__runtimeOptions` channel so they survive the SQLite task
 * store to the daemon worker's own pre-emit (`run-one-item.ts` reads
 * `runtimeOptions.rootCode` / `runtimeOptions.rootTracePrefix`). Without
 * `rootCode` the worker re-emits a pending row prefixed with the child's own
 * code; without `rootTracePrefix` the worker composes a fresh per-run id off the
 * child's own code instead of the shared operation prefix, breaking trace-id
 * propagation across the daemon boundary.
 */
function withRootRuntimeOptions<TInput>(
  input: TInput,
  opts: { rootCode?: string; rootTracePrefix?: string },
): TInput {
  const { rootCode, rootTracePrefix } = opts
  if ((!rootCode && !rootTracePrefix) || !input || typeof input !== "object" || Array.isArray(input)) {
    return input
  }
  const current = (input as Record<string, unknown>).__runtimeOptions
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      ...(rootCode ? { rootCode } : {}),
      ...(rootTracePrefix ? { rootTracePrefix } : {}),
    },
  } as TInput
}

function isDaemonCapable(workflowName: string): boolean {
  return listWorkflowNames().includes(workflowName)
}

/**
 * Emit the run-scope `delegation:children-spawned` event at the public
 * `delegateTo`/`delegateToAll` fan-out chokepoint (called from inside the
 * parent handler's run-scope log context, so it lands in the PARENT's
 * logs/<workflow>-<date>.jsonl). The Tier-1 harness `waitForEvent(
 * "delegation:children-spawned", { childWorkflow })` on it to know a fan-out
 * happened and how many children it produced (`count`). Emitting at the
 * public API (not `delegateToImpl`/`delegateToAllImpl`) avoids double-counting
 * when `delegateToAll`'s in-process pool re-enters `delegateToImpl` per child.
 * See docs/engineering/structured-log-events.md.
 */
function emitChildrenSpawned(childWorkflow: string, count: number): void {
  log.step({
    message: `Delegating ${count} ${childWorkflow} child run(s)`,
    event: "delegation:children-spawned",
    category: "delegation",
    occasion: "started",
    childWorkflow,
    count,
  })
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
  /** Delegating parent's code — provenance prefix for the child trace id. */
  rootCode?: string
  /**
   * Inherited ROOT trace PREFIX — when present the child COMPOSES its
   * `data.__traceId` as `<prefix>-<ownRunId4>` (trace/span model), so the
   * child's very first pending row shares the operation prefix while keeping its
   * own greppable tail.
   */
  rootTracePrefix?: string
}): void {
  const data = buildPendingTrackerData({
    workflow: args.child,
    input: args.input,
    parentRunId: args.parentRunId,
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    // Trace id keyed on the parent's code for provenance (falls back to the
    // child's own code when undefined). When an inherited root trace PREFIX is
    // in scope the child composes `<prefix>-<ownRunId4>` instead (trace/span
    // model) — the `rootTracePrefix` opt drives the compose.
    runId: args.runId,
    ...(args.rootCode ? { rootCode: args.rootCode } : {}),
    ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
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
      trackerDir: args.trackerDir,
      parentRunId: args.parentRunId,
      ...(args.parentSignal ? { parentSignal: args.parentSignal } : {}),
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
  const childInput = withBatchMemberRuntimeOptions(args.input, args.renderAs)
  const childItemId =
    args.itemId
    ?? args.child.config.deriveItemId?.(args.input)
    ?? `delegate-${randomUUID().slice(0, 8)}`
  const childRunId = args.runId ?? randomUUID()
  const archetype = resolveDelegateArchetype(args.child, childInput, args.parentRunId, args.renderAs)

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
      inputs: [childInput],
      renderAs: args.renderAs,
      fireAndForget: false,
      deriveItemId: args.itemId ? () => childItemId : undefined,
      ...(args.rootCode ? { rootCode: args.rootCode } : {}),
      ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
    })
    return results[0]
  }

  preEmitPendingForChild({
    child: args.child,
    input: childInput,
    parentRunId: args.parentRunId,
    itemId: childItemId,
    runId: childRunId,
    archetype,
    trackerDir: args.trackerDir,
    ...(args.rootCode ? { rootCode: args.rootCode } : {}),
    ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
  })

  if (args.fireAndForget) {
    // Spawn the child but don't await it — caller asked us not to.
    void runWorkflow(args.child, childInput, {
      itemId: childItemId,
      preAssignedRunId: childRunId,
      trackerDir: args.trackerDir,
      parentRunId: args.parentRunId,
      ...(args.parentSignal ? { parentSignal: args.parentSignal } : {}),
    }).catch((err) => {
      const message = errorMessage(err);
      log.warn(`[delegateTo] fire-and-forget child '${args.child.config.name}/${childItemId}' crashed: ${message}`)
      // Bug #5: if `runWorkflow` rejects synchronously (schema-parse
      // failure, `Session.launch` rejection, handler-wiring throw) BEFORE
      // `withTrackedWorkflow` installs its lifecycle, the pre-emitted
      // pending row above never gets a terminal status. Without this
      // emit, the dashboard shows the child stuck pending forever. Emit
      // a terminal `failed` row keyed on the same (id, runId, parentRunId)
      // so the projection collapses the pending row into the failure.
      try {
        const failedData: StampedData = {
          archetype,
          error: message,
        };
        emitTrackerRow(
          {
            workflow: args.child.config.name,
            timestamp: new Date().toISOString(),
            id: childItemId,
            runId: childRunId,
            parentRunId: args.parentRunId,
            status: "failed",
            data: failedData,
            error: message,
          },
          args.trackerDir,
        );
      } catch (emitErr) {
        log.warn(
          `[delegateTo] failed to emit terminal failed row for crashed fire-and-forget child '${args.child.config.name}/${childItemId}': ${errorMessage(emitErr)}`,
        );
      }
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
    input: childInput,
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
  parentSignal?: AbortSignal
  rootCode?: string
  rootTracePrefix?: string
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
        renderAs: args.renderAs,
        fireAndForget: args.fireAndForget,
        ...(args.rootCode ? { rootCode: args.rootCode } : {}),
        ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
        ...(args.parentSignal ? { parentSignal: args.parentSignal } : {}),
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
  /** Delegating parent's code — provenance prefix for the child trace id. */
  rootCode?: string
  /** Inherited ROOT trace PREFIX — propagated to every child to compose its own tail. */
  rootTracePrefix?: string
  /**
   * Daemon spawn flags for the fan-out's `ensureDaemonsAndEnqueue` — lets a
   * caller raise the alive-daemon target for the children (e.g. OCR's
   * `{ parallel: N }` from the operator's worker setting). Omitted/`{}` keeps
   * the default reuse-or-spawn-one behavior. See `src/domain/run-options.ts`.
   */
  daemonFlags?: DaemonFlags
}): Promise<ChildRunResult<TChildData>[]> {
  if (args.inputs.length === 0) return []

  const queuedInputs = args.inputs.map((input) =>
    withRootRuntimeOptions(withBatchMemberRuntimeOptions(input, args.renderAs), {
      ...(args.rootCode ? { rootCode: args.rootCode } : {}),
      ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
    }),
  )
  const expectedItemIds: string[] = []
  // Parallel to expectedItemIds: index → assigned childRunId from the
  // daemon enqueue path. Captured here so the fire-and-forget branch can
  // return ChildRunResults with the real runIds (instead of empty strings)
  // — the caller may want to query the child's status later.
  const expectedRunIds: string[] = []

  await ensureDaemonsAndEnqueue(
    args.child,
    queuedInputs as TChildData[],
    args.daemonFlags ?? {},
    {
      trackerDir: args.trackerDir,
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
        const archetype = resolveDelegateArchetype(args.child, item as TChildData, args.parentRunId, args.renderAs)
        const extras = args.buildPendingExtras?.(item as TChildData, itemId) ?? {}
        const data = buildPendingTrackerData({
          workflow: args.child,
          input: item,
          parentRunId: parentRunIdFwd,
          useInitialTrackerSeed: true,
          nameIdStamp: "always-on-seed",
          extraData: extras,
          // Stamp the trace id with the delegating parent's code for
          // provenance (falls back to the child's own code when undefined).
          // When an inherited root trace PREFIX is in scope the child composes
          // `<prefix>-<ownRunId4>` instead (trace/span model) — `rootTracePrefix`
          // drives the compose.
          runId: childRunId,
          ...(args.rootCode ? { rootCode: args.rootCode } : {}),
          ...(args.rootTracePrefix ? { rootTracePrefix: args.rootTracePrefix } : {}),
        })
        const stamped: StampedData = { ...data, archetype }
        emitTrackerRow(
          {
            workflow: args.child.config.name,
            timestamp: new Date().toISOString(),
            id: itemId,
            runId: childRunId,
            parentRunId: parentRunIdFwd,
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
    return expectedItemIds.map<ChildRunResult<TChildData>>((itemId, i) => {
      // Invariant: `onPreEmitPending` pushes one runId per itemId in the
      // same order, so expectedRunIds[i] MUST be defined here. The prior
      // `?? ""` defensive default silently corrupted attribution — empty
      // runId breaks retry-by-runId, dashboard navigation, and
      // watchChildRuns correlation. Fail loud instead.
      const runId = expectedRunIds[i];
      if (!runId) {
        throw new Error(
          `delegate: fire-and-forget result has no runId for itemId=${itemId} (index ${i}) — invariant violated, expectedItemIds.length=${expectedItemIds.length} but expectedRunIds.length=${expectedRunIds.length}`,
        );
      }
      return {
        workflow: args.child.config.name,
        runId,
        itemId,
        status: "pending",
      };
    })
  }

  const outcomes = await watchChildRuns({
    workflow: args.child.config.name,
    expectedItemIds,
    trackerDir: args.trackerDir,
  })
  // Preserve input order in the returned results — watchChildRuns may
  // resolve in completion order.
  const byItem = new Map(outcomes.map((o) => [o.itemId, o]))
  return expectedItemIds.map<ChildRunResult<TChildData>>((itemId, i) => {
    const outcome = byItem.get(itemId)
    if (!outcome) {
      // Use the runId we assigned at enqueue (Bug #4): emitting an empty
      // string here would leave the failed row un-retryable from the
      // dashboard (retry-by-runId / watchChildRuns / navigation all key
      // off runId). The runId IS known — `onPreEmitPending` filled
      // expectedRunIds[i] in lockstep with expectedItemIds[i].
      const runId = expectedRunIds[i];
      if (!runId) {
        throw new Error(
          `delegate: no outcome AND no expected runId for itemId=${itemId} (index ${i}) — invariant violated`,
        );
      }
      return {
        workflow: args.child.config.name,
        runId,
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
 * and `onPreparedItems` hooks exist for OCR orchestrator-level fan-outs
 * (deriving stable per-record item IDs, attaching formType/pageNum metadata,
 * and chaining SQLite task dependencies for downstream waits). They are NOT
 * part of the public `ctx.delegateToAll` API and should not be added to it.
 *
 * If a non-OCR consumer plausibly needs these hooks, that's the signal to
 * promote them to `ctx.delegateToAll`'s options object — and add explicit
 * tests covering each one. Direct callers are limited to OCR by the
 * `delegate-to-all-impl-callers` architecture guard:
 *   - `src/workflows/ocr/orchestrator.ts` (main eid-lookup fan-out)
 *   - `src/workflows/ocr/force-research.ts` (per-record re-research)
 *   - `src/workflows/ocr/retry-page.ts` (single-page retry)
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
  parentSignal?: AbortSignal
  /** Delegating parent's code — provenance prefix for child trace ids. */
  rootCode?: string
  /**
   * Inherited ROOT trace PREFIX — propagated to every child so each composes
   * `<prefix>-<ownRunId4>` (trace/span model); the whole delegation tree shares
   * one operation prefix. OCR passes `tracePrefix(traceId)` of the `ou-...` id it
   * computes for the oath form here.
   */
  rootTracePrefix?: string
  /**
   * Daemon spawn flags for the daemon-capable fan-out path — forwarded to
   * `dispatchToDaemonAndWait` → `ensureDaemonsAndEnqueue` so a caller can raise
   * the alive-daemon target (OCR's `{ parallel: N }` from the operator's worker
   * setting). No-op on the in-process pool path (no daemons). Internal escape
   * hatch only — NOT added to the public `ctx.delegateToAll` API.
   */
  daemonFlags?: DaemonFlags
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
  /**
   * Parent run's `AbortSignal` (from `ctx.signal`). When provided, every
   * delegated child receives this as `parentSignal` so an operator cancel
   * on the parent propagates into in-process children's `runWorkflow`
   * controller — closes the Contract 5 gap for OCR / sharepoint-download.
   * Optional for backwards compat with the few call sites that build a
   * delegate API without a parent signal (scenario runtime in some test
   * setups).
   */
  signal?: AbortSignal
  /**
   * The delegating parent's 2-char workflow `code`. Threaded onto every
   * delegated child as `rootCode` so the child's trace id is prefixed with
   * the workflow that spawned it (provenance), not the child's own code.
   *
   * Root-vs-immediate-parent: this is the **immediate** parent's code. It is
   * the only provenance available without a new uniform input channel — the
   * parent ctx knows its own code but not, transitively, the code of the run
   * that started the chain (unlike `parentSubject`, which each level forwards
   * through the child input schema). For the common one-level delegations
   * (OCR → person-lookup, oath-upload → oath-signature) the immediate parent
   * IS the root, so the trace id correctly names the originating workflow.
   * Optional for backwards compat with test setups that omit it.
   */
  code?: string
  /**
   * Inherited ROOT trace PREFIX for trace-id propagation (trace/span model).
   * Unlike `code` (the immediate parent's), this is the originating run's
   * `<code>-<HHMMSS>` prefix, forwarded transitively so a whole delegation tree
   * (root → child → grandchild) SHARES one operation prefix while each row
   * composes + keeps its OWN `runId4` tail. Computed once in `makeCtx` as
   * `forwardRootTracePrefix` (a physical root derives `tracePrefix` of its own
   * frozen id; a non-root passes through the prefix it inherited). Drives the
   * child's compose at pre-emit, and carried on `__runtimeOptions` so the daemon
   * worker re-emit recomposes it. Optional — absent when no root is in scope
   * (top-level test setups).
   */
  rootTracePrefix?: string
}): Pick<Ctx<readonly string[], unknown>, "delegateTo" | "delegateToAll"> {
  const delegateTo = <TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    input: TChildData,
    opts: DelegateOpts = {},
  ): Promise<ChildRunResult<TChildData>> => {
    emitChildrenSpawned(child.config.name, 1)
    return delegateToImpl({
      parentRunId: parent.runId,
      trackerDir: parent.trackerDir,
      child,
      input,
      renderAs: opts.renderAs,
      fireAndForget: opts.fireAndForget ?? false,
      itemId: opts.itemId,
      runId: opts.runId,
      ...(parent.code ? { rootCode: parent.code } : {}),
      ...(parent.rootTracePrefix ? { rootTracePrefix: parent.rootTracePrefix } : {}),
      ...(parent.signal ? { parentSignal: parent.signal } : {}),
    })
  }

  const delegateToAll = <TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    inputs: readonly TChildData[],
    opts: DelegateAllOpts = {},
  ): Promise<ChildRunResult<TChildData>[]> => {
    if (inputs.length > 0) emitChildrenSpawned(child.config.name, inputs.length)
    return delegateToAllImpl({
      parentRunId: parent.runId,
      trackerDir: parent.trackerDir,
      child,
      inputs,
      renderAs: opts.renderAs,
      fireAndForget: opts.fireAndForget ?? false,
      concurrency: opts.concurrency,
      ...(parent.code ? { rootCode: parent.code } : {}),
      ...(parent.rootTracePrefix ? { rootTracePrefix: parent.rootTracePrefix } : {}),
      ...(parent.signal ? { parentSignal: parent.signal } : {}),
    })
  }

  return { delegateTo, delegateToAll } as unknown as Pick<
    Ctx<readonly string[], unknown>,
    "delegateTo" | "delegateToAll"
  >
}
