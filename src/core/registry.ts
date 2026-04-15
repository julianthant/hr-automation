import type { WorkflowMetadata } from './types.js'

const registry = new Map<string, WorkflowMetadata>()

export function register(metadata: WorkflowMetadata): void {
  registry.set(metadata.name, metadata)
}

export function getAll(): WorkflowMetadata[] {
  return [...registry.values()]
}

export function getByName(name: string): WorkflowMetadata | undefined {
  return registry.get(name)
}

export function clear(): void {
  registry.clear()
}
