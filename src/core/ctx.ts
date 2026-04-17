import type { Ctx } from './types.js'
import type { Session } from './session.js'
import type { Stepper } from './stepper.js'
import { log } from '../utils/log.js'

export interface MakeCtxOpts {
  session: Session
  stepper: Stepper
  isBatch: boolean
  runId: string
}

/**
 * Construct a handler Ctx from a Session + Stepper. Shared by runWorkflow,
 * runWorkflowBatch, and runWorkflowPool so all three modes have identical
 * Ctx surface and stubs.
 */
export function makeCtx<TSteps extends readonly string[], TData>(
  opts: MakeCtxOpts,
): Ctx<TSteps, TData> {
  const { session, stepper, isBatch, runId } = opts
  return {
    page: (id) => session.page(id),
    step: (name, fn) => stepper.step(name as string, fn),
    parallel: (tasks) => stepper.parallel(tasks),
    updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
    session: {
      page: (id) => session.page(id),
      newWindow: async () => {
        throw new Error('newWindow not yet implemented')
      },
      closeWindow: async () => {
        throw new Error('closeWindow not yet implemented')
      },
    },
    log,
    isBatch,
    runId,
  }
}
