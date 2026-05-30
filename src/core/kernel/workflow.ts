import type {
  WorkflowConfig,
  RegisteredWorkflow,
  WorkflowMetadata,
  WorkflowStepPreset,
  WorkflowStepPresetMetadata,
  RunOpts,
  BatchResult,
} from './types.js'
import type { WorkflowArchetype, WorkflowArchetypeOrResolver } from '../../domain/row-archetype.js'
import type { QueueRowKindOrResolver } from '../../domain/queue-row-kind.js'
import { register, autoLabel, normalizeDetailField } from './registry.js'
import { setWorkflowRuntimePolicy } from '../../domain/workflow-runtime/registry.js'
import { Session } from './session.js'
import { log } from '../../utils/log.js'
import { runWorkflowPool } from './pool.js'
import { runWorkflowSharedContextPool } from './shared-context-pool.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { validateAndPrepareItems, callerPreEmitsPending, awaitAllSystemsReady } from './batch-helpers.js'
import { runOneItem } from './run-one-item.js'
import { splitPrefilled } from './workflow-tracker-data.js'

export { runOneItem } from './run-one-item.js'
export type { RunOneItemOpts, RunOneItemResult } from './run-one-item.js'
export {
  toRecord,
  splitPrefilled,
  buildTrackerOpts,
  buildInitialTrackerData,
  deriveItemId,
} from './workflow-tracker-data.js'
export { buildSessionObserver } from './session-observer.js'
export { runWorkflow } from './run-workflow.js'

/**
 * Validate `WorkflowConfig.presets` and normalize to the wire shape.
 * Throws on duplicate preset ids, empty / reserved ids, or skipSteps entries
 * that aren't members of the workflow's declared `steps` tuple. `"full"` is
 * reserved because the dashboard synthesizes it client-side as the implicit
 * default preset — workflow files must not redeclare it.
 */
function validateAndNormalizePresets<TSteps extends readonly string[]>(
  workflowName: string,
  steps: TSteps,
  presets: ReadonlyArray<WorkflowStepPreset<TSteps>>,
): WorkflowStepPresetMetadata[] {
  const declaredSteps = new Set<string>(steps)
  const seenIds = new Set<string>()
  return presets.map((p, i) => {
    if (!p.id || typeof p.id !== 'string') {
      throw new Error(`defineWorkflow('${workflowName}'): presets[${i}].id must be a non-empty string`)
    }
    if (p.id === 'full') {
      throw new Error(
        `defineWorkflow('${workflowName}'): presets[${i}].id 'full' is reserved for the implicit default preset; choose another id`,
      )
    }
    if (seenIds.has(p.id)) {
      throw new Error(`defineWorkflow('${workflowName}'): duplicate preset id '${p.id}'`)
    }
    seenIds.add(p.id)
    if (!p.label || typeof p.label !== 'string') {
      throw new Error(`defineWorkflow('${workflowName}'): presets[${i}].label must be a non-empty string`)
    }
    if (!Array.isArray(p.skipSteps) || p.skipSteps.length === 0) {
      throw new Error(
        `defineWorkflow('${workflowName}'): presets[${i}] ('${p.id}').skipSteps must be a non-empty array`,
      )
    }
    const unknown = p.skipSteps.filter((s) => !declaredSteps.has(s))
    if (unknown.length > 0) {
      throw new Error(
        `defineWorkflow('${workflowName}'): preset '${p.id}' references unknown step(s): ${unknown.join(', ')}. ` +
        `Declared steps: ${[...declaredSteps].join(', ')}`,
      )
    }
    return {
      id: p.id,
      label: p.label,
      skipSteps: [...p.skipSteps],
      ...(p.description ? { description: p.description } : {}),
    }
  })
}

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const authPrefix =
    config.authSteps === false ? [] : config.systems.map((s) => `auth:${s.id}`)
  const effectiveSteps: readonly string[] = [...authPrefix, ...config.steps]
  const archetype: WorkflowArchetypeOrResolver<TData> =
    config.archetype ?? (config.batch ? 'batch' : 'single')
  const metadataArchetype: WorkflowArchetype =
    typeof archetype === 'function'
      ? (config.batch ? 'batch' : 'single')
      : archetype
  // Subject-semantics kind (defaults to person — the majority shape; the
  // architecture guard enforces an explicit declaration on every real
  // workflow). Code is the trace-id/daemon provenance prefix.
  const queueRowKind: QueueRowKindOrResolver<TData> = config.queueRowKind ?? 'person'
  const code = (config.code ?? config.name.slice(0, 2)).toLowerCase()
  const presetsMetadata = config.presets
    ? validateAndNormalizePresets(config.name, config.steps, config.presets)
    : undefined
  const metadata: WorkflowMetadata = {
    name: config.name,
    label: config.label ?? autoLabel(config.name),
    archetype: metadataArchetype,
    code,
    steps: effectiveSteps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []).map(normalizeDetailField),
    ...(config.category ? { category: config.category } : {}),
    ...(config.iconName ? { iconName: config.iconName } : {}),
    ...(config.matchKey ? { matchKey: config.matchKey } : {}),
    hasOperatorSubject: Boolean(config.operatorSubject),
    ...(config.runtimePolicy ? { runtimePolicy: config.runtimePolicy } : {}),
    ...(presetsMetadata && presetsMetadata.length > 0 ? { presets: presetsMetadata } : {}),
  }
  if (config.runtimePolicy) {
    setWorkflowRuntimePolicy(config.name, config.runtimePolicy)
  }
  register(metadata)
  return { config: { ...config, archetype, code }, metadata, archetype, queueRowKind, code }
}

export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    return runWorkflowPool(wf, items, opts)
  }
  if (batch?.mode === 'shared-context-pool') {
    return runWorkflowSharedContextPool(wf, items, opts)
  }

  // Sequential mode: strip the prefilledData channel before parsing so workflow
  // schemas don't have to know about the kernel-level edit-and-resume contract —
  // strict()-mode schemas would otherwise reject the channel as an unknown key.
  const perItem = validateAndPrepareItems(wf, items, opts, (item) => {
    const { cleaned } = splitPrefilled(item)
    wf.config.schema.parse(cleaned)
  })
  const callerPreEmits = callerPreEmitsPending(wf, opts)

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  return withBatchLifecycle(
    {
      workflow: wf.config.name,
      wf,
      archetype: wf.archetype,
      systems: wf.config.systems,
      perItem: perItem.map(({ item, itemId, runId }) => ({
        item,
        itemId,
        runId,
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      })),
      trackerDir: opts.trackerDir,
    },
    async ({ instance, markTerminated, makeObserver }) => {
      const { observer, getAuthTimings } = makeObserver('1')
      const session = await Session.launch(wf.config.systems, {
        launchFn: opts.launchFn,
        observer,
      })

      await awaitAllSystemsReady(session, wf.config.systems)
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

      // Sequential between-items hook — skipped on the first item (fresh
      // auth state). Threaded into runOneItem via `preHandler` so hook runs
      // INSIDE withTrackedWorkflow; throws surface as `failed` tracker rows
      // just like handler throws.
      const makePreHandler = (i: number): (() => Promise<void>) | undefined => {
        if (i === 0 || !batch?.betweenItems) return undefined
        return async () => {
          for (const hook of batch.betweenItems!) {
            if (hook === 'reset') {
              const t0 = Date.now()
              await Promise.all(wf.config.systems.map((s) => session.reset(s.id)))
              log.step(`[Batch] Reset systems (took ${Date.now() - t0}ms)`)
            } else if (hook === 'health-check') {
              const results = await Promise.all(wf.config.systems.map(async (s) => ({
                id: s.id,
                ok: await session.healthCheck(s.id),
              })))
              const failed = results.find((result) => !result.ok)
              if (failed) {
                throw new Error(`health-check failed for ${failed.id}`)
              }
            }
          }
        }
      }

      try {
        for (let i = 0; i < perItem.length; i++) {
          const { item, itemId, runId } = perItem[i]
          log.step(`[Batch] Item ${i + 1}/${perItem.length}: itemId='${itemId}'`)
          const r = await runOneItem({
            wf,
            session,
            item,
            itemId,
            runId,
            trackerStub: opts.trackerStub,
            trackerDir: opts.trackerDir,
            callerPreEmits,
            preHandler: makePreHandler(i),
            preAssignedInstance: instance,
            authTimings,
          })
          markTerminated(runId)
          if (r.ok) result.succeeded++
          else { result.failed++; result.errors.push({ item, error: r.error }) }
        }
      } finally {
        await session.close()
      }
      return result
    },
  )
}
