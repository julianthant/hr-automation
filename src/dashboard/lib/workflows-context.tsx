import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js"
import type { WorkflowPresentationConfig } from "../../domain/workflow-presentation/types.js"

export interface WorkflowMetadata {
  name: string
  /** Human-readable label (server-derived from `defineWorkflow.label` or auto-title-cased name). */
  label: string
  /**
   * Display category for `WorkflowRail` grouping (e.g. "Onboarding", "Utils").
   * Absent → the workflow lands in the rail's "Other" group. Source:
   * `defineWorkflow({ category: "..." })`.
   */
  category?: string
  /**
   * Lucide-react icon name for the workflow's `WorkflowBox` session card.
   * Absent → the frontend's icon registry falls back to the generic `Workflow`
   * icon and logs a warning. Source: `defineWorkflow({ iconName: "..." })`.
   */
  iconName?: string
  steps: string[]
  systems: string[]
  /**
   * Labeled detailFields from /api/workflow-definitions.
   *   - `editable: true`        → field renders in the Edit Data tab.
   *   - `displayInGrid: false`  → field is hidden from LogPanel's detail grid
   *                                (still shown in Edit Data when editable).
   *   - `inputKind`             → Edit Data control: `id` (mono) / `date`
   *                                (calendar popover) / `text` (default).
   *   - `group`                 → Edit Data section label the field is grouped under.
   */
  detailFields: Array<{ key: string; label: string; editable?: boolean; displayInGrid?: boolean; multiline?: boolean; conditional?: boolean; inputKind?: "text" | "id" | "date"; group?: string }>
  /**
   * Field key used by the EditDataTab's "Copy from prior run" lookup.
   * When set (e.g. `"eid"` for separations), the EditDataTab surfaces a
   * "Find prior" button when the current entry has a populated value at
   * `data[matchKey]`, letting the operator pull a previous run's data
   * forward instead of re-typing it.
   */
  matchKey?: string
  /** Serializable workflow runtime policy for queue projections/actions. */
  runtimePolicy?: WorkflowRuntimePolicy
  /**
   * Named run-mode presets for the InputRunPanel gear menu. Each entry maps
   * an operator label to a set of step names to skip. The implicit "Full"
   * preset (no skips) is synthesized client-side; absent presets → no gear
   * icon. Source: `defineWorkflow({ presets: [...] })`.
   */
  presets?: Array<{ id: string; label: string; skipSteps: string[]; description?: string }>
  /**
   * Effective presentation config (naming/steps/delegation), server-derived
   * from `defineWorkflow.presentation` deep-merged over the metadata defaults.
   * `presentation.steps` drives the StepPipeline's config-based step folding
   * and per-step label overrides. Source: `/api/workflow-definitions`.
   */
  presentation?: WorkflowPresentationConfig
}

const WorkflowsContext = createContext<WorkflowMetadata[] | null>(null)

function isWorkflowMetadata(item: unknown): item is WorkflowMetadata {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false
  const o = item as Record<string, unknown>
  if (typeof o.name !== "string") return false
  if (typeof o.label !== "string") return false
  if (!Array.isArray(o.steps) || !o.steps.every((s) => typeof s === "string")) return false
  if (!Array.isArray(o.systems) || !o.systems.every((s) => typeof s === "string")) return false
  if (!Array.isArray(o.detailFields)) return false
  for (const field of o.detailFields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false
    const f = field as Record<string, unknown>
    if (typeof f.key !== "string" || typeof f.label !== "string") return false
  }
  if (o.category !== undefined && typeof o.category !== "string") return false
  if (o.iconName !== undefined && typeof o.iconName !== "string") return false
  if (o.matchKey !== undefined && typeof o.matchKey !== "string") return false
  if (
    o.runtimePolicy !== undefined &&
    (!o.runtimePolicy || typeof o.runtimePolicy !== "object" || Array.isArray(o.runtimePolicy))
  ) return false
  if (o.presets !== undefined) {
    if (!Array.isArray(o.presets)) return false
    for (const preset of o.presets) {
      if (!preset || typeof preset !== "object" || Array.isArray(preset)) return false
      const p = preset as Record<string, unknown>
      if (typeof p.id !== "string" || typeof p.label !== "string") return false
      if (!Array.isArray(p.skipSteps) || !p.skipSteps.every((s) => typeof s === "string")) return false
      if (p.description !== undefined && typeof p.description !== "string") return false
    }
  }
  if (
    o.presentation !== undefined &&
    (!o.presentation || typeof o.presentation !== "object" || Array.isArray(o.presentation))
  ) return false
  return true
}

export function parseWorkflowDefinitionsResponse(data: unknown): WorkflowMetadata[] {
  if (!Array.isArray(data)) {
    throw new Error(`workflow-definitions: expected array, got ${typeof data}`)
  }
  const validated: WorkflowMetadata[] = []
  for (const item of data) {
    if (isWorkflowMetadata(item)) {
      validated.push(item)
    } else {
      console.warn("workflow-definitions: skipping malformed entry", item)
    }
  }
  return validated
}

export function WorkflowsProvider({ children }: { children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowMetadata[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    fetch("/api/workflow-definitions")
      .then(async (r) => {
        if (!r.ok) throw new Error(`workflow-definitions: HTTP ${r.status}`)
        const data: unknown = await r.json()
        return parseWorkflowDefinitionsResponse(data)
      })
      .then(setWorkflows)
      .catch((e: Error) => setError(e.message))
  }, [retryToken])

  if (error) {
    return (
      <div className="p-6 text-sm">
        <div className="mb-3">Failed to load workflow config: {error}</div>
        <button
          type="button"
          onClick={() => {
            setError(null)
            setWorkflows(null)
            setRetryToken((value) => value + 1)
          }}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!workflows) return <div>Loading…</div>
  return <WorkflowsContext.Provider value={workflows}>{children}</WorkflowsContext.Provider>
}

export function useWorkflows(): WorkflowMetadata[] {
  const ctx = useContext(WorkflowsContext)
  if (!ctx) throw new Error("useWorkflows must be used inside WorkflowsProvider")
  return ctx
}

export function useWorkflow(name: string): WorkflowMetadata | undefined {
  return useWorkflows().find((w) => w.name === name)
}

/**
 * Auto-title-case fallback for workflows that don't have metadata yet (still
 * loading, or the backend hasn't seen the registration yet). Matches the
 * server-side `autoLabel` helper in `src/core/registry.ts` so the UI doesn't
 * flicker between "kronos-reports" and "Kronos Reports" during load.
 */
export function autoLabel(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}
