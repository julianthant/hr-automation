import { log } from "../../utils/log.js";
import { normalizeName } from "./person-name.js";

/**
 * Deduplicate an array of already-normalized names, warning on duplicates.
 * Applied at the CLI boundary so the kernel never sees two items with the same id.
 *
 * Lives outside `person-name.ts` so dashboard/client bundles can import pure
 * name helpers without pulling `log.ts` → tracker JSONL → `node:path`.
 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) {
      log.warn(`Duplicate name skipped: "${n}"`);
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Normalize every input name to "Last, First Middle" title-case + dedupe
 * duplicates post-normalization. Applied at every CLI entry point so the
 * daemon-mode path feeds the search pipeline normalized strings.
 */
export function prepareNames(names: string[]): string[] {
  return dedupeNames(names.map(normalizeName));
}
