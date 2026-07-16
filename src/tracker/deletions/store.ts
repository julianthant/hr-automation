import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Database } from "../../infra/sqlite/index.js";
import { isResolvedPrepEntry } from "../dashboard/prep-rows.js";
import { deletionFilePath, deletionsDir, parseSessionFilename } from "../paths.js";
import { appendJsonlLineLocked } from "../state/jsonl-source.js";
import { isDeletionManifest, type DeletionManifest, type DeletionTarget } from "./types.js";
import { invalidateDeletedRunKeys } from "./visible.js";

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function recomputeItemProjection(db: Database, target: DeletionTarget, now: string): void {
  const latest = db.prepare(`
    SELECT run_id, latest_status, latest_step, latest_tracker_ts,
           latest_data_json, latest_error,
           (
             SELECT TRIM(json_extract(r2.latest_data_json, '$.emplId'))
             FROM runs r2
             WHERE r2.workflow = runs.workflow AND r2.tracker_date = runs.tracker_date
               AND r2.item_id = runs.item_id AND r2.deleted_at IS NULL
               AND json_type(r2.latest_data_json, '$.emplId') = 'text'
               AND TRIM(json_extract(r2.latest_data_json, '$.emplId')) != ''
             ORDER BY r2.run_ordinal DESC, r2.latest_tracker_ts DESC
             LIMIT 1
           ) AS latest_empl_id
    FROM runs
    WHERE workflow = @workflow AND tracker_date = @trackerDate AND item_id = @itemId
      AND deleted_at IS NULL
    ORDER BY run_ordinal DESC, latest_tracker_ts DESC
    LIMIT 1
  `).get(target) as {
    run_id: string;
    latest_status: string;
    latest_step: string | null;
    latest_tracker_ts: string;
    latest_data_json: string | null;
    latest_error: string | null;
    latest_empl_id: string | null;
  } | undefined;
  if (!latest) {
    db.prepare(`
      DELETE FROM items
      WHERE workflow = @workflow AND tracker_date = @trackerDate AND item_id = @itemId
    `).run(target);
    return;
  }
  const data = latest.latest_data_json
    ? JSON.parse(latest.latest_data_json) as Record<string, string>
    : {};
  const resolvedPrep = isResolvedPrepEntry({
    workflow: target.workflow,
    timestamp: latest.latest_tracker_ts,
    id: target.itemId,
    runId: latest.run_id,
    status: latest.latest_status as "pending" | "running" | "done" | "failed" | "skipped",
    ...(latest.latest_step ? { step: latest.latest_step } : {}),
    data,
  }) ? 1 : 0;
  db.prepare(`
    UPDATE items
    SET latest_run_id = @latestRunId,
        latest_status = @latestStatus,
        latest_step = @latestStep,
        latest_ts = @latestTs,
        latest_data_json = @latestDataJson,
        latest_error = @latestError,
        resolved_prep = @resolvedPrep,
        latest_empl_id = @latestEmplId,
        updated_at = @updatedAt
    WHERE workflow = @workflow AND tracker_date = @trackerDate AND item_id = @itemId
  `).run({
    ...target,
    latestRunId: latest.run_id,
    latestStatus: latest.latest_status,
    latestStep: latest.latest_step,
    latestTs: latest.latest_tracker_ts,
    latestDataJson: latest.latest_data_json,
    latestError: latest.latest_error,
    resolvedPrep,
    latestEmplId: latest.latest_empl_id,
    updatedAt: now,
  });
}

export function applyDeletionManifest(
  db: Database,
  manifest: DeletionManifest,
  source: { path: string; offset: number },
): void {
  const raw = JSON.stringify(manifest);
  for (const [targetIndex, target] of manifest.targets.entries()) {
    db.prepare(`
      INSERT OR IGNORE INTO deletion_tombstones (
        deletion_id, target_index, deleted_at, reason, workflow, tracker_date,
        item_id, run_id, source_path, source_offset, manifest_json
      ) VALUES (
        @deletionId, @targetIndex, @deletedAt, @reason, @workflow, @trackerDate,
        @itemId, @runId, @sourcePath, @sourceOffset, @manifestJson
      )
    `).run({
      deletionId: manifest.deletionId,
      targetIndex,
      deletedAt: manifest.deletedAt,
      reason: manifest.reason,
      ...target,
      sourcePath: source.path,
      sourceOffset: source.offset,
      manifestJson: raw,
    });
    db.prepare(`
      UPDATE runs
      SET deleted_at = @deletedAt, deletion_id = @deletionId
      WHERE workflow = @workflow AND tracker_date = @trackerDate
        AND item_id = @itemId AND run_id = @runId
    `).run({ ...target, deletedAt: manifest.deletedAt, deletionId: manifest.deletionId });
    recomputeItemProjection(db, target, manifest.deletedAt);
  }
}

export function persistDeletionManifest(
  db: Database,
  dir: string,
  targets: DeletionTarget[],
  reason: string,
): DeletionManifest | null {
  if (targets.length === 0) return null;
  const deletedAt = new Date().toISOString();
  const manifest: DeletionManifest = {
    deletionId: randomUUID(),
    deletedAt,
    reason,
    targets,
  };
  const path = deletionFilePath(localDate(new Date(deletedAt)), dir);
  const offset = appendJsonlLineLocked(path, manifest);
  invalidateDeletedRunKeys(dir);
  applyDeletionManifest(db, manifest, { path, offset });
  return manifest;
}

export function replayDeletionManifests(db: Database, dir: string): number {
  const root = deletionsDir(dir);
  if (!existsSync(root)) return 0;
  let applied = 0;
  for (const name of readdirSync(root).sort()) {
    if (!parseSessionFilename(name)) continue;
    const path = join(root, name);
    const raw = readFileSync(path, "utf8");
    let offset = 0;
    const lines = raw.split("\n");
    for (const [index, line] of lines.entries()) {
      const bytes = Buffer.byteLength(`${line}\n`);
      if (line.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch (error) {
          const incompleteFinalTail = index === lines.length - 1 && !raw.endsWith("\n");
          if (incompleteFinalTail) break;
          throw new Error(`Malformed deletion manifest at ${path}:line ${index + 1}`, {
            cause: error,
          });
        }
        if (!isDeletionManifest(parsed)) {
          throw new Error(`Invalid deletion manifest at ${path}:${offset}`);
        }
        applyDeletionManifest(db, parsed, { path, offset });
        applied += 1;
      }
      offset += bytes;
    }
  }
  return applied;
}
