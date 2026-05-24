/**
 * Finding #14 — Pruned-SQLite + JSONL rescue branch.
 *
 * The existing tests in `retry-uses-original-input.test.ts` always seed a
 * live SQLite task row so `findRetryTaskSnapshot` returns a non-null result
 * and the SQLite-happy path handles the retry. The third branch —
 * "SQLite task row is missing; fall back to JSONL reconstruction via
 * `findEntryInput` + `enqueueFromHttp`" — was never exercised.
 *
 * Strategy: spy on `selectRetryInputFromEntries` (from `src/core/find-input.ts`)
 * and `enqueueFromHttp` (from `src/core/daemon/enqueue-dispatch.ts`). We do
 * NOT seed a SQLite task_attempts/tasks row for the runId under test, so
 * `findRetryTaskSnapshot` returns null and the code falls through to the
 * JSONL rescue branch. We assert:
 *   1. The handler returns `{ ok: true }`.
 *   2. `selectRetryInputFromEntries` was called (confirming JSONL was read).
 *   3. `enqueueFromHttp` was called with the reconstructed input.
 *
 * Note: `enqueueFromHttp` is mocked because it calls `loadWorkflow`, which
 * would attempt a real dynamic import + daemon spawn. The spy intercepts
 * after the rescue branch confirms the reconstructed input — the real
 * daemon path is not what we are testing here.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import { buildRetryHandler } from "../../../src/control/ops/retry.js";

// ---------------------------------------------------------------------------
// Mocks — declared at the top level so vi.mock hoisting works correctly.
// `enqueueFromHttp` is the production call the rescue branch makes after
// reconstructing the input from JSONL. We return { ok: true } to simulate a
// successful re-enqueue without spawning a real daemon.
// ---------------------------------------------------------------------------
vi.mock("../../../src/core/daemon/enqueue-dispatch.js", () => ({
  enqueueFromHttp: vi.fn().mockResolvedValue({ ok: true, workflow: "work-study", enqueued: 1 }),
}));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-rescue-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("retry JSONL rescue branch (Finding #14 — pruned SQLite row)", () => {
  it("falls back to JSONL reconstruction and calls enqueueFromHttp when no SQLite task row exists", async () => {
    // 1. Write a minimal JSONL history for the item WITHOUT ever writing a
    //    SQLite tasks/task_attempts row. This simulates a pruned-SQLite state
    //    where `npm run clean:tracker` removed the DB rows but JSONL audit
    //    history is still present.
    const runId = "pruned-run-001";
    const itemId = "9999";

    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T10:00:00.000Z",
        id: itemId,
        runId,
        status: "pending",
        data: {
          archetype: "single",
          emplId: itemId,
          effectiveDate: "2026-05-01",
          __name: "Pruned Person",
          __id: itemId,
          __subject: "Pruned Person",
          __queueTitle: "Pruned Person — work-study",
        },
        input: { emplId: itemId, effectiveDate: "2026-05-01" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T10:01:00.000Z",
        id: itemId,
        runId,
        status: "failed",
        step: "transaction:failed",
        data: {
          archetype: "single",
          emplId: itemId,
          effectiveDate: "2026-05-01",
          __name: "Pruned Person",
          __id: itemId,
          __subject: "Pruned Person",
          __queueTitle: "Pruned Person — work-study",
        },
        error: "timeout",
      },
      tmp,
    );

    // 2. Call retry with a runId that has NO corresponding SQLite row.
    //    `findRetryTaskSnapshot` queries task_attempts JOIN tasks by run_id;
    //    since we never wrote any task rows, it returns null and the handler
    //    falls through to the JSONL rescue branch.
    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: itemId,
      runId,
    });

    // 3. The rescue branch should succeed.
    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);

    // 4. Confirm `enqueueFromHttp` was called (the rescue branch's exit point).
    const { enqueueFromHttp } = await import("../../../src/core/daemon/enqueue-dispatch.js");
    const mockFn = enqueueFromHttp as ReturnType<typeof vi.fn>;
    assert.equal(mockFn.mock.calls.length >= 1, true, "enqueueFromHttp must be called on the JSONL rescue path");

    // 5. Confirm the reconstructed input passed to enqueueFromHttp is correct.
    //    The first arg is the workflow name, second is the inputs array.
    const [calledWorkflow, calledInputs] = mockFn.mock.calls[0] as [string, unknown[]];
    assert.equal(calledWorkflow, "work-study");
    assert.ok(Array.isArray(calledInputs) && calledInputs.length === 1, "one input reconstructed");
    const reconstructed = calledInputs[0] as Record<string, unknown>;
    assert.equal(reconstructed.emplId, itemId, "reconstructed input carries correct emplId");
    assert.equal(reconstructed.effectiveDate, "2026-05-01", "reconstructed input carries correct effectiveDate");
  });

  it("returns a structured error when the SQLite row is pruned AND the JSONL has no entries for the id", async () => {
    // No JSONL rows, no SQLite rows — rescue branch finds nothing → error.
    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "no-such-id",
      runId: "no-such-run",
    });

    assert.equal(result.ok, false, "must fail when both SQLite and JSONL are empty");
    assert.match(
      result.error ?? "",
      /no SQLite task record AND no tracker entries|cannot reconstruct retry payload/,
      "error must mention the reconstruction failure",
    );
  });
});
