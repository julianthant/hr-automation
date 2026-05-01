import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchChildRuns } from "../../../src/tracker/watch-child-runs.js";

function setupTrackerDir(): string {
  const dir = join(tmpdir(), `wcr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEntry(file: string, entry: object): void {
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

test("resolves when all expected itemIds reach terminal status", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  // Pre-write one terminal entry
  writeEntry(file, {
    workflow: "eid-lookup", id: "test-r0", runId: "r0",
    status: "done", data: { emplId: "10000001" }, timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["test-r0", "test-r1"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  // After 100ms, write the second terminal entry
  setTimeout(() => {
    writeEntry(file, {
      workflow: "eid-lookup", id: "test-r1", runId: "r1",
      status: "failed", error: "no result", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 2);
  const r0 = outcomes.find((o) => o.itemId === "test-r0");
  const r1 = outcomes.find((o) => o.itemId === "test-r1");
  assert.ok(r0); assert.equal(r0.status, "done"); assert.equal(r0.data?.emplId, "10000001");
  assert.ok(r1); assert.equal(r1.status, "failed"); assert.equal(r1.error, "no result");
  rmSync(dir, { recursive: true, force: true });
});

test("times out cleanly when items don't terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  await assert.rejects(
    () => watchChildRuns({
      workflow: "eid-lookup",
      expectedItemIds: ["never-arrives"],
      trackerDir: dir,
      date,
      timeoutMs: 200,
    }),
    /timeout/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("ignores non-matching itemIds in the JSONL", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");
  writeEntry(file, {
    workflow: "eid-lookup", id: "other-item", runId: "x",
    status: "done", timestamp: new Date().toISOString(),
  });
  writeEntry(file, {
    workflow: "eid-lookup", id: "wanted", runId: "y",
    status: "done", timestamp: new Date().toISOString(),
  });

  const outcomes = await watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["wanted"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "wanted");
  rmSync(dir, { recursive: true, force: true });
});

test("custom isTerminal predicate (waiting for step=approved)", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `ocr-${date}.jsonl`);
  writeFileSync(file, "");

  // status=done step=awaiting-approval should NOT be terminal under custom predicate
  writeEntry(file, {
    workflow: "ocr", id: "session-1", runId: "r1",
    status: "done", step: "awaiting-approval", timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "ocr",
    expectedItemIds: ["session-1"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
    isTerminal: (e) =>
      (e.status === "done" && e.step === "approved") ||
      (e.status === "failed" && (e.step === "discarded" || e.step === "superseded")),
  });

  setTimeout(() => {
    writeEntry(file, {
      workflow: "ocr", id: "session-1", runId: "r1",
      status: "done", step: "approved", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "session-1");
  rmSync(dir, { recursive: true, force: true });
});

test("calls onProgress as items terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  const progressCalls: Array<{ itemId: string; remaining: number }> = [];

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["a", "b", "c"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
    onProgress: (outcome, remaining) => {
      progressCalls.push({ itemId: outcome.itemId, remaining });
    },
  });

  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "a", runId: "1", status: "done", timestamp: new Date().toISOString() }), 50);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "b", runId: "2", status: "done", timestamp: new Date().toISOString() }), 100);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "c", runId: "3", status: "done", timestamp: new Date().toISOString() }), 150);

  await promise;
  assert.equal(progressCalls.length, 3);
  assert.equal(progressCalls[0].remaining, 2);
  assert.equal(progressCalls[1].remaining, 1);
  assert.equal(progressCalls[2].remaining, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("survives when target file doesn't exist initially", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  // file does NOT exist yet

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["arrives-late"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  setTimeout(() => {
    writeFileSync(file, "");
    appendFileSync(file, JSON.stringify({
      workflow: "eid-lookup", id: "arrives-late", runId: "1",
      status: "done", timestamp: new Date().toISOString(),
    }) + "\n");
  }, 200);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
