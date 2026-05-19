import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { PATHS } from "../../config.js";
import { transaction } from "../../infra/sqlite/index.js";
import { log } from "../../utils/log.js";
import { isStateDbReady, openStateDb } from "./db.js";

export interface ScreenshotSweepResult {
  /** Screenshot files deleted because their owning run reached terminal_at > 30d ago. */
  terminalRunFilesDeleted: number;
  /** Orphan PNGs deleted because nothing in the files table referenced them and they were >30d old. */
  orphanFilesDeleted: number;
  /** files-table rows removed in the terminal-run path. */
  fileRowsDeleted: number;
}

/**
 * Lifecycle-tied screenshot cleanup. Runs in two passes inside one transaction
 * (the file deletes themselves happen outside the transaction since they are
 * best-effort):
 *
 *   1. Terminal-run pass: any run whose `terminal_at` is older than
 *      `maxAgeDays` has its registered screenshot files removed from disk and
 *      from the `files` table. `runs.screenshot_count` is zeroed for those
 *      runs so the dashboard stops counting deleted evidence.
 *
 *   2. Orphan pass: every PNG in `screenshotsDir` whose filename-embedded
 *      ms-since-epoch timestamp is older than `maxAgeDays` AND has no `files`
 *      row pointing at it is deleted. Catches screenshots from stuck runs
 *      that never reached a terminal state and screenshots written before the
 *      files-registry shipped.
 *
 * Best-effort throughout: per-file delete failures are logged via `log.warn`
 * and the sweep continues so a single permission error or vanished file does
 * not stall the dashboard.
 *
 * No-op when the projection isn't ready.
 */
export function sweepStaleRunScreenshots(
  dir: string,
  screenshotsDir: string = PATHS.screenshotDir,
  maxAgeDays: number = 30,
): ScreenshotSweepResult {
  const result: ScreenshotSweepResult = {
    terminalRunFilesDeleted: 0,
    orphanFilesDeleted: 0,
    fileRowsDeleted: 0,
  };
  if (!isStateDbReady(dir)) return result;

  const db = openStateDb(dir);
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Pass 1: terminal runs older than cutoff.
  const staleFiles = db
    .prepare(
      `SELECT f.file_id AS fileId, f.storage_path AS storagePath, f.run_id AS runId
       FROM files f
       JOIN runs r ON r.run_id = f.run_id
       WHERE f.kind = 'screenshot'
         AND r.terminal_at IS NOT NULL
         AND r.terminal_at < @cutoffIso`,
    )
    .all({ cutoffIso }) as Array<{ fileId: string; storagePath: string; runId: string | null }>;

  const deletedFileIds: string[] = [];
  const affectedRunIds = new Set<string>();
  for (const row of staleFiles) {
    if (deleteFile(row.storagePath)) {
      result.terminalRunFilesDeleted++;
    }
    deletedFileIds.push(row.fileId);
    if (row.runId) affectedRunIds.add(row.runId);
  }

  if (deletedFileIds.length > 0) {
    transaction(db, () => {
      const deleteStmt = db.prepare("DELETE FROM files WHERE file_id = ?");
      for (const id of deletedFileIds) {
        deleteStmt.run(id);
        result.fileRowsDeleted++;
      }
      const zeroStmt = db.prepare(
        "UPDATE runs SET screenshot_count = 0, updated_at = @now WHERE run_id = @runId",
      );
      const now = new Date().toISOString();
      for (const runId of affectedRunIds) {
        zeroStmt.run({ runId, now });
      }
    });
  }

  // Pass 2: orphan PNGs on disk.
  if (existsSync(screenshotsDir)) {
    const registered = new Set<string>(
      (db.prepare("SELECT storage_path FROM files WHERE kind = 'screenshot'").all() as Array<{ storage_path: string }>)
        .map((r) => resolve(r.storage_path)),
    );

    for (const name of readdirSync(screenshotsDir)) {
      if (!name.endsWith(".png")) continue;
      const fullPath = resolve(join(screenshotsDir, name));
      if (registered.has(fullPath)) continue;

      // Filename shape: <workflow>-<itemId>-<step>-<systemId>-<ts>.png
      const stripped = name.slice(0, -".png".length);
      const lastDash = stripped.lastIndexOf("-");
      let tsMs = -1;
      if (lastDash !== -1) {
        const tsNum = Number(stripped.slice(lastDash + 1));
        if (Number.isFinite(tsNum) && tsNum > 0) tsMs = tsNum;
      }
      // Fallback: use mtime when the filename doesn't carry a parseable ts.
      if (tsMs < 0) {
        try {
          tsMs = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
      }
      if (tsMs >= cutoffMs) continue;
      if (deleteFile(fullPath)) {
        result.orphanFilesDeleted++;
      }
    }
  }

  return result;
}

function deleteFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch (err) {
    log.warn(
      `screenshot sweep: could not delete ${basename(path)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
