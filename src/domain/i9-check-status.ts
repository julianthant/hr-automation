/**
 * I-9 Check queue-row status extensions.
 *
 * The found / not-found chip on the per-person member rows fanned out from a
 * "Run I-9 Check" upload (`data.ucpathFound`, stamped by the i9-check daemon
 * step). "In UCPath" (success tone) vs "Not in UCPath" (warning tone) — the
 * whole point of the check, so it reads at a glance beside the done/failed
 * badge. A row whose check never answered (failed run, AMBIGUOUS name match)
 * carries NO tag — an unanswered check must never render as a definitive
 * "Not in UCPath".
 *
 * Client-bundle-safe (pure predicate over row data). Registered for the
 * `i9-check` workflow in `queue-row-status-index.ts`; `separations-status.ts`
 * re-uses the tag so LEGACY separations i9-check member rows (pre-split, still
 * on disk) keep rendering their chip.
 */
import type { QueueRowStatusTag, WorkflowStatusExtensions } from "./queue-row-status.js";

/**
 * The UCPath found / not-found chip for an I-9 check member row. Returns `null`
 * for a row without a verdict, and for a check that never answered (only a
 * definitive `"true"` / `"false"` produces a tag — fail loud, never guess).
 */
export function i9CheckResultTag(entry: {
  data?: Record<string, string>;
}): QueueRowStatusTag | null {
  const found = entry.data?.ucpathFound;
  if (found === "true") {
    return {
      text: "In UCPath",
      title: "Found in UCPath — the person search matched an existing record",
      className: "bg-success/12 text-success border border-success/30",
    };
  }
  if (found === "false") {
    return {
      text: "Not in UCPath",
      title: "Not found in UCPath — the person search returned no match",
      className: "bg-warning/12 text-warning border border-warning/30",
    };
  }
  return null;
}

export const i9CheckStatusExtensions: WorkflowStatusExtensions = {
  secondaryTag: (entry) => i9CheckResultTag(entry),
};
