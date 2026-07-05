import type { RegisteredWorkflow } from './types.js'
import { normalizeDetailField } from './registry.js'
import type { WithTrackedWorkflowOpts } from '../../tracker/jsonl.js'
import { operatorSubjectData } from '../../domain/operator-subject.js'
import { queueTitleData } from '../../domain/queue-title.js'
import { isMemberRowShape, type MemberRowShape } from '../../domain/row-archetype.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Best-effort coercion of an arbitrary input into a `Record<string, unknown>`
 * so it can ride on the `pending` tracker row's `input` field. Non-objects
 * become `null` (caller skips writing the field). Does NOT clone — the
 * returned reference is the same object the kernel got, by design: the
 * tracker line is JSON-stringified at write time, so downstream mutation
 * by the handler can't reach back into the file.
 */
export function toRecord(input: unknown): Record<string, unknown> | null {
  return isPlainObject(input) ? input : null
}

/**
 * Split the kernel-level `prefilledData` and `runtimeOptions` channels out of
 * an arbitrary input object without mutating the original.
 *
 * - `prefilledData` (edit-and-resume) — the dashboard re-enqueues an item with
 *   user-edited fields under this key; they're merged into `ctx.data` via
 *   `updateData(...)` BEFORE the handler runs, so handlers can gate
 *   extraction on data presence (`if (!ctx.data.foo) ...`).
 * - `runtimeOptions.skipSteps` (step presets) — the dashboard's input-run
 *   gear menu passes the chosen preset's skip set under this key; the kernel
 *   exposes it as `ctx.shouldSkipStep(name)` for handlers to OR into their
 *   existing skip branches.
 * - `runtimeOptions.rowShape` (dashboard direct input batches) — internal
 *   row-shape hint for typed multi-value runs that should emit member rows.
 *
 * The kernel strips both channels before handing the input to the workflow's
 * Zod schema so workflow files don't have to know about either contract.
 *
 * Returns `{ cleaned, prefilled, runtimeOptions }`. Each channel field is
 * `null` when the input has no such key or it's not an object (no-op case).
 */
export interface SplitInput {
  cleaned: unknown
  prefilled: Record<string, unknown> | null
  runtimeOptions: { skipSteps?: string[]; preset?: string; rowShape?: MemberRowShape; rootCode?: string; rootTracePrefix?: string } | null
}

export function splitPrefilled(input: unknown): SplitInput {
  if (!isPlainObject(input)) {
    return { cleaned: input, prefilled: null, runtimeOptions: null }
  }
  const hasPrefilled = 'prefilledData' in input
  const hasRuntimeOptions = '__runtimeOptions' in input
  if (!hasPrefilled && !hasRuntimeOptions) {
    return { cleaned: input, prefilled: null, runtimeOptions: null }
  }
  const { prefilledData, __runtimeOptions, ...rest } = input
  const prefilled = isPlainObject(prefilledData) ? prefilledData : null
  const runtimeOptions = isPlainObject(__runtimeOptions)
    ? normalizeRuntimeOptions(__runtimeOptions)
    : null
  return { cleaned: rest, prefilled, runtimeOptions }
}

function normalizeRuntimeOptions(
  raw: Record<string, unknown>,
): { skipSteps?: string[]; preset?: string; rowShape?: MemberRowShape; rootCode?: string; rootTracePrefix?: string } | null {
  const out: { skipSteps?: string[]; preset?: string; rowShape?: MemberRowShape; rootCode?: string; rootTracePrefix?: string } = {}
  const skipSteps = raw.skipSteps
  if (Array.isArray(skipSteps) && skipSteps.every((s): s is string => typeof s === 'string')) {
    if (skipSteps.length > 0) out.skipSteps = [...skipSteps]
  }
  if (typeof raw.preset === 'string' && raw.preset.length > 0) {
    out.preset = raw.preset
  }
  if (isMemberRowShape(raw.rowShape)) {
    out.rowShape = raw.rowShape
  }
  // Provenance code for the trace-id prefix — the delegating parent's 2-char
  // workflow code. Rides the existing `__runtimeOptions` channel (like
  // `rowShape`) so it survives the SQLite task store to the daemon worker's
  // own pre-emit, keeping the child's trace id prefixed with the originating
  // workflow even after the worker re-emits.
  if (typeof raw.rootCode === 'string' && raw.rootCode.length > 0) {
    out.rootCode = raw.rootCode
  }
  // Root trace PREFIX (`<code>-<HHMMSS>`) for ROOT trace-id propagation
  // (trace/span model) — the originating run's shared prefix, not its full id.
  // Rides the same `__runtimeOptions` channel as `rootCode` so it survives the
  // SQLite task store to the daemon worker's `run-one-item` re-emit, where the
  // child COMPOSES `<prefix>-<ownRunId4>` for its `data.__traceId` (via
  // buildTraceId's `rootPrefix` opt). Unlike `rootCode` (immediate parent's
  // code), this is forwarded transitively so a grandchild shares the original
  // root's prefix. See `buildDelegateApi`'s `forwardRootTracePrefix`.
  if (typeof raw.rootTracePrefix === 'string' && raw.rootTracePrefix.length > 0) {
    out.rootTracePrefix = raw.rootTracePrefix
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Build the richness-hook bundle for `withTrackedWorkflow` from a workflow
 * config. Extracted so all three modes (runWorkflow, runWorkflowBatch,
 * runWorkflowPool) pass the identical shape — keeps the runtime warning,
 * getName, and getId in lockstep across modes.
 */
export function buildTrackerOpts<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
): WithTrackedWorkflowOpts {
  return {
    declaredDetailFields: (wf.config.detailFields ?? [])
      .map(normalizeDetailField)
      .map((f) => ({ key: f.key, conditional: f.conditional })),
    nameFn: wf.config.getName,
    idFn: wf.config.getId,
  }
}

export function buildInitialTrackerData<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: TData,
): Record<string, string> {
  const initial: Record<string, string> = {}
  if (wf.config.initialData) {
    for (const [key, value] of Object.entries(wf.config.initialData(input))) {
      initial[key] = value == null ? '' : String(value)
    }
  }
  const subject = wf.config.operatorSubject ? operatorSubjectData(wf.config.operatorSubject(input)) : {}
  const seed = { ...initial, ...subject }
  return { ...seed, ...buildQueueTitleForInput(wf, input, seed) }
}

function buildQueueTitleForInput<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: TData,
  seed: Record<string, string>,
): Record<string, string> {
  const config = wf.config.queueTitle
  if (!config) return {}
  if (config.kind === 'single') {
    const title = seed.__subject || seed.__name || wf.config.getName?.(seed) || ''
    return queueTitleData({ kind: 'single', title })
  }
  const title = config.labelFromInput?.(input) ?? config.label ?? wf.config.label ?? wf.config.name
  return queueTitleData({ kind: 'operation', title })
}

/**
 * Derive a stable itemId from common identifier fields on the input data.
 * Falls back to the caller-provided `fallback` (typically a UUID) if no known
 * field is present.
 *
 * Recognized fields (in priority order): `emplId`, `docId`, `email`.
 */
export function deriveItemId<TData>(data: TData, fallback: string): string {
  const d = data as unknown as Record<string, unknown>
  for (const key of ['emplId', 'docId', 'email', 'sessionId']) {
    const value = d[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return fallback
}
