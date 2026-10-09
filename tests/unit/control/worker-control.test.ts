/**
 * Unit tests for the pure/near-pure helpers in src/control/ops/worker-control.ts.
 *
 * `buildDaemonsListHandler` (which composes these three) already has
 * integration-level coverage in tests/unit/tracker/dashboard-ops.test.ts, and
 * `shouldSynthesizeStopInstanceEnd` (ISS-004) is thoroughly pinned there too
 * ("shouldSynthesizeStopInstanceEnd (ISS-004 double workflow_end)") — not
 * duplicated here. This file targets the three previously-unexported pure
 * helpers directly, at the level of their own parsing/mapping edge cases:
 *
 * - `countItemsProcessed` — folds `.queue.jsonl` lines into a per-instance
 *   completed-item count.
 * - `discoverLockfileWorkflows` — reads workflow names from `.tracker/daemons/`
 *   lockfiles.
 * - `workerToDaemonInfo` — maps a `WorkerRow` (+ optional matching lockfile +
 *   runtime stats) to the dashboard-facing `DaemonInfo` shape.
 *
 * Minimal extraction note: these three functions were module-private; they
 * were changed to `export` (no behavior change) so they can be unit-tested
 * directly instead of only through the full `buildDaemonsListHandler` handler.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countItemsProcessed,
  discoverLockfileWorkflows,
  workerToDaemonInfo,
} from "../../../src/control/ops/worker-control.js";
import type { WorkerRow, BrowserProcessRow } from "../../../src/core/daemon/worker-store.js";
import type { Daemon } from "../../../src/core/daemon/types.js";

// ── countItemsProcessed ─────────────────────────────────────────────────────

describe("countItemsProcessed", () => {
  const enqueueLine = (id: string, runId: string) =>
    JSON.stringify({ type: "enqueue", id, workflow: "wf", input: {}, enqueuedAt: "t", enqueuedBy: "x", runId });
  const claimLine = (id: string, claimedBy: string, runId: string) =>
    JSON.stringify({ type: "claim", id, claimedBy, claimedAt: "t", runId });
  const doneLine = (id: string, runId: string) =>
    JSON.stringify({ type: "done", id, completedAt: "t", runId });
  const failedLine = (id: string, runId: string) =>
    JSON.stringify({ type: "failed", id, failedAt: "t", runId, error: "boom" });

  it("counts a done event for a runId claimed by this instance", () => {
    const lines = [enqueueLine("item-1", "run-1"), claimLine("item-1", "inst-a", "run-1"), doneLine("item-1", "run-1")];
    assert.equal(countItemsProcessed("inst-a", lines), 1);
  });

  it("counts a failed event for a runId claimed by this instance", () => {
    const lines = [claimLine("item-1", "inst-a", "run-1"), failedLine("item-1", "run-1")];
    assert.equal(countItemsProcessed("inst-a", lines), 1);
  });

  it("does not count terminal events for runIds claimed by a DIFFERENT instance", () => {
    const lines = [claimLine("item-1", "inst-b", "run-1"), doneLine("item-1", "run-1")];
    assert.equal(countItemsProcessed("inst-a", lines), 0);
  });

  it("does not count a terminal event with no matching prior claim", () => {
    // done/failed carry runId but not claimedBy, so an orphaned terminal event
    // (no claim line for that runId) must not be attributed to anyone.
    const lines = [doneLine("item-1", "run-orphan")];
    assert.equal(countItemsProcessed("inst-a", lines), 0);
  });

  it("counts multiple distinct claims by the same instance across different runIds", () => {
    const lines = [
      claimLine("item-1", "inst-a", "run-1"),
      claimLine("item-2", "inst-a", "run-2"),
      doneLine("item-1", "run-1"),
      failedLine("item-2", "run-2"),
    ];
    assert.equal(countItemsProcessed("inst-a", lines), 2);
  });

  it("ignores blank lines", () => {
    const lines = ["", "   ", claimLine("item-1", "inst-a", "run-1"), doneLine("item-1", "run-1"), ""];
    assert.equal(countItemsProcessed("inst-a", lines), 1);
  });

  it("ignores malformed JSON lines without throwing", () => {
    const lines = ["{not json", claimLine("item-1", "inst-a", "run-1"), doneLine("item-1", "run-1")];
    assert.doesNotThrow(() => countItemsProcessed("inst-a", lines));
    assert.equal(countItemsProcessed("inst-a", lines), 1);
  });

  it("returns 0 for an empty event list", () => {
    assert.equal(countItemsProcessed("inst-a", []), 0);
  });

  it("does not double-count a runId re-claimed and completed twice (reassignment)", () => {
    // A reassignment scenario: item-1 was claimed+completed by inst-a, then a
    // NEW runId for the same item is claimed and completed by inst-a again.
    // Each distinct runId contributes exactly one terminal count.
    const lines = [
      claimLine("item-1", "inst-a", "run-1"),
      doneLine("item-1", "run-1"),
      claimLine("item-1", "inst-a", "run-2"),
      doneLine("item-1", "run-2"),
    ];
    assert.equal(countItemsProcessed("inst-a", lines), 2);
  });
});

// ── discoverLockfileWorkflows ────────────────────────────────────────────────

describe("discoverLockfileWorkflows", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lockfiles-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function daemonsDirFor(dir: string): string {
    const d = join(dir, "daemons");
    mkdirSync(d, { recursive: true });
    return d;
  }

  it("returns an empty array when the daemons dir does not exist", () => {
    assert.deepEqual(discoverLockfileWorkflows(join(tmp, "nope")), []);
  });

  it("returns an empty array when the daemons dir is empty", () => {
    daemonsDirFor(tmp);
    assert.deepEqual(discoverLockfileWorkflows(tmp), []);
  });

  it("reads the workflow name from a valid lockfile", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "separations-a1b2.lock.json"), JSON.stringify({ workflow: "separations" }));
    assert.deepEqual(discoverLockfileWorkflows(tmp), ["separations"]);
  });

  it("dedupes multiple lockfiles for the same workflow", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "separations-a1b2.lock.json"), JSON.stringify({ workflow: "separations" }));
    writeFileSync(join(d, "separations-c3d4.lock.json"), JSON.stringify({ workflow: "separations" }));
    assert.deepEqual(discoverLockfileWorkflows(tmp), ["separations"]);
  });

  it("collects distinct workflows from multiple lockfiles", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "separations-a1b2.lock.json"), JSON.stringify({ workflow: "separations" }));
    writeFileSync(join(d, "work-study-e5f6.lock.json"), JSON.stringify({ workflow: "work-study" }));
    assert.deepEqual(discoverLockfileWorkflows(tmp).sort(), ["separations", "work-study"]);
  });

  it("ignores files that are not *.lock.json", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "separations.queue.jsonl"), "not a lockfile");
    writeFileSync(join(d, "readme.txt"), "not a lockfile either");
    assert.deepEqual(discoverLockfileWorkflows(tmp), []);
  });

  it("ignores in-progress .lock.json.tmp files (atomic-write staging)", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "separations-a1b2.lock.json.tmp"), JSON.stringify({ workflow: "separations" }));
    assert.deepEqual(discoverLockfileWorkflows(tmp), []);
  });

  it("ignores unreadable/malformed JSON lockfiles without throwing", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "broken-a1b2.lock.json"), "{ not json");
    writeFileSync(join(d, "separations-c3d4.lock.json"), JSON.stringify({ workflow: "separations" }));
    assert.doesNotThrow(() => discoverLockfileWorkflows(tmp));
    assert.deepEqual(discoverLockfileWorkflows(tmp), ["separations"]);
  });

  it("ignores a lockfile whose workflow field is missing or not a string", () => {
    const d = daemonsDirFor(tmp);
    writeFileSync(join(d, "noworkflow-a1b2.lock.json"), JSON.stringify({ pid: 123 }));
    writeFileSync(join(d, "numeric-e5f6.lock.json"), JSON.stringify({ workflow: 42 }));
    assert.deepEqual(discoverLockfileWorkflows(tmp), []);
  });
});

// ── workerToDaemonInfo ───────────────────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
  return {
    workerId: "worker-1",
    workflow: "separations",
    kind: "daemon",
    pid: 4242,
    hostname: "test-host",
    phase: "idle",
    status: "alive",
    startedAt: "2026-06-01T00:00:00.000Z",
    heartbeatTtlMs: 30_000,
    metadata: {},
    ...overrides,
  };
}

function makeLock(overrides: Partial<Daemon> = {}): Daemon {
  return {
    workflow: "separations",
    instanceId: "inst-a",
    pid: 4242,
    port: 5050,
    startedAt: "2026-06-01T00:00:00.000Z",
    lockfilePath: "/fake/path.lock.json",
    ...overrides,
  };
}

function makeBrowserProcess(overrides: Partial<BrowserProcessRow> = {}): BrowserProcessRow {
  return {
    browserProcessId: "bp-1",
    workerId: "worker-1",
    systemId: "ucpath",
    browserId: "chromium",
    pid: 5555,
    status: "alive",
    launchedAt: "2026-06-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("workerToDaemonInfo", () => {
  it("maps the base worker fields verbatim", () => {
    const worker = makeWorker({ currentTaskId: "task-1", currentAttemptId: "attempt-1", phase: "processing" });
    const info = workerToDaemonInfo({
      worker,
      currentItem: "item-1",
      currentRunId: "run-1",
      itemsProcessed: 3,
      browserProcesses: [],
    });
    assert.equal(info.workflow, "separations");
    assert.equal(info.workerId, "worker-1");
    assert.equal(info.pid, 4242);
    assert.equal(info.phase, "processing");
    assert.equal(info.status, "alive");
    assert.equal(info.currentItem, "item-1");
    assert.equal(info.currentRunId, "run-1");
    assert.equal(info.currentTaskId, "task-1");
    assert.equal(info.currentAttemptId, "attempt-1");
    assert.equal(info.itemsProcessed, 3);
  });

  it("defaults workflow to an empty string when the worker has none", () => {
    const worker = makeWorker({ workflow: undefined });
    const info = workerToDaemonInfo({ worker, currentItem: null, currentRunId: null, itemsProcessed: 0, browserProcesses: [] });
    assert.equal(info.workflow, "");
  });

  it("falls back to the matching lockfile's port/instanceId when the worker row has none", () => {
    const worker = makeWorker({ port: undefined, instanceId: undefined });
    const lock = makeLock({ port: 9090, instanceId: "inst-fallback" });
    const info = workerToDaemonInfo({
      worker,
      matchingLock: lock,
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.port, 9090);
    assert.equal(info.instanceId, "inst-fallback");
    assert.equal(info.lockfileAlive, true);
  });

  it("prefers the worker row's own port/instanceId over the lockfile's", () => {
    const worker = makeWorker({ port: 1111, instanceId: "inst-own" });
    const lock = makeLock({ port: 9090, instanceId: "inst-fallback" });
    const info = workerToDaemonInfo({
      worker,
      matchingLock: lock,
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.port, 1111);
    assert.equal(info.instanceId, "inst-own");
  });

  it("reports lockfileAlive: false when no matching lock is passed", () => {
    const info = workerToDaemonInfo({
      worker: makeWorker(),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.lockfileAlive, false);
    assert.equal(info.port, null);
    assert.equal(info.instanceId, null);
  });

  it("computes uptimeMs from a parseable startedAt", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const info = workerToDaemonInfo({
      worker: makeWorker({ startedAt: past }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.ok(info.uptimeMs >= 59_000, `expected uptimeMs >= ~60000, got ${info.uptimeMs}`);
  });

  it("falls back uptimeMs to 0 when startedAt is not a parseable date", () => {
    const info = workerToDaemonInfo({
      worker: makeWorker({ startedAt: "not-a-date" }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.uptimeMs, 0);
  });

  it("computes heartbeatAgeMs when lastHeartbeatAt is present and parseable", () => {
    const past = new Date(Date.now() - 5_000).toISOString();
    const info = workerToDaemonInfo({
      worker: makeWorker({ lastHeartbeatAt: past }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.ok(info.heartbeatAgeMs !== null && info.heartbeatAgeMs >= 4_000);
  });

  it("reports heartbeatAgeMs: null when lastHeartbeatAt is absent", () => {
    const info = workerToDaemonInfo({
      worker: makeWorker({ lastHeartbeatAt: undefined }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.heartbeatAgeMs, null);
  });

  it("reports heartbeatAgeMs: null when lastHeartbeatAt is not a parseable date", () => {
    const info = workerToDaemonInfo({
      worker: makeWorker({ lastHeartbeatAt: "garbage" }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.heartbeatAgeMs, null);
  });

  it("maps browserProcesses to the narrow DaemonInfo shape", () => {
    const browsers = [
      makeBrowserProcess({ browserProcessId: "bp-1", systemId: "ucpath", pid: 111, status: "alive" }),
      makeBrowserProcess({ browserProcessId: "bp-2", systemId: "kuali", pid: 222, status: "terminated" }),
    ];
    const info = workerToDaemonInfo({
      worker: makeWorker(),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: browsers,
    });
    assert.deepEqual(info.browserProcesses, [
      { browserProcessId: "bp-1", systemId: "ucpath", pid: 111, status: "alive" },
      { browserProcessId: "bp-2", systemId: "kuali", pid: 222, status: "terminated" },
    ]);
  });

  it("returns null currentTaskId/currentAttemptId when the worker has none", () => {
    const info = workerToDaemonInfo({
      worker: makeWorker({ currentTaskId: undefined, currentAttemptId: undefined }),
      currentItem: null,
      currentRunId: null,
      itemsProcessed: 0,
      browserProcesses: [],
    });
    assert.equal(info.currentTaskId, null);
    assert.equal(info.currentAttemptId, null);
  });
});
