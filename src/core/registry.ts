import type { WorkflowMetadata } from './types.js'

const registry = new Map<string, WorkflowMetadata>()

export function register(metadata: WorkflowMetadata): void {
  registry.set(metadata.name, metadata)
}

/**
 * Lightweight metadata registration for workflows that are NOT declared via
 * `defineWorkflow` (i.e. not kernel-based). Used by legacy workflows
 * (`old-kronos-reports`, `separations`, onboarding-legacy) that still need
 * to surface their label + steps + detailFields to the dashboard.
 *
 * Semantically identical to `register`, but carries intent: callers that use
 * this entry point have NOT opted into the Option-A declared-fields contract,
 * so the kernel's runtime warning for missing `updateData` populations will
 * never fire against them.
 */
export function defineDashboardMetadata(metadata: WorkflowMetadata): void {
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

/**
 * Title-case a camelCase or kebab-case string for auto-label fallback.
 * `employeeName` → `Employee Name`, `empl-id` → `Empl Id`.
 */
export function autoLabel(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Normalize a `WorkflowConfig.detailFields` entry (string or labeled) into the
 * wire shape `{ key, label }`. Exported for tests and for `defineWorkflow`'s
 * metadata construction.
 */
export function normalizeDetailField(
  entry: string | { key: string; label: string },
): { key: string; label: string } {
  if (typeof entry === 'string') return { key: entry, label: autoLabel(entry) }
  return entry
}
