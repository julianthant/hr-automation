/**
 * Tests for `enterDaemonLogContext` — the `enterWith` path that stamps the
 * current async flow as a daemon log context without a wrapping callback.
 *
 * Isolation note: `AsyncLocalStorage.enterWith` mutates the current async
 * context permanently for the rest of the flow. To prevent leakage into
 * other tests, the `enterDaemonLogContext` call and the subsequent `log.*`
 * call are confined inside a self-contained `async` IIFE. The outer test
 * body never enters the daemon context.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  log,
  enterDaemonLogContext,
} from "../../../src/utils/log.js";
import {
  readSessionEvents,
  __resetSessionEventsCacheForTests,
} from "../../../src/tracker/session-events.js";
import { __resetParseCacheForTests } from "../../../src/tracker/jsonl.js";

describe("enterDaemonLogContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-enter-ctx-"));
    __resetSessionEventsCacheForTests();
    __resetParseCacheForTests();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("routes log lines to the session log as daemon_log events", async () => {
    // Contain enterWith mutation inside its own async scope so it cannot
    // leak into the surrounding test context or subsequent tests.
    const capturedDir = dir;
    await (async () => {
      enterDaemonLogContext("onboarding", "Onboarding 1", capturedDir);
      log.warn("daemon note");
    })();

    __resetSessionEventsCacheForTests();
    const events = readSessionEvents(capturedDir);
    const daemonLogs = events.filter((e) => e.type === "daemon_log");

    assert.equal(daemonLogs.length, 1, "exactly one daemon_log event expected");
    const ev = daemonLogs[0];
    assert.equal(ev.workflowInstance, "Onboarding 1");
    assert.equal(ev.data?.level, "warn");
    assert.equal(ev.data?.message, "daemon note");
  });
});
