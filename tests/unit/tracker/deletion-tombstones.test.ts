import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildDeleteEntryHandler } from "../../../src/control/ops/delete.js";
import { emitTrackerRowForDate } from "../../../src/tracker/jsonl.js";
import { deletionFilePath } from "../../../src/tracker/paths.js";
import { readDeletedRunKeys } from "../../../src/tracker/deletions/visible.js";
import { replayDeletionManifests } from "../../../src/tracker/deletions/store.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import {
  queryEntriesPayload,
  queryRunsForItem,
  querySessionEventsForRun,
} from "../../../src/tracker/state/queries.js";
import { rebuildProjectionForDate } from "../../../src/tracker/state/rebuild.js";

const DATE = "2026-07-16";
let dir: string;

/**
 * Tombstone manifests are partitioned by DELETION time (deletedAt = now),
 * not by the deleted row's tracker date — so the file to assert on is
 * today's partition, whatever day the suite runs.
 */
function todayDeletionPartition(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function emit(runId: string, timestamp: string): void {
  emitTrackerRowForDate({
    workflow: "work-study",
    timestamp,
    id: "item-1",
    runId,
    status: "failed",
    step: "failed",
    data: { archetype: "single", emplId: runId === "run-1" ? "10000001" : "10000002" },
  }, DATE, dir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deletion-tombstone-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("append-only deletion tombstones", () => {
  it("hides one run, promotes the previous run, and preserves all audit rows", () => {
    emit("run-1", "2026-07-16T10:00:00.000Z");
    emit("run-2", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });

    const result = buildDeleteEntryHandler(dir)({
      workflow: "work-study", id: "item-1", runId: "run-2", date: DATE,
    });
    expect(result).toEqual({ ok: true });

    expect(queryRunsForItem(db, { workflow: "work-study", itemId: "item-1", date: DATE }))
      .toHaveLength(1);
    expect(queryEntriesPayload(db, { workflow: "work-study", date: DATE }).entries)
      .toHaveLength(1);
    expect((db.prepare("SELECT latest_run_id, latest_empl_id FROM items").get() as {
      latest_run_id: string; latest_empl_id: string;
    })).toEqual({ latest_run_id: "run-1", latest_empl_id: "10000001" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(2);
    expect(readFileSync(deletionFilePath(todayDeletionPartition(), dir), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("replays a durable manifest after an interrupted SQLite application and stays idempotent", () => {
    emit("run-1", "2026-07-16T10:00:00.000Z");
    emit("run-2", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-1", runId: "run-2", date: DATE });

    db.exec("UPDATE runs SET deleted_at = NULL, deletion_id = NULL");
    db.exec("UPDATE items SET latest_run_id = 'run-2', latest_status = 'failed', latest_ts = '2026-07-16T11:00:00.000Z'");
    rebuildProjectionForDate(db, { dir, date: DATE });
    rebuildProjectionForDate(db, { dir, date: DATE });

    const deleted = db.prepare("SELECT deleted_at FROM runs WHERE run_id = 'run-2'").get() as { deleted_at: string | null };
    expect(deleted.deleted_at).not.toBeNull();
    expect((db.prepare("SELECT latest_run_id FROM items").get() as { latest_run_id: string }).latest_run_id)
      .toBe("run-1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM deletion_tombstones").get() as { n: number }).n).toBe(1);
  });

  it("reuses a manifest projection while the deletion sources are unchanged", () => {
    emit("run-1", "2026-07-16T10:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({
      workflow: "work-study", id: "item-1", runId: "run-1", date: DATE,
    });
    const manifestPath = deletionFilePath(todayDeletionPartition(), dir);

    expect(readDeletedRunKeys(dir)).toHaveLength(1);
    chmodSync(manifestPath, 0o000);
    try {
      expect(readDeletedRunKeys(dir)).toHaveLength(1);
    } finally {
      chmodSync(manifestPath, 0o600);
    }
  });

  it("does not hide a future run for the same item", () => {
    emit("run-1", "2026-07-16T10:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-1", date: DATE });

    emit("run-3", "2026-07-16T12:00:00.000Z");
    rebuildProjectionForDate(db, { dir, date: DATE });
    const runs = queryRunsForItem(db, { workflow: "work-study", itemId: "item-1", date: DATE });
    expect(runs.map((run) => run.runId)).toEqual(["run-3"]);
  });

  it("fails loud on a malformed complete manifest line instead of skipping later tombstones", () => {
    const path = deletionFilePath(DATE, dir);
    mkdirSync(dirname(path), { recursive: true });
    const manifest = (deletionId: string, runId: string) => JSON.stringify({
      deletionId,
      deletedAt: "2026-07-16T12:00:00.000Z",
      reason: "test",
      targets: [{
        workflow: "work-study",
        trackerDate: DATE,
        itemId: "item-1",
        runId,
      }],
    });
    writeFileSync(path, `${manifest("d1", "run-1")}\n{ malformed }\n${manifest("d2", "run-2")}\n`);

    expect(() => replayDeletionManifests(openStateDb(dir), dir))
      .toThrow(/malformed deletion manifest.*line 2/i);
  });

  it("hides session events from normal scoped readers while retaining raw audit rows", () => {
    emit("run-1", "2026-07-16T10:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    const raw = JSON.stringify({
      type: "item_start",
      runId: "run-1",
      timestamp: "2026-07-16T10:00:00.000Z",
      ts: Date.parse("2026-07-16T10:00:00.000Z"),
    });
    db.prepare(`
      INSERT INTO session_events (
        source_path, source_generation, source_line, source_offset, event_type,
        run_id, timestamp, ts_ms, tracker_date, raw_json, applied_at
      ) VALUES ('fixture', 1, 1, 0, 'item_start', 'run-1', @timestamp, @ts,
        @date, @raw, @timestamp)
    `).run({
      timestamp: "2026-07-16T10:00:00.000Z",
      ts: Date.parse("2026-07-16T10:00:00.000Z"),
      date: DATE,
      raw,
    });
    buildDeleteEntryHandler(dir)({
      workflow: "work-study", id: "item-1", runId: "run-1", date: DATE,
    });

    expect(querySessionEventsForRun(db, {
      workflow: "work-study",
      itemId: "item-1",
      trackerDate: DATE,
      runId: "run-1",
    })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n)
      .toBe(1);
  });
});
