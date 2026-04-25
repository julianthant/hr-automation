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
 * Domain acronyms that should stay all-caps in auto-labels. Without this
 * list, `eid-lookup` would render as `Eid Lookup` (the `\b\w` title-case
 * fallback) instead of the desired `EID Lookup`. Workflow files set their
 * own `label` explicitly, but the registry-not-loaded-yet first-paint
 * falls through to autoLabel — so the fallback should look right too.
 */
const ACRONYMS: ReadonlySet<string> = new Set([
  'EID', 'CRM', 'I9', 'HR', 'UCSD', 'UKG', 'SSO', 'API', 'CSV', 'PDF',
  'UC', 'WFD', 'UCPATH', 'PII', 'URL', 'JSON', 'YAML',
])

/**
 * Title-case a camelCase or kebab-case string for auto-label fallback.
 * `employeeName` → `Employee Name`, `empl-id` → `Empl Id`,
 * `eid-lookup` → `EID Lookup` (acronym preserved).
 */
export function autoLabel(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map((word) => {
      if (!word) return word
      const upper = word.toUpperCase()
      if (ACRONYMS.has(upper)) return upper
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
    .trim()
}

/**
 * Normalize a `WorkflowConfig.detailFields` entry (string or labeled) into the
 * wire shape `{ key, label, editable? }`. Exported for tests and for
 * `defineWorkflow`'s metadata construction. String entries default to
 * non-editable (the legacy shape predates the edit-and-resume opt-in).
 */
export function normalizeDetailField(
  entry: string | { key: string; label: string; editable?: boolean },
): { key: string; label: string; editable?: boolean } {
  if (typeof entry === 'string') return { key: entry, label: autoLabel(entry) }
  // Drop `editable: false` from the wire shape so default rows stay compact;
  // only `true` rides through.
  return entry.editable
    ? { key: entry.key, label: entry.label, editable: true }
    : { key: entry.key, label: entry.label }
}
