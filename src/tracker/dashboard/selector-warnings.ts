import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dateLocal } from "../jsonl.js";

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
): (days: number) => SelectorWarningRow[] {
  return (days: number) => {
    if (!existsSync(dir)) return [];
    const daysNormalized = Math.max(1, Math.floor(days));
    const today = new Date();
    // Collect the list of YYYY-MM-DD dates to scan (today + prior days).
    const dates: string[] = [];
    for (let i = 0; i < daysNormalized; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(dateLocal(d));
    }

    // Aggregate by label. Track distinct workflow set per label.
    const aggregated = new Map<
      string,
      { count: number; firstTs: string; lastTs: string; workflows: Set<string> }
    >();

    for (const f of readdirSync(dir)) {
      if (!f.endsWith("-logs.jsonl")) continue;
      // Match the date and workflow out of the filename: `<wf>-<YYYY-MM-DD>-logs.jsonl`
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})-logs\.jsonl$/);
      if (!m) continue;
      const date = m[2];
      if (!dates.includes(date)) continue;

      let raw: string;
      try {
        raw = readFileSync(join(dir, f), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry: { workflow?: string; level?: string; message?: string; ts?: string };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // Accept both warn (slow-success) and error (failure) - they share
        // the `selector fallback triggered:` marker. See safe.ts for shapes.
        if (
          (entry.level !== "warn" && entry.level !== "error") ||
          typeof entry.message !== "string"
        )
          continue;
        const match = entry.message.match(SELECTOR_FALLBACK_RE);
        if (!match) continue;
        const label = match[1].trim();
        if (!label) continue;
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
    }

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
  };
}
