import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { log } from '../utils/log.js'

export interface SystemConfig {
  id: string
  login: (page: Page, instance?: string) => Promise<void>
  sessionDir?: string
  resetUrl?: string
}

export interface BatchConfig {
  mode: 'sequential' | 'pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}

export interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string
  version?: string
  systems: SystemConfig[]
  steps: TSteps
  schema: ZodType<TData>
  tiling?: 'auto' | 'single' | 'side-by-side'
  authChain?: 'sequential' | 'interleaved'
  batch?: BatchConfig
  detailFields?: Array<keyof TData & string>
  handler: (ctx: Ctx<TSteps, TData>, data: TData) => Promise<void>
}

export interface Ctx<TSteps extends readonly string[], TData> {
  page(id: string): Promise<Page>
  step<R>(name: TSteps[number], fn: () => Promise<R>): Promise<R>
  parallel<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }>
  updateData(patch: Partial<TData & Record<string, unknown>>): void
  session: SessionHandle
  log: typeof log
  isBatch: boolean
  runId: string
}

export interface SessionHandle {
  page(id: string): Promise<Page>
  newWindow(id: string): Promise<Page>
  closeWindow(id: string): Promise<void>
}

export interface WorkflowMetadata {
  name: string
  steps: readonly string[]
  systems: string[]
  detailFields: string[]
}

export interface RegisteredWorkflow<TData, TSteps extends readonly string[]> {
  config: WorkflowConfig<TData, TSteps>
  metadata: WorkflowMetadata
}

export interface BatchResult {
  total: number
  succeeded: number
  failed: number
  errors: Array<{ item: unknown; error: string }>
}

export interface RunOpts {
  itemId?: string
  preAssignedRunId?: string
  launchFn?: (opts: {
    system: SystemConfig
    tileIndex: number
    tileCount: number
    tiling: 'auto' | 'single' | 'side-by-side'
  }) => Promise<{ page: import('playwright').Page; context: import('playwright').BrowserContext; browser: import('playwright').Browser }>
  /** Skip withLogContext + withTrackedWorkflow wrapping (tests — use no-op emitters). */
  trackerStub?: boolean
  /**
   * Called once per item before the loop starts — receives the item plus the pre-generated
   * `runId` that will be used for that item's `withTrackedWorkflow` run. Allows callers to
   * emit an initial `pending` tracker entry with the matching `runId`; `withTrackedWorkflow`
   * will then skip its own pending emit (see `preAssignedRunId` branch).
   */
  onPreEmitPending?: (item: unknown, runId: string) => void
  /** Override tracker directory — defaults to `.tracker`. Mainly for test isolation. */
  trackerDir?: string
}
