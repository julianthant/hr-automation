/**
 * Unit tests for the `bucketDaemonCounts` pure helper extracted from
 * `TerminalDrawer`. The three-way running / authenticating / idle split must
 * be correct so the operator's collapsed-bar summary tells the truth about
 * daemon utilization.
 *
 * Key contract: a daemon that is alive but hasn't set `daemonPhase` yet is
 * AUTHENTICATING (mid-Duo / browser-launch), not idle. Only once `daemonPhase`
 * is stamped ('idle' or 'keepalive') is it truly parked at the claim loop.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { bucketDaemonCounts } from "../../../src/dashboard/components/terminal-drawer/TerminalDrawer.js";
import type { WorkflowInstanceState } from "../../../src/dashboard/components/shared/types.js";

function worker(
  overrides: Partial<WorkflowInstanceState>,
): WorkflowInstanceState {
  return {
    instance: "Test 1",
    workflow: "test",
    active: true,
    pidAlive: true,
    currentItemId: null,
    currentTraceId: null,
    itemInFlight: false,
    currentStep: null,
    finalStatus: null,
    sessions: [],
    ...overrides,
  };
}

describe("bucketDaemonCounts", () => {
  test("1 running, 1 authenticating, 1 idle, 1 failed → 1/1/1/1", () => {
    const workers: WorkflowInstanceState[] = [
      // running: has an in-flight item
      worker({ instance: "Test 1", itemInFlight: true }),
      // authenticating: alive but daemonPhase not yet set (still mid-auth)
      worker({ instance: "Test 2", itemInFlight: false, daemonPhase: undefined }),
      // idle: reached claim loop, daemonPhase is 'idle'
      worker({ instance: "Test 3", itemInFlight: false, daemonPhase: "idle" }),
      // failed: crashed on launch
      worker({ instance: "Test 4", crashedOnLaunch: true }),
    ];

    const result = bucketDaemonCounts(workers);

    assert.equal(result.running, 1, "running count");
    assert.equal(result.authenticating, 1, "authenticating count");
    assert.equal(result.idle, 1, "idle count");
    assert.equal(result.failed, 1, "failed count");
  });

  test("daemonPhase=keepalive counts as idle, not authenticating", () => {
    const workers: WorkflowInstanceState[] = [
      worker({ instance: "Test 1", itemInFlight: false, daemonPhase: "keepalive" }),
    ];

    const result = bucketDaemonCounts(workers);

    assert.equal(result.idle, 1, "keepalive should be idle");
    assert.equal(result.authenticating, 0, "keepalive must not be authenticating");
  });

  test("finalStatus=failed counts as failed even without crashedOnLaunch", () => {
    const workers: WorkflowInstanceState[] = [
      worker({ instance: "Test 1", finalStatus: "failed" }),
    ];

    const result = bucketDaemonCounts(workers);

    assert.equal(result.failed, 1);
    assert.equal(result.authenticating, 0);
    assert.equal(result.idle, 0);
    assert.equal(result.running, 0);
  });

  test("itemInFlight wins over daemonPhase for running classification", () => {
    // A running item takes priority — the daemon is processing, not idle.
    const workers: WorkflowInstanceState[] = [
      worker({ instance: "Test 1", itemInFlight: true, daemonPhase: "idle" }),
    ];

    const result = bucketDaemonCounts(workers);

    assert.equal(result.running, 1);
    assert.equal(result.idle, 0);
  });

  test("empty list returns all zeros", () => {
    const result = bucketDaemonCounts([]);

    assert.deepEqual(result, { running: 0, authenticating: 0, idle: 0, failed: 0 });
  });

  test("multiple authenticating daemons (Duo queue scenario)", () => {
    // Realistic: 4 daemons started simultaneously, all mid-auth, none yet idle.
    const workers: WorkflowInstanceState[] = Array.from({ length: 4 }, (_, i) =>
      worker({ instance: `Test ${i + 1}`, itemInFlight: false, daemonPhase: undefined }),
    );

    const result = bucketDaemonCounts(workers);

    assert.equal(result.authenticating, 4, "all 4 mid-auth daemons must show authenticating");
    assert.equal(result.idle, 0, "none should be idle before reaching claim loop");
    assert.equal(result.running, 0);
    assert.equal(result.failed, 0);
  });
});
