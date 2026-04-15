import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata, Ctx, RunOpts } from './types.js'
import { register } from './registry.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { withTrackedWorkflow } from '../tracker/jsonl.js'
import { withLogContext, log } from '../utils/log.js'

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const metadata: WorkflowMetadata = {
    name: config.name,
    steps: config.steps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []) as string[],
  }
  register(metadata)
  return { config, metadata }
}

export async function runWorkflow<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  data: TData,
  opts: RunOpts = {},
): Promise<void> {
  // 1. Validate data. Wrap to ensure error message matches /validation/i.
  try {
    wf.config.schema.parse(data)
  } catch (err) {
    throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Derive itemId from common id fields, fall back to UUID.
  const d = data as unknown as Record<string, unknown>
  const itemId =
    opts.itemId ??
    (typeof d?.emplId === 'string' ? d.emplId : undefined) ??
    (typeof d?.docId === 'string' ? d.docId : undefined) ??
    (typeof d?.email === 'string' ? d.email : undefined) ??
    randomUUID()

  const run = async (
    setStep: (s: string) => void,
    updateData: (d: Record<string, string>) => void,
  ): Promise<void> => {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })

    const runId = opts.preAssignedRunId ?? randomUUID()
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId: String(itemId),
      runId,
      emitStep: setStep,
      emitData: (patch) => {
        // Stringify all values — tracker's updateData only accepts strings.
        const stringified: Record<string, string> = {}
        for (const [k, v] of Object.entries(patch)) {
          stringified[k] = v === null || v === undefined ? '' : String(v)
        }
        updateData(stringified)
      },
      emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
    })

    const ctx: Ctx<TSteps, TData> = {
      page: (id) => session.page(id),
      step: (name, fn) => stepper.step(name as string, fn),
      parallel: (tasks) => stepper.parallel(tasks),
      updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
      session: {
        page: (id) => session.page(id),
        newWindow: async () => { throw new Error('newWindow not yet implemented') },
        closeWindow: async () => { throw new Error('closeWindow not yet implemented') },
      },
      log,
      isBatch: false,
      runId,
    }

    try {
      await wf.config.handler(ctx, data)
    } finally {
      await session.close()
    }
  }

  if (opts.trackerStub) {
    await run(
      () => {},
      () => {},
    )
    return
  }

  await withLogContext(wf.config.name, String(itemId), async () => {
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      {},                                               // initialData
      async (setStep, updateData /*, _onCleanup, _session */) => {
        await run(setStep, updateData)
      },
      opts.preAssignedRunId,                            // 5th positional
    )
  })
}
