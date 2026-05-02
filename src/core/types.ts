import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { log } from '../utils/log.js'

export interface SystemConfig {
  id: string
  login: (page: Page, instance?: string) => Promise<void>
  /**
   * Optional "pre-flight" phase: navigate + fill credentials without
   * submitting. When provided, `Session.launch` runs this for EVERY
   * system in parallel immediately after browsers open and BEFORE the
   * sequential Duo chain begins. Then each system's `login` only needs
   * to click Submit + wait for Duo — saving 3–8 seconds of navigation
   * per system on the total session spin-up time.
   *
   * Implementation MUST be idempotent — `login` is expected to detect a
   * stale SSO form (Shibboleth anti-CSRF expired while waiting for
   * upstream Duos) and re-invoke this preparer automatically.
   *
   * Throw to signal a hard preparation failure; auth will still try
   * `login` (which may succeed via re-prepare) before failing the item.
   */
  prepareLogin?: (page: Page) => Promise<void>
  sessionDir?: string
  resetUrl?: string
  /**
   * Opt into Playwright download capture for this system's browser context.
   * Must be `true` before any handler calls `download.saveAs(...)` — otherwise
   * Playwright throws `Pass { acceptDownloads: true } when you are creating
   * your browser context`. Default `false`.
   */
  acceptDownloads?: boolean
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
  /** Fires once per system after its browser is ready. `chromiumPid` is
   * the OS pid of the Chromium process Playwright launched, used by the
   * dashboard's force-stop path to SIGKILL orphaned browsers when the Node
   * parent dies. Undefined if the underlying Browser handle didn't expose a
   * pid (rare — happens with some custom Playwright transports). */
  onBrowserLaunch?: (systemId: string, browserId: string, chromiumPid?: number) => void
  /** Fires before the first auth attempt for a system. Retries do NOT re-fire. */
  onAuthStart?: (systemId: string, browserId: string) => void
  /** Fires after successful login (possibly after retries). */
  onAuthComplete?: (systemId: string, browserId: string) => void
  /** Fires once when all retry attempts have failed. */
  onAuthFailed?: (systemId: string, browserId: string) => void
}

export interface BatchConfig {
  mode: 'sequential' | 'pool' | 'shared-context-pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}

/**
 * Labeled or legacy `detailFields` entry. The registry normalizes both shapes
 * into `{ key, label, editable, displayInGrid }` for the dashboard — workflows
 * can continue to declare plain `string[]` (auto-title-cased label,
 * non-editable, default-displayed) or upgrade to the explicit shape with
 * optional flags:
 *   - `editable: true`        → opts the field into the dashboard's Edit Data tab.
 *   - `displayInGrid: false`  → hides the field from LogPanel's detail grid
 *                                (still rendered in the Edit Data tab when editable).
 *
 * The two flags are independent: a field can be edit-only (off in grid, on in
 * edit form), display-only (default — on in grid, off in edit form), both, or
 * declared but hidden everywhere (rare, mostly useful for tracker-only data).
 */
export type DetailField<TData> =
  | (keyof TData & string)
  | { key: string; label: string; editable?: boolean; displayInGrid?: boolean; multiline?: boolean }

export interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string
  version?: string
  /** Human-readable workflow label for the dashboard (e.g. "Onboarding"). */
  label?: string
  /**
   * Display category for the dashboard's `WorkflowRail` grouping
   * (e.g. "Onboarding", "Separations", "Utils"). Workflows with the same
   * category render under one group header. Workflows that omit this field
   * fall into the rail's "Other" group. The rail orders categories via a
   * frontend-side preferred-order list (alphabetical for unknowns), so adding
   * a new category here is a one-line declaration with no rail edits required.
   */
  category?: string
  /**
   * Lucide-react icon name (e.g. "Users", "UserMinus", "Search") for the
   * dashboard's `WorkflowBox` session card. Resolved against a small static
   * import map on the frontend; missing names fall back to the generic
   * `Workflow` icon and log a `console.warn` in dev. Adding a workflow with
   * an unfamiliar icon requires one entry in `lib/workflow-icons.ts`.
   */
  iconName?: string
  systems: SystemConfig[]
  steps: TSteps
  schema: ZodType<TData>
  authChain?: 'sequential' | 'interleaved' | 'parallel-staggered'
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
   * Data-field key used by the dashboard's "Copy from prior run" affordance
   * in EditDataTab. When set (e.g. `"eid"` for separations, `"email"` for
   * onboarding), the EditDataTab shows a "Find prior" button when the
   * current entry has a populated `data[matchKey]`. Clicking surfaces past
   * runs of the SAME workflow that share the same `data[matchKey]` value
   * but a different itemId, and lets the operator copy that prior run's
   * data into the current edit form. Designed for the "two doc IDs, one
   * employee" pattern: the second separation form for the same person can
   * pull the first's extracted/edited values forward instead of being
   * filled from scratch.
   */
  matchKey?: string
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

/**
 * Thrown by `Stepper.step` when the daemon's cancel-current flag is set
 * for the currently-in-flight item, BEFORE the stepper invokes the wrapped
 * `fn`. Carries the would-be-step's name so the caller (runOneItem) can
 * surface "Cancelled before step '<X>'" in the failed tracker row.
 *
 * Distinct from regular Errors so kernel + daemon paths can branch on it:
 *   - `Stepper.step` throws WITHOUT calling `emitFailed` or `screenshotFn`
 *     (no diagnostic capture for an intentional cancel)
 *   - `runOneItem` returns `{ ok: false, kind: "cancelled", error: ... }`
 *     instead of the generic failed-shape
 *   - daemon's claim loop, on `kind === "cancelled"`, resets every
 *     system's page to its `resetUrl` before claiming the next item
 */
export class CancelledError extends Error {
  readonly cancelled = true as const
  constructor(public readonly stepName: string) {
    super(`Cancelled by user before step '${stepName}'`)
    this.name = 'CancelledError'
  }
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
  /**
   * Announce that a step is intentionally bypassed (e.g. extracted data was
   * pre-populated by an edit-and-resume run, so extraction need not run).
   * Emits a `skipped` tracker row for that step name. Updates `currentStep`
   * the same way `markStep` does, so subsequent step transitions advance the
   * pipeline correctly.
   */
  skipStep(name: TSteps[number]): void
  /**
   * Snapshot of the accumulated tracker data as written so far via
   * `updateData(...)`. Includes anything the kernel pre-merged from the
   * input's `prefilledData` channel (edit-and-resume), so handlers can
   * gate steps on data presence (`if (!ctx.data.foo) await ctx.step(...)`).
   * Returns a fresh shallow copy each access; mutating it has no effect.
   */
  readonly data: Record<string, unknown>
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
  /** Dashboard-rail grouping (e.g. "Onboarding"). Absent → workflow lands in the rail's "Other" group. */
  category?: string
  /** Lucide-react icon name for `WorkflowBox`. Absent → frontend falls back to the generic `Workflow` icon. */
  iconName?: string
  steps: readonly string[]
  systems: string[]
  /**
   * Normalized labeled detailFields — always `{ key, label, editable?, displayInGrid? }`
   * on the wire. `editable` and `displayInGrid` are omitted when they
   * match the default (false + true respectively).
   */
  detailFields: Array<{ key: string; label: string; editable?: boolean; displayInGrid?: boolean; multiline?: boolean }>
  /**
   * Data-field key for the dashboard's "Copy from prior run" lookup in
   * EditDataTab. See `WorkflowConfig.matchKey` for the full contract.
   */
  matchKey?: string
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
  /** When set, every TrackerEntry emitted for this run carries `parentRunId`. */
  parentRunId?: string
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
