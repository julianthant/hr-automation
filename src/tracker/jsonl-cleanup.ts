import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

import { PATHS } from "../config.js";
import { DEFAULT_DIR, dateLocal } from "./jsonl-io.js";

/**
 * Delete JSONL files older than maxAgeDays. Returns count of deleted files.
 *
 * Default 30 days — workflow history below that floor is considered "recent
 * enough to keep" for operator retro investigation. Callers that want a
 * shorter window must pass it explicitly.
 */
export function cleanOldTrackerFiles(maxAgeDays: number = 30, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = dateLocal(cutoff);

  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    // Skip sessions-YYYY-MM-DD.jsonl — those are handled by cleanOldSessionFiles.
    if (f.startsWith("sessions-")) continue;
    const match = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (match && match[1] < cutoffStr) {
      unlinkSync(join(dir, f));
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete `sessions-YYYY-MM-DD.jsonl` files older than `maxAgeDays`.
 */
export function cleanOldSessionFiles(maxAgeDays: number, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    const full = join(dir, f);
    const m = f.match(/^sessions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const dateStr = m[1];
    const dateMs = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(dateMs) || dateMs >= cutoffMs) continue;
    try {
      unlinkSync(full);
      deleted += 1;
    } catch { /* missing or unreadable — skip */ }
  }
  return deleted;
}

/**
 * Delete failure-screenshot PNGs older than `maxAgeDays`. Returns the count of
 * deleted files.
 *
 * Unlike tracker JSONL files (whose filename carries the date), screenshot
 * filenames encode the timestamp as a ms-since-epoch integer in their tail:
 *   `<workflow>-<itemId>-<step>-<systemId>-<ts>.png`
 * We parse the trailing numeric segment and compare to the cutoff. Files that
 * don't match the shape (or have a non-numeric trailing segment) are skipped —
 * never accidentally deleted.
 */
export function cleanOldScreenshots(
  maxAgeDays: number = 30,
  dir: string = PATHS.screenshotDir,
): number {
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".png")) continue;
    // Extract the trailing `<ts>.png` segment. File shape:
    //   <workflow>-<itemId>-<step>-<systemId>-<ts>.png
    // We can't split blindly (step names may contain dashes); instead take the
    // last hyphen-separated segment before `.png` and require it to be numeric.
    const stripped = f.slice(0, -".png".length);
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash === -1) continue;
    const tsStr = stripped.slice(lastDash + 1);
    const tsNum = Number(tsStr);
    if (!Number.isFinite(tsNum) || tsNum <= 0) continue;
    if (tsNum < cutoffMs) {
      unlinkSync(join(dir, f));
      deleted++;
    }
  }
  return deleted;
}
