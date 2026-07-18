/**
 * Shared `__runtimeOptions` helpers for OCR fan-outs that enqueue REAL daemon
 * member tasks — used by the approve fan-out (`approve.ts`) and the I-9 check
 * member enqueue (`i9-check-results.ts`). Extracted 2026-07-16 when the second
 * caller appeared (repo rule: promote shared helpers).
 */
import { runIdFragment } from "../../../domain/queue-trace-id.js";

/**
 * Merge the OCR root's trace PREFIX onto an enqueued child's `__runtimeOptions`
 * channel (root trace-id propagation, trace/span model). The daemon worker
 * reads `runtimeOptions.rootTracePrefix` in `run-one-item.ts` and COMPOSES
 * `<prefix>-<ownRunId4>` as the child's `data.__traceId`, so every fan-out
 * descendant shares the root's operation prefix while keeping its own
 * greppable tail/runId/itemId. No-op when the prefix is absent or the input
 * isn't a plain object.
 */
export function withRootTracePrefixRuntimeOption<TInput>(
  input: TInput,
  rootTracePrefix: string | undefined,
): TInput {
  if (!rootTracePrefix || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const current = (input as Record<string, unknown>).__runtimeOptions;
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rootTracePrefix,
    },
  } as TInput;
}

/**
 * Merge a member `rowShape` onto a fan-out child's `__runtimeOptions` so the
 * stamped archetype survives the SQLite task store to the daemon worker's
 * `run-one-item` re-emit (`normalizeRuntimeOptions` carries it through).
 * No-op when the shape is absent or the input isn't a plain object.
 */
export function withMemberShapeRuntimeOption<TInput>(
  input: TInput,
  rowShape: "operation-member" | undefined,
): TInput {
  if (!rowShape || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const current = (input as Record<string, unknown>).__runtimeOptions;
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rowShape,
    },
  } as TInput;
}

/**
 * Compose a fan-out member's frozen trace id AT PRE-EMIT (ISS-004). The child
 * INPUT carries `rootTracePrefix`, so the daemon worker composes the member
 * `__traceId` only at CLAIM — a member that is never claimed (queued then
 * cancelled-while-queued) would carry no trace id. This composes the SAME
 * value the daemon would (`<rootPrefix>-<runIdFragment(runId)>`), so
 * `findFrozenTraceId` reuses it at claim with no drift. Returns undefined when
 * there is no root prefix. Display/lineage only.
 */
export function composeFanOutMemberTraceId(
  rootTracePrefix: string | undefined,
  childRunId: string,
): string | undefined {
  return rootTracePrefix ? `${rootTracePrefix}-${runIdFragment(childRunId)}` : undefined;
}
