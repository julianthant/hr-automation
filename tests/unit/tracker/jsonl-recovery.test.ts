import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  recoverTornJsonlTails,
  truncateToLastNewline,
} from "../../../src/tracker/jsonl-recovery.js";
import {
  dateLocal,
  emitTrackerRow,
  readEntriesForDate,
  __resetParseCacheForTests,
} from "../../../src/tracker/jsonl.js";
import { logsDir, rowFilePath, rowsDir, sessionFilePath, sessionsDir, logFilePath } from "../../../src/tracker/paths.js";
import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { rebuildProjectionForDate } from "../../../src/tracker/state/rebuild.js";

const ROW_A = JSON.stringify({
  workflow: "x", timestamp: "2026-07-16T10:00:00.000Z", id: "item-1", runId: "r1",
  status: "pending", data: { archetype: "single" },
});
const ROW_B = JSON.stringify({
  workflow: "x", timestamp: "2026-07-16T10:00:01.000Z", id: "item-1", runId: "r1",
  status: "running", data: { archetype: "single" },
});
/** A crash mid-write: a torn fragment with NO trailing newline. */
const TORN_FRAGMENT = '{"workflow":"x","sta';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-recovery-"));
  __resetParseCacheForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("truncateToLastNewline", () => {
  it("truncates a torn tail back to the last complete newline and reports bytes dropped", () => {
    const file = join(dir, "torn.jsonl");
    writeFileSync(file, `${ROW_A}\n${ROW_B}\n${TORN_FRAGMENT}`);
    const dropped = truncateToLastNewline(file);
    assert.equal(dropped, TORN_FRAGMENT.length);
    assert.equal(readFileSync(file, "utf8"), `${ROW_A}\n${ROW_B}\n`);
  });

  it("is a no-op for a newline-terminated file", () => {
    const file = join(dir, "healthy.jsonl");
    writeFileSync(file, `${ROW_A}\n`);
    assert.equal(truncateToLastNewline(file), 0);
    assert.equal(readFileSync(file, "utf8"), `${ROW_A}\n`);
  });

  it("is a no-op for an empty file and a missing file", () => {
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    assert.equal(truncateToLastNewline(empty), 0);
    assert.equal(readFileSync(empty, "utf8"), "");
    assert.equal(truncateToLastNewline(join(dir, "does-not-exist.jsonl")), 0);
  });

  it("truncates a file that is ONLY a torn fragment (no newline at all) to zero bytes", () => {
    const file = join(dir, "all-torn.jsonl");
    writeFileSync(file, TORN_FRAGMENT);
    assert.equal(truncateToLastNewline(file), TORN_FRAGMENT.length);
    assert.equal(readFileSync(file, "utf8"), "");
  });

  it("preserves a complete JSON record when only its final newline was interrupted", () => {
    const file = join(dir, "complete-no-newline.jsonl");
    writeFileSync(file, `${ROW_A}\n${ROW_B}`);
    assert.equal(truncateToLastNewline(file), 0);
    assert.equal(readFileSync(file, "utf8"), `${ROW_A}\n${ROW_B}\n`);
  });

  it("finds a newline beyond the scan-chunk boundary (torn tail longer than one chunk)", () => {
    const file = join(dir, "long-tail.jsonl");
    const longFragment = '{"pad":"' + "x".repeat(10_000);
    writeFileSync(file, `${ROW_A}\n${longFragment}`);
    assert.equal(truncateToLastNewline(file), longFragment.length);
    assert.equal(readFileSync(file, "utf8"), `${ROW_A}\n`);
  });
});

describe("recoverTornJsonlTails", () => {
  it("sweeps rows/, logs/, and sessions/ — truncating torn tails and leaving healthy files alone", () => {
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    mkdirSync(logsDir(dir), { recursive: true });
    mkdirSync(sessionsDir(dir), { recursive: true });

    const rowFile = rowFilePath("x", date, dir);
    writeFileSync(rowFile, `${ROW_A}\n${TORN_FRAGMENT}`);
    const logFile = logFilePath("x", date, dir);
    writeFileSync(logFile, `{"workflow":"x","itemId":"item-1","level":"step","message":"m","ts":"2026-07-16T10:00:00.000Z"}\n`);
    const sessionFile = sessionFilePath(date, dir);
    writeFileSync(sessionFile, `{"type":"workflow_start","timestamp":"2026-07-16T10:00:00.000Z","pid":1,"workflowInstance":"x 1"}\n{"type":"item_st`);

    const recovered = recoverTornJsonlTails(dir);
    const byPath = new Map(recovered.map((r) => [r.path, r.bytesDropped]));
    assert.equal(byPath.get(rowFile), TORN_FRAGMENT.length);
    assert.equal(byPath.get(sessionFile), '{"type":"item_st'.length);
    assert.equal(byPath.has(logFile), false, "healthy log file must not be reported");
    assert.equal(recovered.length, 2);

    assert.ok(readFileSync(rowFile, "utf8").endsWith("\n"));
    assert.ok(readFileSync(sessionFile, "utf8").endsWith("\n"));
  });

  it("no-ops cleanly when the tracker subdirs do not exist yet", () => {
    assert.deepEqual(recoverTornJsonlTails(dir), []);
  });
});

describe("torn-write self-heal on append (appendJsonlWithSource tail check)", () => {
  it("keeps a complete newline-less record before appending the next record", () => {
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    const rowFile = rowFilePath("x", date, dir);
    writeFileSync(rowFile, ROW_A);

    emitTrackerRow({
      workflow: "x",
      timestamp: new Date().toISOString(),
      id: "item-1",
      runId: "r1",
      status: "done",
      data: { archetype: "single" },
    }, dir);

    const lines = readFileSync(rowFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).status), ["pending", "done"]);
  });

  it("a torn tail is truncated before the next emitTrackerRow, so the file stays fully parseable", () => {
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    const rowFile = rowFilePath("x", date, dir);
    appendFileSync(rowFile, `${ROW_A}\n${TORN_FRAGMENT}`);

    emitTrackerRow(
      {
        workflow: "x",
        timestamp: new Date().toISOString(),
        id: "item-1",
        runId: "r1",
        status: "done",
        data: { archetype: "single" },
      },
      dir,
    );

    const lines = readFileSync(rowFile, "utf8").split("\n").filter(Boolean);
    // Every line parses — the torn fragment did NOT fuse with the new row.
    for (const line of lines) JSON.parse(line);
    assert.equal(lines.length, 2);
    const entries = readEntriesForDate("x", date, dir);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].status, "done");
  });

  it("serializes offset calculation and append across multiple processes", async () => {
    const file = join(dir, "rows", "lock-test-2026-07-16.jsonl");
    const workerScript = join(process.cwd(), "tests", "fixtures", "jsonl-append-worker.ts");
    const runWorker = (worker: string): Promise<number[]> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerScript, file, worker], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`append worker ${worker} exited ${String(code)}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as number[]);
      });
    });

    const reportedOffsets = (await Promise.all(["a", "b", "c", "d"].map(runWorker))).flat();
    const rawLines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(rawLines.length, 200);
    for (const line of rawLines) JSON.parse(line);

    const actualOffsets: number[] = [];
    let offset = 0;
    for (const line of rawLines) {
      actualOffsets.push(offset);
      offset += Buffer.byteLength(`${line}\n`);
    }
    assert.equal(new Set(reportedOffsets).size, 200);
    assert.deepEqual(reportedOffsets.toSorted((a, b) => a - b), actualOffsets);
  }, 20_000);
});

describe("projection checkpoint after torn-tail truncation", () => {
  it("checkpoints only through the last complete newline", () => {
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    const rowFile = rowFilePath("x", date, dir);
    // Two complete rows + a torn tail on disk when the projection checkpoints.
    writeFileSync(rowFile, `${ROW_A}\n${ROW_B}\n${TORN_FRAGMENT}`);

    const db = openStateDb(dir);
    try {
      rebuildProjectionForDate(db, { dir, date });
      const checkpoint = db
        .prepare(`SELECT byte_offset FROM projection_sources WHERE path = ?`)
        .get(rowFile) as { byte_offset: number };
      assert.equal(checkpoint.byte_offset, ROW_A.length + ROW_B.length + 2);

      // Boot recovery truncates, then a new complete row is appended — the
      // file is now SHORTER than the checkpoint plus one row.
      assert.equal(truncateToLastNewline(rowFile), TORN_FRAGMENT.length);
      const rowC = JSON.stringify({
        workflow: "x", timestamp: "2026-07-16T10:00:02.000Z", id: "item-1", runId: "r1",
        status: "done", data: { archetype: "single" },
      });
      appendFileSync(rowFile, `${rowC}\n`);

      // The shrink-detection path (rebuild.ts parseJsonlFrom) resets to 0 and
      // INSERT OR IGNORE dedupes the replayed rows — the new row must land.
      rebuildProjectionForDate(db, { dir, date });
      const run = db
        .prepare(`SELECT latest_status FROM runs WHERE workflow = 'x' AND run_id = 'r1' AND tracker_date = ?`)
        .get(date) as { latest_status: string };
      assert.equal(run.latest_status, "done");
      const eventCount = db
        .prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'x' AND run_id = 'r1'`)
        .get() as { n: number };
      assert.equal(eventCount.n, 3);
    } finally {
      closeStateDbForTests(dir);
    }
  });

  it("replays a JSON object whose newline arrives after an interrupted rebuild", () => {
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    const rowFile = rowFilePath("x", date, dir);
    writeFileSync(rowFile, `${ROW_A}\n${ROW_B}`);

    const db = openStateDb(dir);
    try {
      rebuildProjectionForDate(db, { dir, date });
      const firstCheckpoint = db
        .prepare(`SELECT byte_offset FROM projection_sources WHERE path = ?`)
        .get(rowFile) as { byte_offset: number };
      assert.equal(firstCheckpoint.byte_offset, ROW_A.length + 1);

      appendFileSync(rowFile, "\n");
      rebuildProjectionForDate(db, { dir, date });

      const run = db
        .prepare(`SELECT latest_status FROM runs WHERE workflow = 'x' AND run_id = 'r1' AND tracker_date = ?`)
        .get(date) as { latest_status: string };
      assert.equal(run.latest_status, "running");
      const eventCount = db
        .prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'x' AND run_id = 'r1'`)
        .get() as { n: number };
      assert.equal(eventCount.n, 2);
    } finally {
      closeStateDbForTests(dir);
    }
  });
});
