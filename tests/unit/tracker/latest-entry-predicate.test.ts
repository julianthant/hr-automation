import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dateLocal, readLatestTrackerEntriesByRunKey, trackEvent } from "../../../src/tracker/jsonl.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import { findLatestEntryForPredicate } from "../../../src/tracker/find-latest-entry.js";

test("findLatestEntryForPredicate scans recent tracker files newest line first", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-15T10:00:00.000Z",
      id: "session-1",
      runId: "run-old",
      status: "running",
      step: "matching",
      data: {},
    }, dir);
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-15T10:01:00.000Z",
      id: "session-1",
      runId: "run-new",
      status: "done",
      step: "approved",
      data: { fannedOutItemIds: '["10800001"]' },
    }, dir);

    const latest = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir: dir,
      lookbackDays: 7,
      predicate: (entry) => entry.id === "session-1" && entry.step === "approved",
    });

    assert.equal(latest?.runId, "run-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findLatestEntryForPredicate skips invalid JSONL tracker rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    const date = dateLocal();
    const file = join(dir, `ocr-${date}.jsonl`);
    trackEvent({
      workflow: "ocr",
      timestamp: `${date}T10:00:00.000Z`,
      id: "session-1",
      runId: "run-ok",
      status: "done",
      step: "approved",
      data: {},
    }, dir);
    appendFileSync(file, "{\"not\":\"a tracker entry\"}\n");
    appendFileSync(file, "{not json}\n");

    const latest = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir: dir,
      lookbackDays: 1,
      predicate: (entry) => entry.id === "session-1" && entry.step === "approved",
    });

    assert.equal(latest?.runId, "run-ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findLatestEntryForPredicate accepts legacy ts tracker rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    const date = dateLocal();
    const timestamp = `${date}T10:00:00.000Z`;
    appendFileSync(
      join(dir, `ocr-${date}.jsonl`),
      `${JSON.stringify({
        workflow: "ocr",
        ts: timestamp,
        id: "legacy-session",
        runId: "legacy-run",
        status: "done",
        step: "approved",
      })}\n`,
    );

    const latest = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir: dir,
      lookbackDays: 1,
      predicate: (entry) => entry.id === "legacy-session",
    });

    assert.equal(latest?.timestamp, timestamp);
    assert.equal(latest?.runId, "legacy-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestTrackerEntriesByRunKey uses tolerant newest-first JSONL scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    const now = new Date("2026-05-22T12:00:00.000Z");
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const todayDate = dateLocal(now);
    const yesterdayDate = dateLocal(yesterday);
    appendFileSync(
      join(dir, `ocr-${yesterdayDate}.jsonl`),
      `${JSON.stringify({
        workflow: "ocr",
        timestamp: `${yesterdayDate}T09:00:00.000Z`,
        id: "session-1",
        runId: "run-1",
        status: "running",
        data: { value: "old" },
      })}\n`,
    );
    appendFileSync(
      join(dir, `ocr-${todayDate}.jsonl`),
      [
        "{not json}",
        JSON.stringify({
          workflow: "ocr",
          timestamp: `${todayDate}T09:00:00.000Z`,
          id: "session-1",
          runId: "run-1",
          status: "done",
          data: { value: "new" },
        }),
        JSON.stringify({
          workflow: "ocr",
          ts: `${todayDate}T10:00:00.000Z`,
          id: "legacy-session",
          status: "done",
        }),
        "",
      ].join("\n"),
    );

    const latestByKey = readLatestTrackerEntriesByRunKey("ocr", dir, 2, now);

    assert.equal(latestByKey.get("session-1#run-1")?.data?.value, "new");
    assert.equal(latestByKey.get("legacy-session#")?.timestamp, `${todayDate}T10:00:00.000Z`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findLatestEntryForPredicate falls back to JSONL when SQLite latest_status is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    openStateDb(dir);
    const date = dateLocal();
    trackEvent({
      workflow: "ocr",
      timestamp: `${date}T10:00:00.000Z`,
      id: "session-1",
      runId: "run-ok",
      status: "done",
      step: "approved",
      data: {},
    }, dir);
    const db = openStateDb(dir);
    db.prepare("UPDATE runs SET latest_status = 'paused' WHERE workflow = 'ocr'").run();

    const latest = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir: dir,
      lookbackDays: 1,
      db,
      runId: "run-ok",
      predicate: (entry) => entry.id === "session-1" && entry.step === "approved",
    });

    assert.equal(latest?.runId, "run-ok");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
