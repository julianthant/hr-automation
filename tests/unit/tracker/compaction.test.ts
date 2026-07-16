import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { buildDeleteEntryHandler } from "../../../src/control/ops/delete.js";
import { compactTracker } from "../../../src/tracker/compaction.js";
import { writeFileAtomic } from "../../../src/tracker/fs-atomic.js";
import { emitTrackerRowForDate } from "../../../src/tracker/jsonl.js";
import {
  compactionArchiveFile,
  compactionJournalFile,
  compactionLockFile,
  compactionPendingFile,
  rowFilePath,
} from "../../../src/tracker/paths.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import { queryEntriesPayload } from "../../../src/tracker/state/queries.js";
import { rebuildProjectionForDate } from "../../../src/tracker/state/rebuild.js";

const DATE = "2026-07-16";
let dir: string;

function row(runId: string, itemId: string, timestamp: string): string {
  return JSON.stringify({
    workflow: "work-study", timestamp, id: itemId, runId,
    status: "failed", step: "failed", data: { archetype: "single" },
  });
}

function emit(runId: string, itemId: string, timestamp: string): void {
  emitTrackerRowForDate(JSON.parse(row(runId, itemId, timestamp)), DATE, dir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tracker-compaction-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("offline tracker compaction", () => {
  it("archives the original, removes tombstoned source rows, increments generation, and rebuilds", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE });

    const source = rowFilePath("work-study", DATE, dir);
    const original = readFileSync(source, "utf8");
    expect(compactTracker(db, dir)).toEqual({ filesCompacted: 1 });

    expect(readFileSync(source, "utf8")).toBe(`${row("run-keep", "item-keep", "2026-07-16T11:00:00.000Z")}\n`);
    expect(readFileSync(compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`), "utf8"))
      .toBe(original);
    expect((db.prepare("SELECT generation FROM source_generations WHERE path = ?").get(source) as {
      generation: number;
    }).generation).toBe(2);
    expect(queryEntriesPayload(db, { workflow: "work-study", date: DATE }).entries).toHaveLength(1);
    const projected = db.prepare(`
      SELECT source_generation, source_offset, run_id FROM run_events ORDER BY id
    `).all() as Array<{ source_generation: number; source_offset: number; run_id: string }>;
    expect(projected).toEqual([{ source_generation: 2, source_offset: 0, run_id: "run-keep" }]);
  });

  it("recovers a crash after the journal was persisted but before source replacement", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE });

    const source = rowFilePath("work-study", DATE, dir);
    const compacted = `${row("run-keep", "item-keep", "2026-07-16T11:00:00.000Z")}\n`;
    const pending = compactionPendingFile(dir);
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    const journal = compactionJournalFile(dir);
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileAtomic(archive, readFileSync(source));
    writeFileAtomic(pending, compacted);
    writeFileAtomic(journal, `${JSON.stringify({
      sourcePath: source,
      pendingPath: pending,
      archivePath: archive,
      originalSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      compactedSha256: createHash("sha256").update(compacted).digest("hex"),
      generation: 2,
      phase: "prepared",
    })}\n`);

    expect(compactTracker(db, dir)).toEqual({ filesCompacted: 0 });
    expect(readFileSync(source, "utf8")).toBe(compacted);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(pending)).toBe(false);
    expect(queryEntriesPayload(db, { workflow: "work-study", date: DATE }).entries).toHaveLength(1);
  });

  it("finishes a replaced journal when the pending file was already removed", () => {
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    const source = rowFilePath("work-study", DATE, dir);
    const original = readFileSync(source);
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    const journal = compactionJournalFile(dir);
    mkdirSync(dirname(archive), { recursive: true });
    mkdirSync(dirname(journal), { recursive: true });
    writeFileAtomic(archive, original);
    writeFileAtomic(journal, `${JSON.stringify({
      sourcePath: source,
      pendingPath: compactionPendingFile(dir),
      archivePath: archive,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      compactedSha256: createHash("sha256").update(original).digest("hex"),
      generation: 2,
      phase: "replaced",
    })}\n`);

    expect(compactTracker(db, dir)).toEqual({ filesCompacted: 0 });
    expect(existsSync(journal)).toBe(false);
  });

  it("preserves records appended after replacement when recovery resumes", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE });

    const source = rowFilePath("work-study", DATE, dir);
    const original = readFileSync(source);
    const compacted = `${row("run-keep", "item-keep", "2026-07-16T11:00:00.000Z")}\n`;
    const appended = `${row("run-new", "item-new", "2026-07-16T12:00:00.000Z")}\n`;
    const pending = compactionPendingFile(dir);
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    const journal = compactionJournalFile(dir);
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileAtomic(archive, original);
    writeFileAtomic(pending, compacted);
    writeFileAtomic(source, compacted);
    appendFileSync(source, appended);
    writeFileAtomic(journal, `${JSON.stringify({
      sourcePath: source,
      pendingPath: pending,
      archivePath: archive,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      compactedSha256: createHash("sha256").update(compacted).digest("hex"),
      generation: 2,
      phase: "replaced",
    })}\n`);

    expect(compactTracker(db, dir)).toEqual({ filesCompacted: 0 });
    expect(readFileSync(source, "utf8")).toBe(compacted + appended);
    expect(queryEntriesPayload(db, { workflow: "work-study", date: DATE }).entries)
      .toHaveLength(2);
  });

  it("preserves a complete final record that lacks only its trailing newline", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    const source = rowFilePath("work-study", DATE, dir);
    appendFileSync(source, row("run-keep", "item-keep", "2026-07-16T11:00:00.000Z"));
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE });

    expect(compactTracker(db, dir)).toEqual({ filesCompacted: 1 });
    expect(readFileSync(source, "utf8")).toBe(
      `${row("run-keep", "item-keep", "2026-07-16T11:00:00.000Z")}\n`,
    );
  });

  it("fails loud when an archive path already contains different bytes", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: DATE });
    buildDeleteEntryHandler(dir)({ workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE });
    const source = rowFilePath("work-study", DATE, dir);
    const original = readFileSync(source, "utf8");
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(archive, "unrelated archive bytes\n");

    expect(() => compactTracker(db, dir)).toThrow(/archive.*hash mismatch/i);
    expect(readFileSync(source, "utf8")).toBe(original);
  });

  it("rejects a recovery journal whose paths escape the tracker root", () => {
    const db = openStateDb(dir);
    const outside = join(dirname(dir), "outside-source.jsonl");
    writeFileSync(outside, `${row("outside", "outside", "2026-07-16T10:00:00.000Z")}\n`);
    const pending = compactionPendingFile(dir);
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    const journal = compactionJournalFile(dir);
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileAtomic(pending, "");
    writeFileAtomic(archive, readFileSync(outside));
    writeFileAtomic(journal, `${JSON.stringify({
      sourcePath: outside,
      pendingPath: pending,
      archivePath: archive,
      originalSha256: createHash("sha256").update(readFileSync(outside)).digest("hex"),
      compactedSha256: createHash("sha256").update("").digest("hex"),
      generation: 2,
      phase: "prepared",
    })}\n`);

    expect(() => compactTracker(db, dir)).toThrow(/outside tracker root|invalid.*source/i);
    expect(readFileSync(outside, "utf8")).toContain('"runId":"outside"');
    rmSync(outside, { force: true });
  });

  it("does not roll a source generation backward during journal recovery", () => {
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const db = openStateDb(dir);
    const source = rowFilePath("work-study", DATE, dir);
    const original = readFileSync(source);
    db.prepare(`
      INSERT INTO source_generations(path, generation, updated_at) VALUES (?, 3, ?)
    `).run(source, new Date().toISOString());
    const pending = compactionPendingFile(dir);
    const archive = compactionArchiveFile(dir, 1, "rows", `work-study-${DATE}.jsonl`);
    const journal = compactionJournalFile(dir);
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileAtomic(pending, original);
    writeFileAtomic(archive, original);
    writeFileAtomic(journal, `${JSON.stringify({
      sourcePath: source,
      pendingPath: pending,
      archivePath: archive,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      compactedSha256: createHash("sha256").update(original).digest("hex"),
      generation: 2,
      phase: "replaced",
    })}\n`);

    expect(() => compactTracker(db, dir)).toThrow(/generation.*3.*2|generation mismatch/i);
    expect((db.prepare("SELECT generation FROM source_generations WHERE path = ?").get(source) as {
      generation: number;
    }).generation).toBe(3);
  });

  it("refuses a second compactor while the tracker-wide lock is held", () => {
    const db = openStateDb(dir);
    const lock = compactionLockFile(dir);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });

    expect(() => compactTracker(db, dir, { lockTimeoutMs: 20 }))
      .toThrow(/compaction lock/i);
  });

  it("uses one canonical source identity across absolute compaction and relative rebuilds", () => {
    emit("run-delete", "item-delete", "2026-07-16T10:00:00.000Z");
    emit("run-keep", "item-keep", "2026-07-16T11:00:00.000Z");
    const absoluteDir = resolve(dir);
    const db = openStateDb(absoluteDir);
    rebuildProjectionForDate(db, { dir: absoluteDir, date: DATE });
    buildDeleteEntryHandler(absoluteDir)({
      workflow: "work-study", id: "item-delete", runId: "run-delete", date: DATE,
    });
    compactTracker(db, absoluteDir);
    closeStateDbForTests(absoluteDir);

    const relativeDir = relative(process.cwd(), absoluteDir);
    const reopened = openStateDb(relativeDir);
    rebuildProjectionForDate(reopened, { dir: relativeDir, date: DATE });
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n)
      .toBe(1);
  });
});
