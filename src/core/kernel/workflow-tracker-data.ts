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
 * Split a `prefilledData` channel out of an arbitrary input object without
 * mutating the original. Used by the kernel's edit-and-resume path: the
 * dashboard re-enqueues an item with `prefilledData: <user-edited fields>`,
 * the kernel strips the channel before handing the input to the workflow's
 * Zod schema (so the schema doesn't need to know about it), and merges the
 * stripped values into `ctx.data` via `updateData(...)` BEFORE the handler
 * runs. Handlers gate their extraction step on data presence (e.g.
 * `if (!ctx.data.foo) await ctx.step("extraction", ...)`) to opt in.
 *
 * Returns `{ cleaned, prefilled }`. `prefilled` is null when the input has
 * no `prefilledData` field or it's not an object — both are "no-op" cases.
 */
export function splitPrefilled(input: unknown): {
  cleaned: unknown
  prefilled: Record<string, unknown> | null
} {
  if (!isPlainObject(input)) {
    return { cleaned: input, prefilled: null }
  }
  if (!('prefilledData' in input)) return { cleaned: input, prefilled: null }
  const { prefilledData, ...rest } = input
  const prefilled =
    isPlainObject(prefilledData)
      ? prefilledData
      : null
  return { cleaned: rest, prefilled }
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
