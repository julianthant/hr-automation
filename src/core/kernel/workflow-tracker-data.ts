import type { RegisteredWorkflow } from './types.js'
import { normalizeDetailField } from './registry.js'
import type { WithTrackedWorkflowOpts } from '../../tracker/jsonl.js'
import { operatorSubjectData } from '../../domain/operator-subject.js'
import { queueTitleData } from '../../domain/queue-title.js'

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
  runtimeOptions: { skipSteps?: string[]; preset?: string } | null
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
  const { prefilledData, __runtimeOptions, ...rest } = input as Record<string, unknown>
  const prefilled = isPlainObject(prefilledData) ? prefilledData : null
  const runtimeOptions = isPlainObject(__runtimeOptions)
    ? normalizeRuntimeOptions(__runtimeOptions)
    : null
  return { cleaned: rest, prefilled, runtimeOptions }
}

function normalizeRuntimeOptions(
  raw: Record<string, unknown>,
): { skipSteps?: string[]; preset?: string } | null {
  const out: { skipSteps?: string[]; preset?: string } = {}
  const skipSteps = raw.skipSteps
  if (Array.isArray(skipSteps) && skipSteps.every((s): s is string => typeof s === 'string')) {
    if (skipSteps.length > 0) out.skipSteps = [...skipSteps]
  }
  if (typeof raw.preset === 'string' && raw.preset.length > 0) {
    out.preset = raw.preset
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
      .map((f) => f.key),
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
  return queueTitleData({ kind: 'batch', title })
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
