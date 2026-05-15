import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dateLocal, type TrackerEntry } from "./jsonl.js";

export interface FindLatestEntryForPredicateOpts {
  workflow: string;
  predicate: (entry: TrackerEntry) => boolean;
  trackerDir?: string;
  lookbackDays?: number;
  now?: Date;
}

/**
 * Search recent workflow JSONL files newest-first and return the first entry
 * accepted by `predicate`. Tolerates malformed lines the same way dashboard
 * fallback readers do.
 */
export function findLatestEntryForPredicate(
  opts: FindLatestEntryForPredicateOpts,
): TrackerEntry | null {
  const dir = opts.trackerDir ?? ".tracker";
  const lookbackDays = opts.lookbackDays ?? 7;
  const today = opts.now ?? new Date();
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const file = join(dir, `${opts.workflow}-${dateLocal(d)}.jsonl`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const entry = JSON.parse(lines[j]) as TrackerEntry;
        if (opts.predicate(entry)) return entry;
      } catch {
        /* tolerate malformed JSONL */
      }
    }
  }
  return null;
}
