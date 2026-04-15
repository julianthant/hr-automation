import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata } from './types.js'
import { register } from './registry.js'

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
