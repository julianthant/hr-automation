import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closeStateDbForTests,
  openStateDb,
} from "../../../../src/tracker/state/db.js";
import { applyTrackerEntry } from "../../../../src/tracker/state/apply.js";
import { sweepStaleRunScreenshots } from "../../../../src/tracker/state/screenshot-sweep.js";
import { registerLocalFile } from "../../../../src/tracker/files/files.js";
import type { TrackerEntry } from "../../../../src/tracker/jsonl.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function msDaysAgo(days: number): number {
  return Date.now() - days * 24 * 3600 * 1000;
}

function writePng(dir: string, name: string): string {
  const full = join(dir, name);
  writeFileSync(full, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return full;
}

describe("sweepStaleRunScreenshots", () => {
  let trackerDir: string;
  let screenshotsDir: string;

  beforeEach(() => {
    trackerDir = mkdtempSync(join(tmpdir(), "sweep-state-"));
    screenshotsDir = mkdtempSync(join(tmpdir(), "sweep-shots-"));
  });

  afterEach(() => {
    closeStateDbForTests(trackerDir);
    rmSync(trackerDir, { recursive: true, force: true });
    rmSync(screenshotsDir, { recursive: true, force: true });
  });

  function seedRun(
    db: ReturnType<typeof openStateDb>,
    opts: { workflow?: string; runId: string; itemId: string; status: TrackerEntry["status"]; ts: string },
  ): void {
    const workflow = opts.workflow ?? "x";
    const entry: TrackerEntry = {
      workflow,
      id: opts.itemId,
      runId: opts.runId,
      timestamp: opts.ts,
      status: opts.status,
      data: {},
    };
    applyTrackerEntry(db, entry, {
      sourceKind: "tracker",
      path: "fake.jsonl",
      line: 1,
      offset: 1,
      trackerDate: opts.ts.slice(0, 10),
    });
  }

  it("does not delete screenshots when another workflow shares the same run_id", () => {
    const db = openStateDb(trackerDir);
    const ts = isoDaysAgo(45);
    const sharedRunId = "10873698#1";
    seedRun(db, { workflow: "eid-lookup", runId: sharedRunId, itemId: "10873698", status: "done", ts });
    seedRun(db, { workflow: "work-study", runId: sharedRunId, itemId: "10873698", status: "running", ts });
    const activePng = writePng(screenshotsDir, "work-study-10873698-step-sys-9000.png");
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: activePng,
      originalName: "work-study-10873698-step-sys-9000.png",
      source: "test",
      workflow: "work-study",
      itemId: "10873698",
      runId: sharedRunId,
    });

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    assert.equal(result.terminalRunFilesDeleted, 0);
    assert.equal(existsSync(activePng), true);
  });

  it("deletes screenshots for runs terminal_at > 30 days ago", () => {
    const db = openStateDb(trackerDir);
    const ts = isoDaysAgo(45);
    seedRun(db, { runId: "old-run", itemId: "i1", status: "done", ts });
    const pngPath = writePng(screenshotsDir, "x-i1-step-sys-1000.png");
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: pngPath,
      originalName: "x-i1-step-sys-1000.png",
      source: "test",
      workflow: "x",
      itemId: "i1",
      runId: "old-run",
    });

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    assert.equal(result.terminalRunFilesDeleted, 1);
    assert.equal(result.fileRowsDeleted, 1);
    assert.equal(existsSync(pngPath), false);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    assert.equal(remaining.n, 0);
  });

  it("preserves screenshots for runs terminal_at < 30 days ago", () => {
    const db = openStateDb(trackerDir);
    seedRun(db, { runId: "fresh-run", itemId: "i2", status: "done", ts: isoDaysAgo(5) });
    const pngPath = writePng(screenshotsDir, "x-i2-step-sys-2000.png");
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: pngPath,
      originalName: "x-i2-step-sys-2000.png",
      source: "test",
      workflow: "x",
      itemId: "i2",
      runId: "fresh-run",
    });

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    assert.equal(result.terminalRunFilesDeleted, 0);
    assert.equal(existsSync(pngPath), true);
  });

  it("preserves screenshots for non-terminal runs even when old", () => {
    const db = openStateDb(trackerDir);
    seedRun(db, { runId: "stuck-run", itemId: "i3", status: "running", ts: isoDaysAgo(45) });
    const pngPath = writePng(screenshotsDir, "x-i3-step-sys-3000.png");
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: pngPath,
      originalName: "x-i3-step-sys-3000.png",
      source: "test",
      workflow: "x",
      itemId: "i3",
      runId: "stuck-run",
    });

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    // Registered + run not terminal → terminal-run pass keeps it.
    // Orphan pass also skips it because it's registered in `files`.
    assert.equal(result.terminalRunFilesDeleted, 0);
    assert.equal(result.orphanFilesDeleted, 0);
    assert.equal(existsSync(pngPath), true);
  });

  it("backstop deletes orphan PNGs > 30 days old that are not in files table", () => {
    openStateDb(trackerDir); // initialize DB
    const oldOrphan = writePng(screenshotsDir, `wf-item-step-sys-${msDaysAgo(45)}.png`);
    const freshOrphan = writePng(screenshotsDir, `wf-item-step-sys-${msDaysAgo(5)}.png`);

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    assert.equal(result.orphanFilesDeleted, 1);
    assert.equal(existsSync(oldOrphan), false);
    assert.equal(existsSync(freshOrphan), true);
  });

  it("skips orphan PNGs registered in files (regardless of age)", () => {
    const db = openStateDb(trackerDir);
    // A registered but RUNNING run's screenshot. Orphan pass must not delete it.
    seedRun(db, { runId: "run-X", itemId: "iX", status: "running", ts: isoDaysAgo(45) });
    const png = writePng(screenshotsDir, `wf-iX-step-sys-${msDaysAgo(45)}.png`);
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: png,
      originalName: "wf-iX-step-sys.png",
      source: "test",
      workflow: "x",
      itemId: "iX",
      runId: "run-X",
    });

    const result = sweepStaleRunScreenshots(trackerDir, screenshotsDir, 30);

    assert.equal(result.orphanFilesDeleted, 0);
    assert.equal(existsSync(png), true);
  });

  it("no-op when state DB is not initialized", () => {
    const fresh = mkdtempSync(join(tmpdir(), "sweep-empty-"));
    try {
      const result = sweepStaleRunScreenshots(fresh, screenshotsDir, 30);
      assert.equal(result.terminalRunFilesDeleted, 0);
      assert.equal(result.orphanFilesDeleted, 0);
      assert.equal(result.fileRowsDeleted, 0);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("stamps runs.terminal_at when status becomes terminal", () => {
    const db = openStateDb(trackerDir);
    // Use a single tracker_date so all three events hit the same PK row.
    const today = new Date();
    const baseDate = today.toISOString().slice(0, 10);
    const runningTs = `${baseDate}T01:00:00.000Z`;
    const doneTs = `${baseDate}T02:00:00.000Z`;
    const laterRunningTs = `${baseDate}T03:00:00.000Z`;

    seedRun(db, { runId: "r1", itemId: "i1", status: "running", ts: runningTs });
    let row = db
      .prepare("SELECT terminal_at FROM runs WHERE run_id = ?")
      .get("r1") as { terminal_at: string | null };
    assert.equal(row.terminal_at, null);

    seedRun(db, { runId: "r1", itemId: "i1", status: "done", ts: doneTs });
    row = db
      .prepare("SELECT terminal_at FROM runs WHERE run_id = ?")
      .get("r1") as { terminal_at: string | null };
    assert.equal(row.terminal_at, doneTs);

    // Subsequent non-terminal events must not clear it.
    seedRun(db, { runId: "r1", itemId: "i1", status: "running", ts: laterRunningTs });
    row = db
      .prepare("SELECT terminal_at FROM runs WHERE run_id = ?")
      .get("r1") as { terminal_at: string | null };
    assert.equal(row.terminal_at, doneTs, "terminal_at preserved on later non-terminal write");

    // Silence unused-imports.
    void resolve(screenshotsDir);
    if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir);
  });
});
