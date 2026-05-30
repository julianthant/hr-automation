/**
 * Human-readable, unique, log-greppable **trace id** for a queue row.
 *
 * Format: `<code>-<mmddyyHHMMSS>-<runId4>`   e.g. `ou-053026143012-a3f1`
 *
 *   - `code`    — the 2-char workflow code of the ROOT run. Provenance: a
 *                 delegated row shows the workflow that spawned its tree
 *                 (where it came from), not the child workflow.
 *   - timestamp — local `mmddyyHHMMSS` of the run's start. Human-readable
 *                 "when"; deliberately NOT relied on for uniqueness.
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
  const mm = pad(at.getMonth() + 1);
  const dd = pad(at.getDate());
  const yy = pad(at.getFullYear() % 100);
  const HH = pad(at.getHours());
  const MM = pad(at.getMinutes());
  const SS = pad(at.getSeconds());
  return `${mm}${dd}${yy}${HH}${MM}${SS}`;
}

/** First 4 alphanumerics of the canonical run id (UUID), lowercased. */
export function runIdFragment(runId: string): string {
  const cleaned = runId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return cleaned.slice(0, 4) || "0000";
}

export function buildTraceId(opts: { code: string; runId: string; at: Date }): string {
  const code = opts.code.trim().toLowerCase() || "wf";
  return `${code}-${formatTraceTimestamp(opts.at)}-${runIdFragment(opts.runId)}`;
}
