import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export interface WorkflowMetadata {
  name: string
  /** Human-readable label (server-derived from `defineWorkflow.label` or auto-title-cased name). */
  label: string
  steps: string[]
  systems: string[]
  /** Labeled detailFields — always `{ key, label }` from /api/workflow-definitions. */
  detailFields: Array<{ key: string; label: string }>
}

const WorkflowsContext = createContext<WorkflowMetadata[] | null>(null)

export function WorkflowsProvider({ children }: { children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowMetadata[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/workflow-definitions")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setWorkflows)
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <div>Failed to load workflow config: {error}</div>
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
