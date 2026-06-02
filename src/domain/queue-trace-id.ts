/**
 * Human-readable, unique, log-greppable **trace id** for a queue row.
 *
 * Format: `<code>-<HHMMSS>-<runId4>`   e.g. `ou-143012-a3f1`
 *
 *   - `code`    — the 2-char workflow code of the ROOT run. Provenance: a
 *                 delegated row shows the workflow that spawned its tree
 *                 (where it came from), not the child workflow. The OCR form
 *                 spec may override this per-operation via `traceCode` (oath →
 *                 `ou`, branding the whole oath-upload operation by its
 *                 destination rather than OCR's own `oc`).
 *
 * Root trace-id propagation (trace/span model): the root PREFIX
 * (`<code>-<HHMMSS>`) — NOT the full root id — flows transitively to every
 * descendant of an operation via `rootTracePrefix` on the child input's
 * `__runtimeOptions` channel (threaded by `delegate.ts` / `makeCtx`'s
 * `forwardRootTracePrefix`). Each descendant COMPOSES that shared prefix with
 * its OWN `runId4` tail (`buildTraceId({ …, rootPrefix })`), so every row of one
 * operation reads `ou-090553-<theirOwnRunId4>` — visibly ONE operation (shared
 * `<code>-<HHMMSS>` prefix) yet each row individually greppable by its own
 * runId/itemId (logs, SQLite, footer `#run` keep the row's own id). The
 * frozen-once invariant still holds — a same-run re-emit reuses the row's
 * already-composed value before any propagation/compose runs.
 *   - time      — local `HHMMSS` (time-of-day) of the run's start. The date is
 *                 intentionally omitted — tracker files are already
 *                 date-partitioned (`{workflow}-{YYYY-MM-DD}.jsonl`), so the
 *                 day is redundant. Human-readable "when"; NOT relied on for
 *                 uniqueness.
 *   - runId4    — first 4 alphanumerics of the canonical run UUID. This is
 *                 what makes the id (a) collision-proof across same-second
 *                 batch fan-out, and (b) tied back to the real `runId` the
 *                 tracker/SQLite/logs key on — so an operator can grep from
 *                 the card straight to the logs.
 *
 * Stamped once into `data.__traceId` at pre-emit and frozen thereafter, so it
 * survives re-renders and lands in the tracker JSONL for grepping.
 *
 * Pure: the caller supplies the timestamp (`at`) so this stays testable and
 * never reads the clock itself.
 */
export function formatTraceTimestamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const HH = pad(at.getHours());
  const MM = pad(at.getMinutes());
  const SS = pad(at.getSeconds());
  return `${HH}${MM}${SS}`;
}

/** First 4 alphanumerics of the canonical run id (UUID), lowercased. */
export function runIdFragment(runId: string): string {
  const cleaned = runId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return cleaned.slice(0, 4) || "0000";
}

/**
 * The shared operation PREFIX of a trace id: everything before the final
 * `-<runId4>` tail. `ou-090553-1a57` → `ou-090553`. This is what propagates to
 * descendants (the trace/span model) — each descendant appends its own tail.
 * Returns the input unchanged when there is no `-` to split on.
 */
export function tracePrefix(traceId: string): string {
  const i = traceId.lastIndexOf("-");
  return i > 0 ? traceId.slice(0, i) : traceId;
}

/**
 * Build a row's trace id.
 *
 *  - Without `rootPrefix`: a physical root composes its own
 *    `<code>-<HHMMSS>-<runId4>` from the clock + its runId.
 *  - With `rootPrefix` (root trace-id propagation): a descendant composes the
 *    INHERITED operation prefix with its OWN `runId4` tail — `<rootPrefix>-<runId4>`
 *    — so the whole operation shares the prefix while each row stays greppable
 *    by its own runId. `code`/`at` are ignored in this branch.
 */
export function buildTraceId(opts: { code: string; runId: string; at: Date; rootPrefix?: string }): string {
  if (opts.rootPrefix) {
    return `${opts.rootPrefix}-${runIdFragment(opts.runId)}`;
  }
  const code = opts.code.trim().toLowerCase() || "wf";
  return `${code}-${formatTraceTimestamp(opts.at)}-${runIdFragment(opts.runId)}`;
}
