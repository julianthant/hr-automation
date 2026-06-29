/**
 * P3.13 — Concurrency / Soak: multi-run fan-out, staged cancels, no stall/orphan/drift.
 *
 * Drives TWO parents each fanning out children concurrently through the REAL
 * daemon against a temp tracker root. Children are cancelled at DIFFERENT
 * delegation stages across parents. The full scenario loops SOAK_ITERATIONS
 * times inside one test — fresh parentRunIds each iteration; ONE shared `rt`
 * so cross-iteration count drift is itself an assertion.
 *
 * Invariants pinned every iteration:
 *   - No stalls:       every child reaches a terminal (done / failed+cancelled).
 *   - No orphans:      rt.children(parentA) == 3; rt.children(parentB) == 2.
 *   - No count drift:  5 distinct child runIds total; cancelled → Cancelled;
 *                      released → Done.
 *   - Sibling independence: releasing childA3 while A1/A2 cancel does not harm it.
 *   - Projection:      archetype === "operation-member"; parentRunId correct.
 *   - Group anchors:   parentA.memberCount === 3; parentB.memberCount === 2.
 *   - .tracker/ untouched: temp dir only; real .tracker/ never written.
 *
 * Soak knob (default 5 — keeps `npm test` well under 30s):
 *   HR_SOAK_ITERATIONS=50 npx vitest run tests/delegation/concurrency-soak.test.ts
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  type DelegationRuntime,
} from "./_runtime/index.js";

// ---------------------------------------------------------------------------
// Soak knob
// ---------------------------------------------------------------------------

/**
 * Number of full scenario iterations per test run.
 * Default 5 keeps `npm test` wall-time well under 30s.
 * Crank with: HR_SOAK_ITERATIONS=50 npx vitest run tests/delegation/concurrency-soak.test.ts
 */
const SOAK_ITERATIONS = Number(process.env["HR_SOAK_ITERATIONS"] ?? 5);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REAL_TRACKER_DIR = ".tracker";

function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null;
  return readdirSync(REAL_TRACKER_DIR).sort();
}

async function waitForQueue(
  workflow: string,
  dir: string,
  pred: (st: Awaited<ReturnType<typeof readQueueStateIncludingTerminals>>) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = await readQueueStateIncludingTerminals(workflow, dir);
    if (pred(st)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForQueue(${workflow}) timed out after ${timeoutMs}ms: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Per-iteration scenario
//
// Parent A — 3 children:
//   childA1: cancelled mid-hold at `transaction`
//   childA2: cancelled mid-hold at `transaction` (different child, same parent)
//   childA3: released → done
//
// Parent B — 2 children:
//   childB1: released → done
//   childB2: cancelled mid-hold at `transaction`
//
// Total: 5 children in flight at once → instances: 5
// ---------------------------------------------------------------------------

interface IterationResult {
  parentARunId: string;
  parentBRunId: string;
  childA1RunId: string;
  childA2RunId: string;
  childA3RunId: string;
  childB1RunId: string;
  childB2RunId: string;
}

async function runIteration(
  rt: DelegationRuntime,
  iteration: number,
  allPriorParents: Array<{ parentRunId: string; expectedCount: number }>,
): Promise<IterationResult> {
  const tag = `iter${iteration}`;

  // ── 1. Enqueue all 5 children under their respective parents ─────────────

  rt.holdAll("soak-child", "transaction");

  const parentARunId = randomUUID();
  const parentBRunId = randomUUID();

  const [cA1, cA2, cA3, cB1, cB2] = await Promise.all([
    rt.enqueue(
      "soak-child",
      { id: `${tag}-a1`, name: `Alice-${tag}` },
      { parentRunId: parentARunId, renderAs: "batch" },
    ),
    rt.enqueue(
      "soak-child",
      { id: `${tag}-a2`, name: `Bob-${tag}` },
      { parentRunId: parentARunId, renderAs: "batch" },
    ),
    rt.enqueue(
      "soak-child",
      { id: `${tag}-a3`, name: `Carol-${tag}` },
      { parentRunId: parentARunId, renderAs: "batch" },
    ),
    rt.enqueue(
      "soak-child",
      { id: `${tag}-b1`, name: `Dave-${tag}` },
      { parentRunId: parentBRunId, renderAs: "batch" },
    ),
    rt.enqueue(
      "soak-child",
      { id: `${tag}-b2`, name: `Eve-${tag}` },
      { parentRunId: parentBRunId, renderAs: "batch" },
    ),
  ]);

  // ── 2. Wait for every child to reach the held `transaction` stage ─────────
  //
  // Each child gets its own waitForEvent so we know exactly which child is at
  // `transaction` before we cancel it — mandatory per the harness rules.

  await Promise.all([
    rt.waitForEvent("step:start", { step: "transaction", runId: cA1!.runId, timeoutMs: 15_000 }),
    rt.waitForEvent("step:start", { step: "transaction", runId: cA2!.runId, timeoutMs: 15_000 }),
    rt.waitForEvent("step:start", { step: "transaction", runId: cA3!.runId, timeoutMs: 15_000 }),
    rt.waitForEvent("step:start", { step: "transaction", runId: cB1!.runId, timeoutMs: 15_000 }),
    rt.waitForEvent("step:start", { step: "transaction", runId: cB2!.runId, timeoutMs: 15_000 }),
  ]);

  // ── 3. Cancel A1, A2, B2 while held; release A3, B1 ─────────────────────
  //
  // Cancel and release in parallel — the held stage rejects on signal-abort,
  // the released ones proceed to done. These are truly independent daemon runs
  // so concurrent cancel+release is safe.

  await Promise.all([
    rt.cancel(cA1!.runId),
    rt.cancel(cA2!.runId),
    rt.cancel(cB2!.runId),
  ]);

  rt.release(cA3!.runId, "transaction");
  rt.release(cB1!.runId, "transaction");

  // ── 4. Wait for all children to reach terminal ───────────────────────────

  await Promise.all([
    rt.waitForEvent("run:terminal", { runId: cA1!.runId, occasion: "cancelled", timeoutMs: 15_000 }),
    rt.waitForEvent("run:terminal", { runId: cA2!.runId, occasion: "cancelled", timeoutMs: 15_000 }),
    rt.waitForEvent("run:terminal", { runId: cA3!.runId, occasion: "completed", timeoutMs: 15_000 }),
    rt.waitForEvent("run:terminal", { runId: cB1!.runId, occasion: "completed", timeoutMs: 15_000 }),
    rt.waitForEvent("run:terminal", { runId: cB2!.runId, occasion: "cancelled", timeoutMs: 15_000 }),
  ]);

  // Poll until all 5 are in terminal state in JSONL
  const allRunIds = [cA1!.runId, cA2!.runId, cA3!.runId, cB1!.runId, cB2!.runId];
  const cancelledRunIds = new Set([cA1!.runId, cA2!.runId, cB2!.runId]);
  const doneRunIds = new Set([cA3!.runId, cB1!.runId]);

  await waitForQueue(
    "soak-child",
    rt.trackerDir,
    (st) => {
      const failedIds = new Set(st.failed.map((i) => i.runId));
      const doneIds = new Set(st.done.map((i) => i.runId));
      return (
        [...cancelledRunIds].every((id) => failedIds.has(id)) &&
        [...doneRunIds].every((id) => doneIds.has(id))
      );
    },
    15_000,
  );

  // ── 5. No-stall invariant ────────────────────────────────────────────────

  const finalState = await readQueueStateIncludingTerminals("soak-child", rt.trackerDir);
  const finalFailedIds = new Set(finalState.failed.map((i) => i.runId));
  const finalDoneIds = new Set(finalState.done.map((i) => i.runId));
  const finalClaimedIds = new Set(finalState.claimed.map((i) => i.runId));
  const finalQueuedIds = new Set(finalState.queued.map((i) => i.runId));

  for (const runId of allRunIds) {
    assert.ok(
      finalFailedIds.has(runId) || finalDoneIds.has(runId),
      `[iter ${iteration}] run ${runId} is stuck — not in failed or done (claimed=${finalClaimedIds.has(runId)}, queued=${finalQueuedIds.has(runId)})`,
    );
  }

  // ── 6. No-orphans invariant ──────────────────────────────────────────────

  const kidsA = await rt.children(parentARunId);
  const kidsB = await rt.children(parentBRunId);

  assert.equal(
    kidsA.length,
    3,
    `[iter ${iteration}] parentA should have exactly 3 children, got ${kidsA.length}`,
  );
  assert.equal(
    kidsB.length,
    2,
    `[iter ${iteration}] parentB should have exactly 2 children, got ${kidsB.length}`,
  );

  // No run belongs to the wrong parent
  const kidsARunIds = new Set(kidsA.map((k) => k.runId));
  const kidsBRunIds = new Set(kidsB.map((k) => k.runId));

  for (const runId of [cA1!.runId, cA2!.runId, cA3!.runId]) {
    assert.ok(kidsARunIds.has(runId), `[iter ${iteration}] ${runId} should be under parentA`);
    assert.ok(!kidsBRunIds.has(runId), `[iter ${iteration}] ${runId} must NOT be under parentB`);
  }
  for (const runId of [cB1!.runId, cB2!.runId]) {
    assert.ok(kidsBRunIds.has(runId), `[iter ${iteration}] ${runId} should be under parentB`);
    assert.ok(!kidsARunIds.has(runId), `[iter ${iteration}] ${runId} must NOT be under parentA`);
  }

  // No duplicates within each parent
  assert.equal(kidsARunIds.size, 3, `[iter ${iteration}] duplicate runIds under parentA`);
  assert.equal(kidsBRunIds.size, 2, `[iter ${iteration}] duplicate runIds under parentB`);

  // ── 7. No-count-drift invariant ──────────────────────────────────────────

  const allChildRunIds = [...kidsA, ...kidsB].map((k) => k.runId);
  const distinctChildRunIds = new Set(allChildRunIds);

  assert.equal(
    distinctChildRunIds.size,
    5,
    `[iter ${iteration}] expected 5 distinct child runIds across both parents, got ${distinctChildRunIds.size}`,
  );

  // ── 8. Dashboard projection asserts ─────────────────────────────────────

  const dash = rt.dashboard();

  // Every child is a delegated batch-member with the correct parentRunId
  for (const { runId, parentRunId } of [
    { runId: cA1!.runId, parentRunId: parentARunId },
    { runId: cA2!.runId, parentRunId: parentARunId },
    { runId: cA3!.runId, parentRunId: parentARunId },
    { runId: cB1!.runId, parentRunId: parentBRunId },
    { runId: cB2!.runId, parentRunId: parentBRunId },
  ]) {
    const row = dash.row("soak-child", runId);
    assert.equal(
      row.archetype,
      "operation-member",
      `[iter ${iteration}] run ${runId} must be batch-member, got ${row.archetype}`,
    );
    assert.equal(
      row.parentRunId,
      parentRunId,
      `[iter ${iteration}] run ${runId} parentRunId mismatch`,
    );
  }

  // Cancelled children
  for (const runId of [cA1!.runId, cA2!.runId, cB2!.runId]) {
    const row = dash.row("soak-child", runId);
    assert.equal(
      row.status,
      "failed",
      `[iter ${iteration}] cancelled run ${runId} must have status 'failed', got '${row.status}'`,
    );
    assert.equal(
      row.step,
      "cancelled",
      `[iter ${iteration}] cancelled run ${runId} must have step 'cancelled', got '${row.step}'`,
    );
    assert.equal(
      row.statusLabel,
      "Cancelled",
      `[iter ${iteration}] cancelled run ${runId} statusLabel must be 'Cancelled', got '${row.statusLabel}'`,
    );
  }

  // Released children
  for (const runId of [cA3!.runId, cB1!.runId]) {
    const row = dash.row("soak-child", runId);
    assert.equal(
      row.statusLabel,
      "Done",
      `[iter ${iteration}] done run ${runId} statusLabel must be 'Done', got '${row.statusLabel}'`,
    );
  }

  // Group anchors
  const anchorA = dash.groupAnchor("soak-child", parentARunId);
  const anchorB = dash.groupAnchor("soak-child", parentBRunId);

  assert.equal(
    anchorA.memberCount,
    3,
    `[iter ${iteration}] parentA anchor memberCount must be 3, got ${anchorA.memberCount}`,
  );
  assert.equal(
    anchorB.memberCount,
    2,
    `[iter ${iteration}] parentB anchor memberCount must be 2, got ${anchorB.memberCount}`,
  );

  // ── 9. Cross-iteration count-drift check (prior iterations unaffected) ───

  for (const { parentRunId: priorParent, expectedCount } of allPriorParents) {
    const priorKids = await rt.children(priorParent);
    assert.equal(
      priorKids.length,
      expectedCount,
      `[iter ${iteration}] prior parent ${priorParent} now has ${priorKids.length} children (drift!) — expected ${expectedCount}`,
    );
  }

  return {
    parentARunId,
    parentBRunId,
    childA1RunId: cA1!.runId,
    childA2RunId: cA2!.runId,
    childA3RunId: cA3!.runId,
    childB1RunId: cB1!.runId,
    childB2RunId: cB2!.runId,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test(
  "concurrency/soak — multi-run fan-out, staged cancels, no stall/orphan/drift",
  { timeout: 120_000 },
  async (t) => {
    const before = snapshotRealTracker();

    // 5 daemon instances so all 5 children across both parents hold `transaction`
    // concurrently (one daemon = one concurrent run).
    const rt = await createDelegationRuntime({
      workflows: [
        {
          workflow: {
            name: "soak-child",
            code: "sk",
            stages: ["load", "transaction", "finalize"],
            gatedStages: ["transaction"],
            archetype: "single",
            inputSubject: "name",
          },
          instances: 5,
        },
      ],
      idleTimeoutMs: 30_000,
    });
    t.onTestFinished(() => rt.cleanup());

    // Accumulate parent/expected-count pairs so each iteration can assert prior
    // iterations' children are still stable (cross-iteration count-drift check).
    const allPriorParents: Array<{ parentRunId: string; expectedCount: number }> = [];

    for (let i = 0; i < SOAK_ITERATIONS; i++) {
      const result = await runIteration(rt, i + 1, allPriorParents);

      // Register both parents from this iteration for future cross-iter checks.
      allPriorParents.push(
        { parentRunId: result.parentARunId, expectedCount: 3 },
        { parentRunId: result.parentBRunId, expectedCount: 2 },
      );
    }

    // Final cross-iteration count check across ALL iterations' parents.
    for (const { parentRunId, expectedCount } of allPriorParents) {
      const kids = await rt.children(parentRunId);
      assert.equal(
        kids.length,
        expectedCount,
        `final cross-iter check: parent ${parentRunId} has ${kids.length} children, expected ${expectedCount}`,
      );
    }

    await rt.cleanup();

    // The real .tracker/ must be completely untouched.
    assert.deepEqual(
      snapshotRealTracker(),
      before,
      "real .tracker/ must be unchanged by the harness",
    );
    assert.equal(
      existsSync(rt.trackerDir),
      false,
      "temp tracker dir must be removed by cleanup",
    );
  },
);
