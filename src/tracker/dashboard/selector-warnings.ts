import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dateLocal } from "../jsonl.js";
import { logsDir, parseWorkflowDateFilename } from "../paths.js";
import type { Database } from "../../infra/sqlite/index.js";

/**
 * A single aggregated selector-fallback warning row. `label` is the text
 * captured from `safeClick`/`safeFill`'s `log.warn("selector fallback
 * triggered: <label>")` message. `count` is total occurrences across the
 * scanned window; `firstTs`/`lastTs` bracket that activity; `workflows`
 * is the distinct set of workflow names that emitted the warn.
 */
export interface SelectorWarningRow {
  label: string;
  count: number;
  firstTs: string;
  lastTs: string;
  workflows: string[];
}

/**
 * Regex that extracts the selector label from a `safeClick`/`safeFill`
 * instrumentation log line. Keep in sync with the format in
 * `src/systems/common/safe.ts`.
 *
 * Matches all three shapes that share the `selector fallback triggered:`
 * anchor:
 *   - legacy (pre-timing) : `selector fallback triggered: <label>`
 *   - slow-success (warn) : `selector fallback triggered: <label> (click took Nms - ...)`
 *   - failure (error)     : `selector fallback triggered: <label> (click failed after Nms - ...)`
 *
 * The lazy `[^(]+?` capture stops at the first `(` of the timing suffix (if
 * present) so every variant aggregates under the same `<label>` key.
 */
const SELECTOR_FALLBACK_RE = /selector fallback triggered:\s*([^(]+?)\s*(?:\(.*)?$/;

/**
 * Build a handler that scans log JSONL files in `dir` across the current day
 * plus `days - 1` prior days, keeps entries whose `level` is `warn` (slow
 * success) or `error` (failure) and whose message matches
 * `selector fallback triggered: <label>` (optionally followed by a timing
 * suffix), and returns one aggregated `SelectorWarningRow` per distinct
 * label (sorted by count desc, tie-broken by most recent `lastTs`).
 *
 * Factored out of the HTTP handler so it can be unit-tested against a temp
 * directory without booting the SSE server.
 */
export function buildSelectorWarningsHandler(
  dir: string = ".tracker",
  opts: { projectionReady?: boolean; stateDb?: Database } = {},
): (days: number) => SelectorWarningRow[] {
  return (days: number) => {
    const daysNormalized = Math.max(1, Math.floor(days));
    const today = new Date();
    // Collect the list of YYYY-MM-DD dates to scan (today + prior days).
    const dates: string[] = [];
    for (let i = 0; i < daysNormalized; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(dateLocal(d));
    }
    const cutoff = dates.at(-1) ?? dateLocal(today);

    // Aggregate by label. Track distinct workflow set per label.
    const aggregated = new Map<
      string,
      { count: number; firstTs: string; lastTs: string; workflows: Set<string> }
    >();

    if (opts.projectionReady && opts.stateDb) {
      const rows = opts.stateDb.prepare(`
        SELECT workflow, level, message, ts
        FROM logs
        WHERE tracker_date >= @cutoff
          AND level IN ('warn', 'error')
          AND message LIKE '%selector fallback triggered%'
      `).all({ cutoff }) as Array<{
        workflow: string | null;
        level: string | null;
        message: string | null;
        ts: string | null;
      }>;
      for (const entry of rows) {
        addSelectorWarningRow(aggregated, {
          workflow: entry.workflow ?? "",
          level: entry.level ?? "",
          message: entry.message ?? "",
          ts: entry.ts ?? "",
        });
      }
      return sortSelectorWarningRows(aggregated);
    }

    const logs = logsDir(dir);
    if (!existsSync(logs)) return [];

    for (const f of readdirSync(logs)) {
      // `logs/` holds only `<wf>-<YYYY-MM-DD>.jsonl` files; parse the date out.
      const parsed = parseWorkflowDateFilename(f);
      if (!parsed) continue;
      const date = parsed.date;
      if (!dates.includes(date)) continue;

      let raw: string;
      try {
        raw = readFileSync(join(logs, f), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry: { workflow?: string; level?: string; message?: string; ts?: string };
        try {
          entry = JSON.parse(line) as { workflow?: string; level?: string; message?: string; ts?: string };
        } catch {
          continue;
        }
        addSelectorWarningRow(aggregated, entry);
      }
    }

    return sortSelectorWarningRows(aggregated);
  };
}

function addSelectorWarningRow(
  aggregated: Map<string, { count: number; firstTs: string; lastTs: string; workflows: Set<string> }>,
  entry: { workflow?: string; level?: string; message?: string; ts?: string },
): void {
  // Accept both warn (slow-success) and error (failure) - they share
  // the `selector fallback triggered:` marker. See safe.ts for shapes.
  if (
    (entry.level !== "warn" && entry.level !== "error") ||
    typeof entry.message !== "string"
  )
    return;
  const match = entry.message.match(SELECTOR_FALLBACK_RE);
  if (!match) return;
  const label = match[1].trim();
  if (!label) return;
  const ts = typeof entry.ts === "string" ? entry.ts : "";
  const workflow = typeof entry.workflow === "string" ? entry.workflow : "";
  const prev = aggregated.get(label);
  if (prev) {
    prev.count += 1;
    if (ts && (!prev.firstTs || ts < prev.firstTs)) prev.firstTs = ts;
    if (ts && (!prev.lastTs || ts > prev.lastTs)) prev.lastTs = ts;
    if (workflow) prev.workflows.add(workflow);
  } else {
    aggregated.set(label, {
      count: 1,
      firstTs: ts,
      lastTs: ts,
      workflows: new Set(workflow ? [workflow] : []),
    });
  }
}

function sortSelectorWarningRows(
  aggregated: Map<string, { count: number; firstTs: string; lastTs: string; workflows: Set<string> }>,
): SelectorWarningRow[] {
  // Emit rows, sorted by count desc then lastTs desc.
  return [...aggregated.entries()]
    .map(([label, agg]) => ({
      label,
      count: agg.count,
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      workflows: [...agg.workflows].sort(),
    }))
    .sort((a, b) =>
      b.count - a.count || (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0),
    );
}
