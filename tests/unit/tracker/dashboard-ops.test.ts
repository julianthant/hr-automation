/**
 * Dashboard ops handlers — retry input lookup, queue cancel, queue bump,
 * queue depth. Each handler is exercised against a tmp tracker directory
 * to keep the test hermetic. Daemon-list / daemon-spawn / daemon-stop are
 * not exercised here because they require live HTTP probing of running
 * daemons; the underlying file readers (queueFilePath, daemonsDir) are
 * already covered by tests in tests/unit/core/daemon-*.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import {
  findEntryInput,
  buildCancelQueuedHandler,
  buildQueueBumpHandler,
  readQueueDepth,
} from "../../../src/tracker/dashboard-ops.js";
import { queueFilePath } from "../../../src/core/daemon-queue.js";
import type { QueueEvent } from "../../../src/core/daemon-types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dash-ops-"));
});
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("findEntryInput", () => {
  it("returns the input from a pending tracker row", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.deepEqual(result, { input: { docId: "3930" } });
  });

  it("returns an error when no pending row has stored input", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        // no input field
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.ok("error" in result);
  });

  it("picks the latest pending row when multiple runs exist", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930", v: "first" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T13:00:00.000Z",
        id: "3930",
        runId: "u-2",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930", v: "second" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.ok("input" in result);
    assert.equal((result.input as { v: string }).v, "second");
  });

  it("filters by runId when supplied", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: {},
        input: { v: "first" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T13:00:00.000Z",
        id: "3930",
        runId: "u-2",
        status: "pending",
        data: {},
        input: { v: "second" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", "u-1", tmp);
    assert.ok("input" in result);
    assert.equal((result.input as { v: string }).v, "first");
  });
});

describe("buildCancelQueuedHandler", () => {
  it("appends a synthetic failed event for a queued item + writes a tracker row", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const enqueueEv: QueueEvent = {
      type: "enqueue",
      id: "3930",
      workflow: "separations",
      input: { docId: "3930" },
      enqueuedAt: "2026-04-24T12:00:00.000Z",
      enqueuedBy: "test",
      runId: "u-1",
    };
    writeFileSync(path, JSON.stringify(enqueueEv) + "\n");
    const handler = buildCancelQueuedHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, true);
    const after = readFileSync(path, "utf8");
    assert.ok(after.includes('"type":"failed"'));
    assert.ok(after.includes("cancelled by user from dashboard"));
  });

  it("returns 409 when the item is already claimed", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "3930",
        workflow: "separations",
        input: { docId: "3930" },
        enqueuedAt: "2026-04-24T12:00:00.000Z",
        enqueuedBy: "test",
        runId: "u-1",
      },
      {
        type: "claim",
        id: "3930",
        claimedBy: "sep-abc",
        claimedAt: "2026-04-24T12:01:00.000Z",
        runId: "u-1",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildCancelQueuedHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, false);
    assert.equal((result as { status?: number }).status, 409);
  });
});

describe("buildQueueBumpHandler", () => {
  it("moves a queued item's enqueue event to the head of the file", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "first",
        workflow: "separations",
        input: { docId: "first" },
        enqueuedAt: "t1",
        enqueuedBy: "test",
      },
      {
        type: "enqueue",
        id: "second",
        workflow: "separations",
        input: { docId: "second" },
        enqueuedAt: "t2",
        enqueuedBy: "test",
      },
      {
        type: "enqueue",
        id: "third",
        workflow: "separations",
        input: { docId: "third" },
        enqueuedAt: "t3",
        enqueuedBy: "test",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildQueueBumpHandler(tmp);
    const result = await handler({ workflow: "separations", id: "third" });
    assert.equal(result.ok, true);
    const after = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(after.length, 3);
    const firstParsed = JSON.parse(after[0]) as QueueEvent;
    assert.equal((firstParsed as { id: string }).id, "third");
  });

  it("rejects bumping a claimed item with status 409", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "3930",
        workflow: "separations",
        input: { docId: "3930" },
        enqueuedAt: "t1",
        enqueuedBy: "test",
      },
      {
        type: "claim",
        id: "3930",
        claimedBy: "sep-abc",
        claimedAt: "t2",
        runId: "u-1",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildQueueBumpHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, false);
    assert.equal((result as { status?: number }).status, 409);
  });
});

describe("readQueueDepth", () => {
  it("counts only items in the queued state", () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      { type: "enqueue", id: "a", workflow: "separations", input: {}, enqueuedAt: "t1", enqueuedBy: "test" },
      { type: "enqueue", id: "b", workflow: "separations", input: {}, enqueuedAt: "t2", enqueuedBy: "test" },
      { type: "enqueue", id: "c", workflow: "separations", input: {}, enqueuedAt: "t3", enqueuedBy: "test" },
      { type: "claim", id: "a", claimedBy: "x", claimedAt: "t4", runId: "u-a" },
      { type: "done", id: "b", completedAt: "t5", runId: "u-b" },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(readQueueDepth("separations", tmp), 1);
  });

  it("returns 0 when the queue file does not exist", () => {
    assert.equal(readQueueDepth("never-existed", tmp), 0);
  });
});
