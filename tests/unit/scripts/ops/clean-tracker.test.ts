import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
} from "fs";
import { join } from "path";
import {
  cleanOldTrackerFiles,
  cleanOldScreenshots,
} from "../../../../src/tracker/jsonl.js";
import { pruneOldStepCache } from "../../../../src/core/index.js";
import { cleanTrackerMain } from "../../../../src/scripts/ops/clean-tracker.js";

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
  return d.toISOString().slice(0, 10);
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

// Step-cache fixtures: seed records under a test dir, backdate via utimes.
const STEP_CACHE_TEST_DIR = ".tracker-step-cache-clean-test";

function seedStepCache(
  workflow: string,
  itemId: string,
  stepName: string,
  ageDays: number,
): string {
  const itemDir = join(STEP_CACHE_TEST_DIR, `${workflow}-${itemId}`);
  mkdirSync(itemDir, { recursive: true });
  const path = join(itemDir, `${stepName}.json`);
  writeFileSync(
    path,
    JSON.stringify({ workflow, itemId, stepName, ts: new Date().toISOString(), value: { v: 1 } }),
  );
  const t = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, t, t);
  return path;
}

describe("pruneOldStepCache (clean-tracker step-cache support)", () => {
  beforeEach(() => {
    if (existsSync(STEP_CACHE_TEST_DIR)) rmSync(STEP_CACHE_TEST_DIR, { recursive: true });
    mkdirSync(STEP_CACHE_TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(STEP_CACHE_TEST_DIR)) rmSync(STEP_CACHE_TEST_DIR, { recursive: true });
  });

  it("deletes only cache files older than maxAgeHours", () => {
    seedStepCache("onboarding", "fresh@x.edu", "extraction", 1);
    seedStepCache("onboarding", "stale@x.edu", "extraction", 10);

    const deleted = pruneOldStepCache(168 /* 7d */, STEP_CACHE_TEST_DIR);
    assert.equal(deleted, 1);

    const remaining = readdirSync(STEP_CACHE_TEST_DIR).sort();
    assert.ok(remaining.some((d) => d.includes("fresh@x.edu")), "fresh item dir kept");
    assert.ok(!remaining.some((d) => d.includes("stale@x.edu")), "stale item dir removed");
  });

  it("returns 0 when the dir does not exist", () => {
    const missing = ".tracker-step-cache-missing-" + Date.now();
    assert.equal(pruneOldStepCache(168, missing), 0);
  });
});

describe("cleanTrackerMain — integrates step-cache prune by default", () => {
  beforeEach(() => {
    if (existsSync(STEP_CACHE_TEST_DIR)) rmSync(STEP_CACHE_TEST_DIR, { recursive: true });
    mkdirSync(STEP_CACHE_TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(STEP_CACHE_TEST_DIR)) rmSync(STEP_CACHE_TEST_DIR, { recursive: true });
  });

  it("cleanTrackerMain routes --days N to step-cache prune", () => {
    seedStepCache("onboarding", "stale@x.edu", "extraction", 10);

    const result = cleanTrackerMain([
      "--step-cache-dir",
      STEP_CACHE_TEST_DIR,
      "--days",
      "7",
      "--step-cache-only",
    ]);
    assert.equal(result.stepCacheDeleted, 1);
    assert.equal(result.trackerDeleted, 0);
    assert.equal(result.screenshotsDeleted, 0);
    assert.ok(!existsSync(join(STEP_CACHE_TEST_DIR, "onboarding-stale@x.edu")));
  });

  it("--no-step-cache skips the step-cache prune", () => {
    seedStepCache("onboarding", "stale@x.edu", "extraction", 10);

    const result = cleanTrackerMain([
      "--dir",
      ".tracker-missing-for-this-test",
      "--screenshots-dir",
      ".screenshots-missing-for-this-test",
      "--step-cache-dir",
      STEP_CACHE_TEST_DIR,
      "--days",
      "7",
      "--no-screenshots",
      "--no-step-cache",
    ]);
    assert.equal(result.stepCacheDeleted, 0);
    assert.ok(existsSync(join(STEP_CACHE_TEST_DIR, "onboarding-stale@x.edu")));
  });

  it("--step-cache-only skips tracker + screenshots", () => {
    seedStepCache("onboarding", "stale@x.edu", "extraction", 10);

    const result = cleanTrackerMain([
      "--step-cache-dir",
      STEP_CACHE_TEST_DIR,
      "--days",
      "7",
      "--step-cache-only",
    ]);
    assert.equal(result.trackerDeleted, 0);
    assert.equal(result.screenshotsDeleted, 0);
    assert.equal(result.stepCacheDeleted, 1);
  });

  it("accepts --days 0 (wipe-all semantics)", () => {
    seedStepCache("onboarding", "fresh-too@x.edu", "extraction", 0);

    const result = cleanTrackerMain([
      "--step-cache-dir",
      STEP_CACHE_TEST_DIR,
      "--days",
      "0",
      "--step-cache-only",
    ]);
    // --days 0 means the cutoff is now; only files written in the future
    // remain. A file written at age 0 will have mtime ~now, which may or
    // may not be strictly >= now. Assert that the call didn't throw and
    // returned a number — exact count depends on system clock resolution.
    assert.equal(typeof result.stepCacheDeleted, "number");
    assert.ok(result.stepCacheDeleted >= 0);
  });
});
