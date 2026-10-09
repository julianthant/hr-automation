import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

import { PATHS } from "../config.js";
import { DEFAULT_DIR, dateLocal } from "./jsonl-io.js";
import {
  logsDir,
  rowsDir,
  sessionsDir,
  parseSessionFilename,
  parseWorkflowDateFilename,
} from "./paths.js";
import { daemonsDir } from "../core/daemon/registry.js";

/** Delete every dated `<workflow>-<date>.jsonl` in `subdir` older than `cutoffStr`. */
function pruneWorkflowDateDir(subdir: string, cutoffStr: string): number {
  if (!existsSync(subdir)) return 0;
  let deleted = 0;
  for (const f of readdirSync(subdir)) {
    const parsed = parseWorkflowDateFilename(f);
    if (parsed && parsed.date < cutoffStr) {
      unlinkSync(join(subdir, f));
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete tracker row + log JSONL files older than maxAgeDays. Returns count of
 * deleted files (rows and logs combined).
 *
 * Default 30 days — workflow history below that floor is considered "recent
 * enough to keep" for operator retro investigation. Callers that want a
 * shorter window must pass it explicitly.
 */
export function cleanOldTrackerFiles(maxAgeDays: number = 30, dir: string = DEFAULT_DIR): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = dateLocal(cutoff);
  return (
    pruneWorkflowDateDir(rowsDir(dir), cutoffStr) +
    pruneWorkflowDateDir(logsDir(dir), cutoffStr)
  );
}

/**
 * Delete dated session files (`<dir>/sessions/<date>.jsonl`) older than
 * `maxAgeDays`.
 */
export function cleanOldSessionFiles(maxAgeDays: number, dir: string = DEFAULT_DIR): number {
  const sessions = sessionsDir(dir);
  if (!existsSync(sessions)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(sessions);
  } catch {
    return 0;
  }
  for (const f of entries) {
    const dateStr = parseSessionFilename(f);
    if (!dateStr) continue;
    const dateMs = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(dateMs) || dateMs >= cutoffMs) continue;
    try {
      unlinkSync(join(sessions, f));
      deleted += 1;
    } catch { /* missing or unreadable — skip */ }
  }
  return deleted;
}

/**
 * Delete daemon process logs (`<dir>/daemons/<workflow>-<ISO>.log`) older than
 * `maxAgeDays`. The spawner writes a fresh timestamped file on every daemon
 * launch, so without pruning these accumulate one-per-restart indefinitely.
 * The date is taken from each file's mtime (the ISO stamp in the name uses
 * `:`-free formatting that's awkward to parse, and mtime is the true age).
 */
export function cleanOldDaemonLogs(maxAgeDays: number, dir: string = DEFAULT_DIR): number {
  const daemons = daemonsDir(dir);
  if (!existsSync(daemons)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(daemons);
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith(".log")) continue;
    const full = join(daemons, f);
    try {
      if (statSync(full).mtimeMs >= cutoffMs) continue;
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
