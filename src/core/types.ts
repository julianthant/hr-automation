import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { log } from '../utils/log.js'

export interface SystemConfig {
  id: string
  login: (page: Page, instance?: string) => Promise<void>
  sessionDir?: string
  resetUrl?: string
}

/**
 * Observability bundle passed to `Session.launch`. The kernel invokes these
 * hooks around browser launch and `loginWithRetry`, giving the tracker
 * (set via `runWorkflow`) a chance to emit `session_create / browser_launch /
 * auth_start / auth_complete / auth_failed` events and flip the tracker entry
 * to `running` before the handler body starts.
 *
 * `instance` is forwarded as the 2nd arg to `system.login(page, instance)` so
 * login flows can use `requestDuoApproval` (event-emitting) instead of the
 * silent `pollDuoApproval` fallback.
 *
 * All fields are optional. Callers that pass `{}` (or no observer at all) get
 * today's behavior.
 */
export interface SessionObserver {
  /** Workflow-instance name for Duo queue correlation. */
  instance?: string
  /** Fires once per system after its browser is ready. */
  onBrowserLaunch?: (systemId: string, browserId: string) => void
  /** Fires before the first auth attempt for a system. Retries do NOT re-fire. */
  onAuthStart?: (systemId: string, browserId: string) => void
  /** Fires after successful login (possibly after retries). */
  onAuthComplete?: (systemId: string, browserId: string) => void
  /** Fires once when all retry attempts have failed. */
  onAuthFailed?: (systemId: string, browserId: string) => void
}

export interface BatchConfig {
  mode: 'sequential' | 'pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}

/**
 * Labeled or legacy `detailFields` entry. The registry normalizes both shapes
 * into `{ key, label }` for the dashboard — workflows can continue to declare
 * plain `string[]` (auto-title-cased label) or upgrade to the explicit shape.
 */
export type DetailField<TData> =
  | (keyof TData & string)
  | { key: string; label: string }

export interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string
  version?: string
  /** Human-readable workflow label for the dashboard (e.g. "Onboarding"). */
  label?: string
  systems: SystemConfig[]
  steps: TSteps
  schema: ZodType<TData>
  tiling?: 'auto' | 'single' | 'side-by-side'
  authChain?: 'sequential' | 'interleaved'
  batch?: BatchConfig
  /**
   * When true (default), the kernel auto-prepends `auth:<id>` step names to
   * the declared `steps` tuple for each entry in `systems`. Set to `false`
   * for workflows that already declare their own auth step names
   * (e.g. onboarding's `crm-auth`, `ucpath-auth`) until they migrate.
   */
  authSteps?: boolean
  /**
   * Dashboard detail-panel fields — either plain keys (legacy) or labeled
   * entries (preferred). Legacy keys get auto-title-cased labels in the
   * registry (`emplId` → `Empl Id`). Only labeled entries are enforced by
   * the runtime warning for missing `updateData` populations.
   */
  detailFields?: Array<DetailField<TData>>
  /**
   * Derive a display name from accumulated tracker data (already stringified
   * `Record<string, string>`). Called server-side on each emit; result lands
   * in `data.__name` for the dashboard to read.
   */
  getName?: (data: Record<string, string>) => string
  /**
   * Derive a display id from accumulated tracker data. Falls back to the
   * tracker `TrackerEntry.id` on the dashboard if this returns an empty string.
   */
  getId?: (data: Record<string, string>) => string
  /**
   * Seed the tracker `data` record from input BEFORE the initial `pending`
   * entry is emitted. Use this to stamp display-name hints that are knowable
   * from input alone (e.g. the searched names for eid-lookup), so the queue
   * shows something meaningful during the auth window — handler-side
   * `ctx.updateData(...)` doesn't run until auth completes.
   *
   * Result is merged into `data` before `pending` fires; subsequent
   * `updateData` calls in the handler take precedence.
   */
  initialData?: (input: TData) => Record<string, unknown>
  handler: (ctx: Ctx<TSteps, TData>, data: TData) => Promise<void>
}

export interface RetryOpts {
  /** Max attempts including the first. Default 3. */
  attempts?: number
  /** Linear backoff base in ms. Attempt N waits `backoffMs * (N-1)` before retrying. Default 1000. */
  backoffMs?: number
  /** Callback fired after every thrown attempt (success branch does NOT fire it). */
  onAttempt?: (attempt: number, err: unknown) => void
}

export interface Ctx<TSteps extends readonly string[], TData> {
  page(id: string): Promise<Page>
  step<R>(name: TSteps[number], fn: () => Promise<R>): Promise<R>
  markStep(name: TSteps[number]): void
  parallel<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }>
  parallelAll<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>
  retry<R>(fn: () => Promise<R>, opts?: RetryOpts): Promise<R>
  updateData(patch: Partial<TData & Record<string, unknown>>): void
  session: SessionHandle
  log: typeof log
  isBatch: boolean
  runId: string
  /**
   * Capture all open pages as PNGs, emit a `screenshot` tracker event, and
   * return the capture record. Constructed by `makeCtx` via `makeScreenshotFn`.
   */
  screenshot: ScreenshotFn
}

export interface SessionHandle {
  page(id: string): Promise<Page>
  newWindow(id: string): Promise<Page>
  closeWindow(id: string): Promise<void>
}

export interface WorkflowMetadata {
  name: string
  /** Human-readable workflow label for the dashboard (auto-derived from `name` when absent). */
  label: string
  steps: readonly string[]
  systems: string[]
  /** Normalized labeled detailFields — always `{ key, label }` on the wire. */
  detailFields: Array<{ key: string; label: string }>
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
  /**
   * Per-item itemId deriver — used by batch/pool modes when the built-in `deriveItemId`
   * (which looks at top-level `emplId`/`docId`/`email`) isn't expressive enough. Called
   * once per item before the pending emit. Must return the same string the caller's
   * `onPreEmitPending` uses, or the dashboard will show two rows per record.
   */
  deriveItemId?: (item: unknown) => string
  /** Override tracker directory — defaults to `.tracker`. Mainly for test isolation. */
  trackerDir?: string
  /**
   * Override the workflow's `batch.poolSize` config at runtime. Used by CLIs
   * exposing `--workers N` flags — e.g. `npm run kronos -- --workers 2` calls
   * `runWorkflowBatch(wf, items, { poolSize: 2 })` to override the default.
   * Ignored outside of pool-mode batch runs.
   */
  poolSize?: number
}

// Placeholder types — fully defined in Phase 2 (Task 7). Keep in sync.
export interface ScreenshotOpts {
  kind: 'form' | 'error' | 'manual'
  label: string
  systems?: string[]
  pages?: import('playwright').Page[]
}
export interface ScreenshotCapture {
  kind: 'form' | 'error' | 'manual'
  label: string
  step: string | null
  ts: number
  files: Array<{ system: string; path: string }>
}
export type ScreenshotFn = (opts: ScreenshotOpts) => Promise<ScreenshotCapture>

/** Inputs to Session.captureAll — Layer 1 filename producer. */
export interface CaptureFileOpts {
  workflow: string
  itemId: string
  kind: 'form' | 'error' | 'manual'
  label: string
  ts: number
  systems?: string[]
  pages?: Page[]
}
