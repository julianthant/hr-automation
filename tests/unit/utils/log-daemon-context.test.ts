import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  log,
  withDaemonLogContext,
  withLogContext,
  setLogRunId,
} from "../../../src/utils/log.js";
import {
  readSessionEvents,
  __resetSessionEventsCacheForTests,
} from "../../../src/tracker/session-events.js";
import {
  readLogEntries,
  __resetParseCacheForTests,
} from "../../../src/tracker/jsonl.js";

describe("withDaemonLogContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "log-daemon-ctx-"));
    __resetSessionEventsCacheForTests();
    __resetParseCacheForTests();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("routes daemon log lines into the session log as daemon_log events", async () => {
    await withDaemonLogContext("onboarding", "Onboarding 1", async () => {
      log.warn("queue stalled");
    }, dir);

    __resetSessionEventsCacheForTests();
    const events = readSessionEvents(dir);
    const daemonLogs = events.filter((e) => e.type === "daemon_log");

    assert.equal(daemonLogs.length, 1, "exactly one daemon_log event expected");
    const ev = daemonLogs[0];
    assert.equal(ev.workflowInstance, "Onboarding 1");
    assert.equal(ev.data?.level, "warn");
    assert.equal(ev.data?.message, "queue stalled");
  });

  it("run-scoped log lines still write run-log entries and no daemon_log event", async () => {
    await withLogContext("onboarding", "item-1", async () => {
      setLogRunId("run-abc");
      log.step("doing work");
    }, dir);

    __resetParseCacheForTests();
    const entries = readLogEntries("onboarding", "item-1", dir);
    assert.equal(entries.length, 1, "one run-log entry expected");
    assert.equal(entries[0].level, "step");
    assert.equal(entries[0].message, "doing work");
    assert.equal(entries[0].runId, "run-abc");

    __resetSessionEventsCacheForTests();
    const daemonLogs = readSessionEvents(dir).filter((e) => e.type === "daemon_log");
    assert.equal(daemonLogs.length, 0, "no daemon_log event for run-scoped logs");
  });
});
