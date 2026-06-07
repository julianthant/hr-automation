import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { OperatorSubject } from '../../domain/operator-subject.js'
import type { log } from '../../utils/log.js'
import type { WorkflowArchetype, WorkflowArchetypeOrResolver } from '../../domain/row-archetype.js'
import type { QueueRowKindOrResolver, InputSubjectOrResolver } from '../../domain/queue-row-kind.js'
import type { WorkflowStatusExtensions } from '../../domain/queue-row-status.js'
import type { WorkflowRuntimePolicy } from '../../domain/workflow-runtime/types.js'

export interface SystemConfig {
  id: string
  login: (
    page: Page,
    instance?: string,
    context?: { abortSignal?: AbortSignal },
  ) => Promise<void>
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
  /** Idle-refresh observability (per system) — wired to session JSONL for the dashboard countdown ring. */
  onIdleTouch?: (systemId: string) => void
  onIdleRefresh?: (systemId: string, phase: 'start' | 'end') => void
}

export interface BatchConfig {
  mode: 'sequential' | 'pool' | 'shared-context-pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset'>
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

export type WorkflowQueueTitleConfig<TData> =
  | { kind: 'single' }
  | { kind: 'batch'; label?: string; labelFromInput?: (input: TData) => string | undefined }

/**
 * Named "run mode" preset for a workflow. Surfaced in the dashboard's input-run
 * gear menu so the operator can pick a non-default execution profile (e.g.
 * "Transactions only" → skip Kronos search + UCPath Job Summary). The kernel
 * routes the selected `skipSteps` through `ctx.shouldSkipStep(name)`; handlers
 * must explicitly OR the check into their existing skip branches.
 *
 * The implicit default preset (no skips, label "Full") is synthesized by the
 * dashboard when this list is non-empty — workflow files only declare the
 * non-default presets. Empty/omitted `presets` → no gear icon for that workflow.
 *
 * Each `skipSteps` entry must be a member of `WorkflowConfig.steps` (the
 * workflow's declared handler-step list, NOT auth steps). Enforced at type
 * level via `TSteps[number]` and at runtime via the registry validator.
 */
export interface WorkflowStepPreset<TSteps extends readonly string[]> {
  /** Stable identifier (e.g. "transactions-only"). Used as `data.__preset` and over the wire. */
  id: string
  /** Operator-facing label (e.g. "Transactions only"). */
  label: string
  /** Steps the handler should treat as skipped when this preset is active. */
  skipSteps: ReadonlyArray<TSteps[number]>
  /** Optional one-line tooltip / description rendered under the label. */
  description?: string
}

/** Wire-shape preset (post-registry normalization). `skipSteps` is plain `string[]`. */
export interface WorkflowStepPresetMetadata {
  id: string
  label: string
  skipSteps: string[]
  description?: string
}

export interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string
  version?: string
  /** Human-readable workflow label for the dashboard (e.g. "Onboarding"). */
  label?: string
  /** Declarative row shape. Defaults to "batch" if `batch` is set, else "single". */
  archetype?: WorkflowArchetypeOrResolver<TData>
  /**
   * What this workflow receives as input — `name | eid | email | kualiId |
   * pdf | selector`. Either a literal or a resolver `(input) => subject` for
   * input-variant workflows (e.g. oath-signature: `pdf` → pdf, `eid` → eid).
   * The presentation `queueRowKind` (person/file/catalog) is *derived* from
   * this; workflows do not declare `queueRowKind` directly. Orthogonal to
   * `archetype` (shape) and `parentRunId` (scope). See `domain/queue-row-kind.ts`.
   * Optional in the type (defaults to `name` → person); the
   * `queue-row-kind-coverage` architecture guard enforces an explicit
   * declaration on every real workflow.
   */
  inputSubject?: InputSubjectOrResolver<TData>
  /**
   * Optional per-workflow queue-row **status** rules — the status axis,
   * orthogonal to `queueRowKind` (title/subtitle). Lets a workflow promote a
   * row to a workflow-specific derived display status (e.g. person-lookup
   * `notFound`, OCR `needsReview`) and/or render a supplemental status chip
   * (e.g. person-lookup's A/IA tag), instead of teaching the generic dashboard
   * `EntryItem` component to branch on `entry.workflow`. Omitted → the row uses
   * the default base-status behavior unchanged. See `domain/queue-row-status.ts`.
   */
  statusExtensions?: WorkflowStatusExtensions
  /**
   * Short (2-char) workflow code used as the provenance prefix of a row's
   * trace id (`<code>-<mmddyyHHMMSS>-<runId4>`, see `domain/queue-trace-id.ts`)
   * and as the daemon instance prefix. Must be unique across workflows.
   * Defaults to the first two letters of `name` when omitted.
   */
  code?: string
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
  /**
   * Global queue-row title policy. This only controls display titles today,
   * but it is intentionally metadata so future queue naming surfaces can
   * reuse the same classification.
   */
  queueTitle?: WorkflowQueueTitleConfig<TData>
  /**
   * Serializable dashboard/runtime policy for row projection and action
   * blast-radius rules. Workflow files own their overrides; the dashboard
   * receives this through workflow metadata.
   */
  runtimePolicy?: WorkflowRuntimePolicy
  /**
   * Optional named "run mode" presets surfaced in the dashboard's input-run
   * gear menu. Empty/omitted → no gear icon. The implicit default "Full"
   * preset (no skips) is synthesized by the dashboard when this is non-empty.
   * The handler must opt into honoring each preset's `skipSteps` entry via
   * `ctx.shouldSkipStep(name)`; the kernel only carries the selection.
   */
  presets?: ReadonlyArray<WorkflowStepPreset<TSteps>>
  /**
   * Derive a stable tracker/queue item id from raw workflow input. The kernel
   * has a generic top-level id/docId/email fallback, but dashboard HTTP
   * launches and daemon queue rows need workflow-specific ids for inputs like
   * person-name searches where the natural key is not one of those fields.
   */
  deriveItemId?: (input: TData) => string
  /**
   * Derive the operator-facing subject from raw workflow input before auth or
   * handler execution. This label is used by queue rows, toasts, task rows,
   * and later SQLite projections.
   */
  operatorSubject?: (input: TData) => OperatorSubject | null | undefined
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

/** See `src/core/delegate.ts` for the delegation API + `renderAs` semantics. */
export type DelegateRenderAs = "batch" | "preview" | "flat"

export interface DelegateOpts {
  /**
   * Projection hint for delegated rows. The child row's stamped archetype
   * still comes from the child workflow's resolved shape (`single` / `batch`)
   * plus the top-level `parentRunId` scope.
   *   - "flat"    → flat single row
   *   - "preview" → preview card row
   *   - "batch"   → grouped delegation member
   */
  renderAs?: DelegateRenderAs
  /**
   * Don't await the child. Returns immediately after the pending row is
   * emitted and the child is enqueued / launched. The returned
   * `ChildRunResult` carries `status: "pending"` and no terminal data.
   * Default: false.
   */
  fireAndForget?: boolean
  /** Pre-assign the child itemId (tests, deterministic ids). */
  itemId?: string
  /** Pre-assign the child runId (tests, deterministic ids). */
  runId?: string
}

export interface DelegateAllOpts extends DelegateOpts {
  /**
   * Max concurrent child runs. Only honored when the child is NOT
   * daemon-capable (in-process pool path). Default: all inputs run
   * concurrently. Daemon-capable children always use the daemon's own
   * scheduling.
   */
  concurrency?: number
}

// `_TChildData` is the input/output shape used by the parent for return-type
// inference at call sites; the result fields themselves are workflow-agnostic
// (string-stringified tracker data + error message), so the type parameter is
// not consumed inside the interface body.
export interface ChildRunResult<_TChildData> {
  workflow: string
  runId: string
  itemId: string
  /** `"pending"` only when `fireAndForget: true`. */
  status: "done" | "failed" | "cancelled" | "pending"
  /** Final accumulated tracker data when `status === "done"`. */
  data?: Record<string, string>
  /** Error details when `status === "failed"` / `"cancelled"`. */
  error?: { message: string; step?: string }
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
   * True when the caller (dashboard step-preset gear, future CLI flag, etc.)
   * requested this step be skipped via the `runtimeOptions.skipSteps` channel.
   * Pair with `ctx.skipStep(name)` inside the handler's existing skip branches:
   *
   *   if (somePrefillCheck || ctx.shouldSkipStep("kronos-search")) {
   *     ctx.skipStep("kronos-search")
   *     // ...provide fallback values for any downstream code...
   *   } else {
   *     await ctx.step("kronos-search", () => ...)
   *   }
   *
   * The kernel does NOT auto-bypass `ctx.step(name, fn)` calls — handlers are
   * responsible for substituting fallback values (e.g. carrying the field
   * forward from a prior step) because step bodies frequently set closure
   * variables that downstream code consumes.
   */
  shouldSkipStep(name: TSteps[number]): boolean
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
   * Delegated scope: the parent run's id when this run was spawned via
   * `delegateTo`/`delegateToAll`, else `undefined`. The kernel stamps it on the
   * rows it emits; it's surfaced here so a handler that owns its own tracker
   * emission (today only OCR) can re-stamp `parentRunId` on every self-emitted
   * row — otherwise the dashboard's latest-wins dedupe sees the handler's
   * unstamped rows and treats a delegated row as standalone.
   */
  parentRunId?: string
  /**
   * Per-run `AbortSignal` sourced from the kernel's per-item `AbortController`.
   * Flips to `aborted` when an operator-issued cancel reaches the daemon /
   * scenario runtime for this run. The signal is auto-injected into every
   * Playwright method that accepts a `signal` option via the `ctx.page(id)`
   * proxy (see `src/core/kernel/page-proxy.ts`), so in-flight `waitForSelector`
   * / `click` / `goto` / etc. reject within milliseconds of cancel rather than
   * blocking on their declared timeout. Workflow handlers can also pass it to
   * any non-Playwright await that accepts an AbortSignal (`fetch`, `setTimeout`,
   * custom helpers) for uniform fast cancel.
   *
   * The kernel's `Stepper`/error remapper translates the resulting AbortError
   * into a `CancelledError` so the terminal row carries `step: "cancelled"` and
   * the daemon's claim loop treats the run as cancelled (browser preserved,
   * post-cancel reset fires, next item claimed) instead of failed.
   */
  signal: AbortSignal
  /**
   * Capture all open pages as PNGs, emit a `screenshot` tracker event, and
   * return the capture record. Constructed by `makeCtx` via `makeScreenshotFn`.
   */
  screenshot: ScreenshotFn
  /**
   * Best-effort form screenshot helper used by workflows that need a captured
   * filename mirrored into tracker data for downstream verification panels.
   *
   * Pass `opts.systems` to restrict the capture to specific system page(s)
   * (e.g. `["ucpath"]`) — the stamped filename is the one for that system, not
   * a blind `files[0]`. Omitting it captures every open page (default).
   */
  captureAndStampScreenshot(
    label: string,
    dataKey: string,
    opts?: { systems?: string[] },
  ): Promise<void>
  /**
   * Tracker directory for this run (from `RunOpts.trackerDir`). Orchestrators and
   * nested `runWorkflow` calls must use this so isolated test dirs aren't mixed
   * with `.tracker`.
   */
  trackerDir?: string
  /**
   * The session-drawer instance name owning this run (e.g. "OCR 1",
   * "Oath Signature 1"). Allocated by the kernel; surfaced so a handler that
   * emits its own progress (OCR) can drive the session timeline via
   * `reportPhase`. Undefined in trackerStub/test runs.
   */
  workflowInstance?: string
  /**
   * Push a phase into the **session-drawer timeline** (the terminal-drawer
   * `WorkflowBox`) without emitting a queue row. The first call also marks the
   * run's session item in-flight. Repeated calls with the same phase are
   * coalesced. For handlers that own their own queue-row emission and so
   * bypass `ctx.step` (today: OCR) — every other handler drives the timeline
   * for free through `ctx.step`/`ctx.markStep`. No-op when `workflowInstance`
   * is absent.
   */
  reportPhase(step: string): void
  /**
   * Delegate to a single child workflow. The kernel stamps `parentRunId`
   * from `ctx.runId`, pre-emits the child's pending row through
   * `emitTrackerRow` with archetype stamped (Contract 1), persists the
   * pristine input on the pending row's `input` field (Contract 2 tier
   * 2), runs the child in-process via `runWorkflow`, and returns a
   * typed `ChildRunResult` with the child's terminal status. Use
   * `delegateToAll` for daemon-dispatched fan-out across N inputs.
   */
  delegateTo<TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    input: TChildData,
    opts?: DelegateOpts,
  ): Promise<ChildRunResult<TChildData>>
  /**
   * Delegate to N child workflow runs. Dispatches via
   * `ensureDaemonsAndEnqueue` when the child is daemon-capable
   * (registered in `WORKFLOW_LOADERS`); otherwise iterates `runWorkflow`
   * with the supplied `concurrency`. Awaits all child terminal statuses
   * via `watchChildRuns` (daemon path) or per-run promises (in-process
   * path) unless `fireAndForget: true`.
   */
  delegateToAll<TChildData, TChildSteps extends readonly string[]>(
    child: RegisteredWorkflow<TChildData, TChildSteps>,
    inputs: readonly TChildData[],
    opts?: DelegateAllOpts,
  ): Promise<ChildRunResult<TChildData>[]>
}

export interface SessionHandle {
  page(id: string): Promise<Page>
}

export interface WorkflowMetadata {
  name: string
  /** Human-readable workflow label for the dashboard (auto-derived from `name` when absent). */
  label: string
  archetype: WorkflowArchetype
  /** 2-char workflow code — provenance prefix for trace ids and daemon instance names. */
  code: string
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
  /** True when the workflow declares an operatorSubject hook. */
  hasOperatorSubject?: boolean
  /** Serializable row/action policy consumed by workflow runtime projections. */
  runtimePolicy?: WorkflowRuntimePolicy
  /**
   * Named run-mode presets surfaced in the dashboard's input-run gear menu.
   * Omitted when the workflow declared none. The implicit "Full" preset is
   * synthesized client-side and never appears here.
   */
  presets?: WorkflowStepPresetMetadata[]
}

export interface RegisteredWorkflow<TData, TSteps extends readonly string[]> {
  config: WorkflowConfig<TData, TSteps>
  metadata: WorkflowMetadata
  archetype: WorkflowArchetypeOrResolver<TData>
  /** Resolved queue-row kind (literal or per-input resolver). See `domain/queue-row-kind.ts`. */
  queueRowKind: QueueRowKindOrResolver<TData>
  /** Resolved 2-char workflow code (provenance prefix for trace ids + daemon instance names). */
  code: string
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
  }) => Promise<{ page: import('playwright').Page; context: import('playwright').BrowserContext; browser: import('playwright').Browser | null }>
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
   * Override the workflow's `batch.poolSize` config at runtime. Internal
   * callers can pass `runWorkflowBatch(wf, items, { poolSize: 2 })` to
   * override the default.
   * Ignored outside of pool-mode batch runs.
   */
  poolSize?: number
  /** When set, every TrackerEntry emitted for this run carries `parentRunId`. */
  parentRunId?: string
  /**
   * Parent run's `AbortSignal`. When provided, the kernel attaches a one-shot
   * abort listener to it so this child run's own per-run `AbortController`
   * aborts immediately when the parent's does. Closes the Contract 5 gap for
   * in-process delegated children (OCR, sharepoint-download) — the
   * daemon-dispatched delegation path already cancels children via the
   * worker-command machinery, but the in-process `runInProcessAndCollectResult`
   * path used to keep running until completion regardless of parent state.
   */
  parentSignal?: AbortSignal
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
