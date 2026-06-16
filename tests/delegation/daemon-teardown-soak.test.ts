/**
 * Daemon-teardown soak — the recurring bug NEST, under iteration + jitter.
 *
 * The daemon force-stop / reassign / stop-all state machine has produced bugs
 * across repeated AI-e2e runs, all in the SAME subsystem:
 *   - 2026-06-04  signal-only-wait force-stop deadlock
 *   - 2026-06-07  reassign-to-peer / fail-loud-when-no-responsive-peer (F5)
 *   - 2026-06-13  VQ-003 double-terminalize of one in-flight run on stop-all
 *
 * Those are TIMING races. A single point-test (daemon.test.ts) pins ONE
 * ordering; this soak loops the teardown matrix N times against the REAL daemon
 * against a temp tracker root (no browser), varying the delay between the held
 * claim and the stop by an index-derived jitter (reproducible — no Math.random),
 * so the stop interleaves with the heartbeat/poll ticks differently each pass.
 *
 * A teardown KILLS daemons, so (unlike `concurrency-soak`, which only
 * cancels/releases runs and reuses one pool) each iteration spins up a FRESH
 * runtime. The held gated stub parks in a SIGNAL-ONLY wait — the exact VQ-003 /
 * 2026-06-04 repro condition (no live browser to kill; only `ctx.signal`
 * unwinds it).
 *
 * Invariants pinned EVERY iteration:
 *   Stop-all (no reassign):
 *     - every IN-FLIGHT run terminalizes FAILED red — status "failed", step NOT
 *       "cancelled" (the operator asked to SEE these fail);
 *     - EXACTLY ONE terminal row per run (VQ-003 — the in-flight signal-only
 *       wait that historically double-wrote a cancel row then a fail row);
 *     - zero alive daemons + zero leftover lockfiles after (no orphans);
 *     - EVERY never-claimed QUEUED task reaches a terminal `control_state`
 *       (`failed`) at teardown — NOT orphaned `queued` (E2E-105). On a
 *       simultaneous stop-all of EVERY daemon, each dying daemon used to leave
 *       the queued task "for a peer" that is also dying, so nobody
 *       terminalized it (0 daemons alive, task stuck `queued` in SQLite, no
 *       terminal row). Fixed by gating the queued sweep on a peer being
 *       AVAILABLE-FOR-HANDOFF (responsive AND not itself shutting down), not on
 *       a peer merely being PID-alive. This soak pins it under jitter.
 *   Stop-instance (reassign):
 *     - the in-flight run is NOT failed — a surviving peer re-claims the SAME
 *       runId and completes it (done);
 *     - EXACTLY ONE terminal row (the reassign writes none on the stopped
 *       daemon);
 *     - the stopped instance's lockfile is gone; exactly one peer survives.
 *
 * Soak knob (default 3 — each iteration spawns 2 daemons, so keep `npm test`
 * fast; crank for local heavy soak):
 *   HR_TEARDOWN_SOAK_ITERATIONS=30 npx vitest run tests/delegation/daemon-teardown-soak.test.ts
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { createDelegationRuntime, type DelegationRuntime } from "./_runtime/index.js";
import { rowFilePath } from "../../src/tracker/paths.js";
import { dateLocal } from "../../src/tracker/jsonl.js";
import { isProcessAlive, lockfilePath } from "../../src/core/daemon/registry.js";
import { openControlDb } from "../../src/core/control-db.js";
import { createTaskStore, type TaskState } from "../../src/core/task-store/index.js";
import { isTerminalTaskState } from "../../src/core/task-store/types.js";

// ---------------------------------------------------------------------------
// Soak knob
// ---------------------------------------------------------------------------

const SOAK_ITERATIONS = Number(process.env["HR_TEARDOWN_SOAK_ITERATIONS"] ?? 3);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REAL_TRACKER_DIR = ".tracker";
const WF = "td-child";

/** The gated stub workflow — load → [held] transaction → finalize. */
const TD_CHILD = {
  name: WF,
  code: "td",
  stages: ["load", "transaction", "finalize"],
  gatedStages: ["transaction"],
  archetype: "single" as const,
  inputSubject: "name" as const,
};

function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null;
  return readdirSync(REAL_TRACKER_DIR).sort();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Index-derived jitter so the stop lands at different tick alignments. */
const jitterMs = (iteration: number): number => (iteration * 13) % 40;

interface RawRow {
  runId?: string;
  status?: string;
  step?: string;
}

function readRows(dir: string): RawRow[] {
  const path = rowFilePath(WF, dateLocal(), dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawRow);
}

/** Terminal-status rows (done|failed) for one run — the double-terminal probe. */
function terminalRows(dir: string, runId: string): RawRow[] {
  return readRows(dir).filter(
    (r) => r.runId === runId && (r.status === "done" || r.status === "failed"),
  );
}

/**
 * Read every WF task's SQLite `control_state` by `itemId`. Opens a fresh
 * read handle on the temp `state.db` (WAL → concurrent reads are safe while
 * the runtime still holds the DB open), so the E2E-105 probe asserts the
 * authoritative control truth — not just the JSONL projection. Closed before
 * returning so the handle never leaks past the assertion.
 */
function taskStatesByItemId(dir: string): Map<string, TaskState> {
  const control = openControlDb({ trackerDir: dir });
  try {
    const store = createTaskStore(control);
    const byId = new Map<string, TaskState>();
    for (const task of store.listTasksForWorkflow(WF)) {
      byId.set(task.itemId, task.state);
    }
    return byId;
  } finally {
    control.close();
  }
}

/** Lockfiles physically on disk for WF (alive or orphaned). */
function lockfilesOnDisk(dir: string): Array<{ file: string; pid: number; alive: boolean }> {
  const daemonsDir = dirname(lockfilePath(WF, "probe", dir));
  if (!existsSync(daemonsDir)) return [];
  return readdirSync(daemonsDir)
    .filter((f) => f.startsWith(`${WF}-`) && f.endsWith(".lock.json"))
    .map((file) => {
      try {
        const lock = JSON.parse(readFileSync(`${daemonsDir}/${file}`, "utf8")) as { pid?: number };
        const pid = typeof lock.pid === "number" ? lock.pid : -1;
        return { file, pid, alive: pid > 0 && isProcessAlive(pid) };
      } catch {
        return { file, pid: -1, alive: false };
      }
    });
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await sleep(25);
  }
}

/**
 * Pump `release(runId, stage)` until the run terminates. `release` only resolves
 * an ALREADY-registered hold (see GateCoordinator), and the peer re-registers
 * its hold a tick AFTER its `step:start` fires — so a single release races that
 * window. Repeated idempotent release closes it.
 */
async function releaseUntilTerminal(
  rt: DelegationRuntime,
  runId: string,
  stage: string,
  occasion: string,
  timeoutMs: number,
): Promise<void> {
  let settled = false;
  const pump = (async () => {
    const start = Date.now();
    while (!settled && Date.now() - start < timeoutMs) {
      rt.release(runId, stage);
      await sleep(25);
    }
  })();
  try {
    await rt.waitForEvent("run:terminal", { runId, occasion, timeoutMs });
  } finally {
    settled = true;
    await pump;
  }
}

async function makeRuntime(): Promise<DelegationRuntime> {
  return createDelegationRuntime({
    workflows: [{ workflow: TD_CHILD, instances: 2 }],
    idleTimeoutMs: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Stop-all → fail RED, exactly one terminal each (VQ-003 + 2026-06-07 fail-loud)
// ---------------------------------------------------------------------------

test(
  "daemon-teardown soak — Stop-All fails in-flight RED, EXACTLY ONE terminal each (VQ-003), no orphan lockfiles",
  { timeout: 180_000 },
  async () => {
    const before = snapshotRealTracker();

    for (let i = 0; i < SOAK_ITERATIONS; i++) {
      const rt = await makeRuntime();
      try {
        rt.holdAll(WF, "transaction");

        const tag = `sa${i}`;
        // 2 items, 2 daemons → both in-flight, parked at the held `transaction`
        // (the signal-only wait that VQ-003 double-terminalized).
        const c1 = await rt.enqueue(WF, { id: `${tag}-1`, name: `A-${tag}` });
        const c2 = await rt.enqueue(WF, { id: `${tag}-2`, name: `B-${tag}` });
        const runs = [c1, c2];

        // Both daemons claim + park at the hold.
        await rt.waitForEvent("step:start", { step: "transaction", count: 2, timeoutMs: 15_000 });
        assert.equal(
          (await rt.daemons(WF)).length,
          2,
          `[iter ${i}] expected 2 daemons in flight before Stop-All`,
        );

        await sleep(jitterMs(i));
        await rt.stopAll(WF);

        // Both in-flight runs terminalize failed.
        await waitFor(
          () => {
            const failed = new Set(
              readRows(rt.trackerDir)
                .filter((r) => r.status === "failed")
                .map((r) => r.runId),
            );
            return runs.every((c) => failed.has(c.runId));
          },
          `[iter ${i}] both in-flight runs failed after Stop-All`,
          25_000,
        );

        for (const c of runs) {
          const terms = terminalRows(rt.trackerDir, c.runId);
          assert.equal(
            terms.length,
            1,
            `[iter ${i}] run ${c.runId} must have EXACTLY ONE terminal row (VQ-003), got ${terms.length}: ${JSON.stringify(terms)}`,
          );
          assert.equal(
            terms[0]!.status,
            "failed",
            `[iter ${i}] Stop-All run ${c.runId} terminal must be failed (red), got ${terms[0]!.status}`,
          );
          assert.notEqual(
            terms[0]!.step,
            "cancelled",
            `[iter ${i}] Stop-All run ${c.runId} must NOT carry the cancelled sentinel — red Failed, not orange Cancelled`,
          );
        }

        // Daemons gone, no lockfile left behind (alive OR orphaned).
        await waitFor(
          async () => (await rt.daemons(WF)).length === 0 && lockfilesOnDisk(rt.trackerDir).length === 0,
          `[iter ${i}] daemons + lockfiles cleared after Stop-All`,
          10_000,
        );
      } finally {
        await rt.cleanup();
      }
    }

    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ must be unchanged by the soak");
  },
);

// ---------------------------------------------------------------------------
// Stop-All → never-claimed QUEUED items terminalize (E2E-105 — queued orphan)
// ---------------------------------------------------------------------------

test(
  "daemon-teardown soak — Stop-All terminalizes EVERY never-claimed QUEUED item (E2E-105), none left queued",
  { timeout: 180_000 },
  async () => {
    const before = snapshotRealTracker();

    for (let i = 0; i < SOAK_ITERATIONS; i++) {
      const rt = await makeRuntime();
      try {
        rt.holdAll(WF, "transaction");

        const tag = `oq${i}`;
        // 2 daemons, 4 items: the 2 daemons each claim one and park at the held
        // `transaction`; the other 2 stay NEVER-CLAIMED `queued`. A simultaneous
        // stop-all of EVERY daemon used to orphan those queued items (each dying
        // daemon left them "for a peer" that was also dying → 0 daemons alive,
        // tasks stuck `queued`, no terminal row — E2E-105).
        const inFlight = [
          await rt.enqueue(WF, { id: `${tag}-1`, name: `A-${tag}` }),
          await rt.enqueue(WF, { id: `${tag}-2`, name: `B-${tag}` }),
        ];
        const queuedOnly = [
          await rt.enqueue(WF, { id: `${tag}-3`, name: `C-${tag}` }),
          await rt.enqueue(WF, { id: `${tag}-4`, name: `D-${tag}` }),
        ];

        // Both daemons claim + park at the hold; the extra items stay queued.
        await rt.waitForEvent("step:start", { step: "transaction", count: 2, timeoutMs: 15_000 });
        assert.equal(
          (await rt.daemons(WF)).length,
          2,
          `[iter ${i}] expected 2 daemons in flight before Stop-All`,
        );
        // Precondition: the 2 extra items really are still queued (never claimed)
        // — otherwise the orphan path under test wouldn't be exercised.
        const preStates = taskStatesByItemId(rt.trackerDir);
        for (const q of queuedOnly) {
          assert.equal(
            preStates.get(q.itemId),
            "queued",
            `[iter ${i}] precondition: ${q.itemId} must be queued (never claimed) before Stop-All`,
          );
        }

        await sleep(jitterMs(i));
        await rt.stopAll(WF);

        // Daemons gone, no lockfile left behind.
        await waitFor(
          async () => (await rt.daemons(WF)).length === 0 && lockfilesOnDisk(rt.trackerDir).length === 0,
          `[iter ${i}] daemons + lockfiles cleared after Stop-All`,
          10_000,
        );

        // EVERY queued item must reach a terminal control_state — NOT stuck
        // `queued`. This is the E2E-105 pin: the last responsive owner
        // terminalizes the queue instead of leaving it for a dying peer.
        await waitFor(
          () => {
            const states = taskStatesByItemId(rt.trackerDir);
            return queuedOnly.every((q) => {
              const s = states.get(q.itemId);
              return s !== undefined && isTerminalTaskState(s);
            });
          },
          `[iter ${i}] every never-claimed queued item terminalized at Stop-All (no orphan)`,
          15_000,
        );

        const finalStates = taskStatesByItemId(rt.trackerDir);
        for (const q of queuedOnly) {
          const s = finalStates.get(q.itemId);
          assert.equal(
            s,
            "failed",
            `[iter ${i}] orphaned-candidate ${q.itemId} must terminalize FAILED (red), got ${s}`,
          );
        }
        // And the in-flight ones still fail (the existing correct behavior).
        for (const c of inFlight) {
          const s = finalStates.get(c.itemId);
          assert.ok(
            s !== undefined && isTerminalTaskState(s),
            `[iter ${i}] in-flight ${c.itemId} must terminalize, got ${s}`,
          );
        }
      } finally {
        await rt.cleanup();
      }
    }

    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ must be unchanged by the soak");
  },
);

// ---------------------------------------------------------------------------
// Stop-instance (reassign) → peer finishes the SAME run, exactly one terminal
// ---------------------------------------------------------------------------

test(
  "daemon-teardown soak — Stop-Instance reassigns the in-flight run to a peer, EXACTLY ONE terminal (done)",
  { timeout: 180_000 },
  async () => {
    const before = snapshotRealTracker();

    for (let i = 0; i < SOAK_ITERATIONS; i++) {
      const rt = await makeRuntime();
      try {
        rt.holdAll(WF, "transaction");

        const tag = `si${i}`;
        const c = await rt.enqueue(WF, { id: `${tag}-1`, name: `A-${tag}` });

        // One daemon claims + parks; pool is 2.
        await rt.waitForEvent("step:start", {
          step: "transaction",
          runId: c.runId,
          timeoutMs: 15_000,
        });
        const poolBefore = await rt.daemons(WF);
        assert.equal(poolBefore.length, 2, `[iter ${i}] expected 2 daemons before Stop-Instance`);

        await sleep(jitterMs(i));
        const stopped = await rt.stopInstance(WF, { reassign: true, holdingRunId: c.runId });

        // The surviving peer re-claims the SAME runId → re-enters `transaction`
        // (2nd step:start) → we pump release → it completes `done`. By the 2nd
        // step:start the stopped daemon is already gone, so the release pump
        // only affects the peer.
        await rt.waitForEvent("step:start", {
          step: "transaction",
          runId: c.runId,
          count: 2,
          timeoutMs: 25_000,
        });
        await releaseUntilTerminal(rt, c.runId, "transaction", "completed", 25_000);

        const terms = terminalRows(rt.trackerDir, c.runId);
        assert.equal(
          terms.length,
          1,
          `[iter ${i}] reassigned run ${c.runId} must have EXACTLY ONE terminal row (no double settle), got ${terms.length}: ${JSON.stringify(terms)}`,
        );
        assert.equal(
          terms[0]!.status,
          "done",
          `[iter ${i}] reassigned run ${c.runId} must complete done on the peer, got ${terms[0]!.status}`,
        );

        // Stopped instance's lockfile gone; exactly one peer survives.
        await waitFor(
          async () => {
            const pool = await rt.daemons(WF);
            return pool.length === 1 && !pool.some((d) => d.instanceId === stopped.instanceId);
          },
          `[iter ${i}] stopped instance ${stopped.instanceId} gone, one peer survives`,
          10_000,
        );
      } finally {
        await rt.cleanup();
      }
    }

    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ must be unchanged by the soak");
  },
);
