import { dateLocal, readEntriesForDate } from "./jsonl.js";

/**
 * Collects 1-based batch display ordinals already assigned on tracker rows for a
 * given workflow + date. Daemon batch members share one ordinal per batch
 * (`data.batchDisplayOrdinal`); duplicates across rows collapse in the set.
 */
export function collectUsedBatchDisplayOrdinals(
  workflow: string,
  trackerDir: string,
  trackerDate: string,
): Set<number> {
  const used = new Set<number>();
  for (const e of readEntriesForDate(workflow, trackerDate, trackerDir)) {
    if (!e.parentRunId) continue;
    const n = parseBatchOrdinal(e.data?.batchDisplayOrdinal);
    if (n !== undefined) used.add(n);
  }
  return used;
}

/** Smallest positive integer not present in `used`. */
export function lowestAvailableBatchOrdinal(used: ReadonlySet<number>): number {
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/**
 * Picks the lowest unused batch display number for new multi-item batches on the
 * given tracker date. When batch 2 is deleted but 3 remains, the next batch gets 2.
 */
export function allocateLowestBatchDisplayOrdinal(
  workflow: string,
  trackerDir: string,
  trackerDate: string = dateLocal(),
): number {
  const used = collectUsedBatchDisplayOrdinals(workflow, trackerDir, trackerDate);
  return lowestAvailableBatchOrdinal(used);
}

function parseBatchOrdinal(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
