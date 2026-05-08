import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanOldTrackerFiles,
  cleanOldScreenshots,
  dateLocal,
  trackEvent,
} from "../../../../src/tracker/jsonl.js";
import { cleanTrackerMain } from "../../../../src/scripts/ops/clean-tracker.js";
import {
  openStateDb,
  closeStateDbForTests,
} from "../../../../src/tracker/state/db.js";

// Dedicated tmp dir to keep the real .tracker/ untouched.
const TEST_DIR = ".tracker-clean-test";

function writeFixture(filename: string, ageDays: number): string {
  const fullPath = join(TEST_DIR, filename);
  writeFileSync(fullPath, '{"test":true}\n');
  // Set mtime + atime to ageDays in the past. `cleanOldTrackerFiles` uses the
  // date embedded in the filename (YYYY-MM-DD), not mtime — but we still set
  // both to keep the fixture honest if the implementation ever changes.
  const t = new Date();
  t.setDate(t.getDate() - ageDays);
  utimesSync(fullPath, t, t);
  return fullPath;
}

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dateLocal(d);
}

describe("cleanOldTrackerFiles (clean-tracker script)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("deletes only files whose filename-date is older than maxAgeDays", () => {
    writeFixture(`test-${isoDate(1)}.jsonl`, 1);
    writeFixture(`test-${isoDate(5)}.jsonl`, 5);
    writeFixture(`test-${isoDate(30)}.jsonl`, 30);

    const deleted = cleanOldTrackerFiles(7, TEST_DIR);

    assert.equal(deleted, 1, "should delete 1 file (the 30-day-old one)");
    const remaining = readdirSync(TEST_DIR).sort();
    assert.equal(remaining.length, 2);
    assert.ok(
      remaining.some((f) => f.includes(isoDate(1))),
      "1-day-old file kept"
    );
    assert.ok(
      remaining.some((f) => f.includes(isoDate(5))),
      "5-day-old file kept"
    );
    assert.ok(
      !remaining.some((f) => f.includes(isoDate(30))),
      "30-day-old file deleted"
    );
  });

  it("returns 0 when directory does not exist", () => {
    const missing = ".tracker-missing-" + Date.now();
    assert.equal(cleanOldTrackerFiles(7, missing), 0);
  });

  it("ignores non-jsonl files", () => {
    writeFixture(`test-${isoDate(30)}.txt`, 30);
    writeFixture(`test-${isoDate(30)}.jsonl`, 30);
    const deleted = cleanOldTrackerFiles(7, TEST_DIR);
    assert.equal(deleted, 1);
    const remaining = readdirSync(TEST_DIR);
    assert.ok(remaining.some((f) => f.endsWith(".txt")));
  });

  it("respects custom maxAgeDays", () => {
    writeFixture(`test-${isoDate(3)}.jsonl`, 3);
    writeFixture(`test-${isoDate(10)}.jsonl`, 10);

    // With --days 1, both files should be deleted.
    const deleted = cleanOldTrackerFiles(1, TEST_DIR);
    assert.equal(deleted, 2);
    assert.equal(readdirSync(TEST_DIR).length, 0);
  });
});

// Screenshots encode their timestamp as ms-since-epoch in the trailing segment
// of the filename: `<workflow>-<itemId>-<step>-<systemId>-<ts>.png`.
// The cleaner parses that integer and compares to `Date.now() - maxAgeDays`.

const SCREENSHOTS_TEST_DIR = ".screenshots-clean-test";

function tsFromDaysAgo(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 60 * 60 * 1000;
}

function writeScreenshotFixture(filename: string): string {
  const fullPath = join(SCREENSHOTS_TEST_DIR, filename);
  // 1x1 transparent PNG — content doesn't matter for mtime-based tests, but we
  // keep it short & on-disk so unlinkSync has something to delete.
  writeFileSync(fullPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return fullPath;
}

describe("cleanOldScreenshots (clean-tracker screenshots support)", () => {
  beforeEach(() => {
    if (existsSync(SCREENSHOTS_TEST_DIR)) rmSync(SCREENSHOTS_TEST_DIR, { recursive: true });
    mkdirSync(SCREENSHOTS_TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(SCREENSHOTS_TEST_DIR)) rmSync(SCREENSHOTS_TEST_DIR, { recursive: true });
  });

  it("deletes only screenshots whose filename-embedded ts is older than maxAgeDays (7 days)", () => {
    writeScreenshotFixture(`onboarding-a@x.edu-extraction-crm-${tsFromDaysAgo(0)}.png`);
    writeScreenshotFixture(`onboarding-b@x.edu-extraction-crm-${tsFromDaysAgo(5)}.png`);
    writeScreenshotFixture(`onboarding-c@x.edu-extraction-crm-${tsFromDaysAgo(30)}.png`);

    const deleted = cleanOldScreenshots(7, SCREENSHOTS_TEST_DIR);

    assert.equal(deleted, 1, "should delete 1 file (the 30-day-old one)");
    const remaining = readdirSync(SCREENSHOTS_TEST_DIR).sort();
    assert.equal(remaining.length, 2);
    assert.ok(
      remaining.some((f) => f.includes("a@x.edu")),
      "today's screenshot kept"
    );
    assert.ok(
      remaining.some((f) => f.includes("b@x.edu")),
      "5-day-old screenshot kept"
    );
    assert.ok(
      !remaining.some((f) => f.includes("c@x.edu")),
      "30-day-old screenshot deleted"
    );
  });

  it("returns 0 when directory does not exist", () => {
    const missing = ".screenshots-missing-" + Date.now();
    assert.equal(cleanOldScreenshots(7, missing), 0);
  });

  it("ignores non-png files", () => {
    writeScreenshotFixture(`sep-01-extract-kuali-${tsFromDaysAgo(30)}.txt`);
    writeScreenshotFixture(`sep-02-extract-kuali-${tsFromDaysAgo(30)}.png`);
    const deleted = cleanOldScreenshots(7, SCREENSHOTS_TEST_DIR);
    assert.equal(deleted, 1);
    const remaining = readdirSync(SCREENSHOTS_TEST_DIR);
    assert.ok(remaining.some((f) => f.endsWith(".txt")));
  });

  it("skips files whose trailing segment is not numeric (malformed names)", () => {
    writeScreenshotFixture("no-timestamp-here.png");
    writeScreenshotFixture(`good-file-extract-sys-${tsFromDaysAgo(30)}.png`);
    const deleted = cleanOldScreenshots(7, SCREENSHOTS_TEST_DIR);
    assert.equal(deleted, 1, "only the well-formed 30-day-old file is deleted");
    const remaining = readdirSync(SCREENSHOTS_TEST_DIR);
    assert.ok(remaining.some((f) => f === "no-timestamp-here.png"));
  });

  it("respects custom maxAgeDays", () => {
    writeScreenshotFixture(`wf-01-step-sys-${tsFromDaysAgo(3)}.png`);
    writeScreenshotFixture(`wf-02-step-sys-${tsFromDaysAgo(10)}.png`);
    // With --days 1, both should be deleted (their ts is >= 1 day old).
    const deleted = cleanOldScreenshots(1, SCREENSHOTS_TEST_DIR);
    assert.equal(deleted, 2);
    assert.equal(readdirSync(SCREENSHOTS_TEST_DIR).length, 0);
  });
});

describe("cleanTrackerMain sessionsDeleted field", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clean-sess-"));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns sessionsDeleted field in result", () => {
    const result = cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);
    assert.ok("sessionsDeleted" in result, "sessionsDeleted field present");
    assert.equal(typeof result.sessionsDeleted, "number");
  });

  it("deletes old sessions-YYYY-MM-DD.jsonl files and returns count", () => {
    // Write an old dated sessions file (40 days ago).
    const oldDate = isoDate(40);
    const oldFile = join(dir, `sessions-${oldDate}.jsonl`);
    writeFileSync(oldFile, '{"type":"workflow_start","workflowInstance":"old"}\n');
    // Write a recent dated sessions file (1 day ago).
    const recentDate = isoDate(1);
    const recentFile = join(dir, `sessions-${recentDate}.jsonl`);
    writeFileSync(recentFile, '{"type":"workflow_start","workflowInstance":"recent"}\n');

    const result = cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);
    assert.equal(result.sessionsDeleted, 1, "only the 40-day-old file deleted");
    assert.ok(!existsSync(oldFile), "old file deleted");
    assert.ok(existsSync(recentFile), "recent file kept");
  });
});

describe("cleanTrackerMain SQLite prune", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `clean-sql-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes SQLite rows whose tracker_date is older than --days", () => {
    // Initialize the DB before seeding — applyTrackerEntryLive skips SQLite
    // when the DB file doesn't exist yet (isStateDbReady returns false).
    const db = openStateDb(dir);

    // Seed two tracker entries: one fresh (today), one ancient (90 days ago).
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    trackEvent(
      { workflow: "x", id: "1", runId: "r1", timestamp: old, status: "done", data: {} },
      dir,
    );
    trackEvent(
      { workflow: "x", id: "2", runId: "r2", timestamp: today, status: "done", data: {} },
      dir,
    );

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n,
      2,
    );

    cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);

    const remaining = db.prepare("SELECT item_id FROM run_events").all() as Array<{ item_id: string }>;
    assert.deepEqual(
      remaining.map((r) => ({ ...r })).map((r) => r.item_id),
      ["2"],
    );
  });

  it("returns sqlRowsDeleted count in result", () => {
    // Initialize the DB before seeding so applyTrackerEntryLive writes to it.
    openStateDb(dir);

    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    trackEvent(
      { workflow: "x", id: "3", runId: "r3", timestamp: old, status: "done", data: {} },
      dir,
    );

    const result = cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);
    assert.ok(
      "sqlRowsDeleted" in result,
      "cleanTrackerMain result should include sqlRowsDeleted",
    );
    assert.ok(
      result.sqlRowsDeleted > 0,
      "sqlRowsDeleted should be > 0 when old rows exist",
    );
  });
});

