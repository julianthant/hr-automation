/**
 * SAFETY GUARD — a separations i9-check row must never be retried via JSONL
 * reconstruction. The reconstructed input for a separations row is
 * docId-shaped, so re-enqueuing it would start a REAL termination run for a
 * person who was only being retention-checked. When the SQLite task row is
 * gone (pruned) or never existed (legacy display-only rows), the retry must
 * REFUSE, loudly. See src/workflows/separations/CLAUDE.md → "I-9 mode".
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import { buildRetryHandler } from "../../../src/control/ops/retry.js";

vi.mock("../../../src/core/daemon/enqueue-dispatch.js", () => ({
  enqueueFromHttp: vi.fn().mockResolvedValue({ ok: true, workflow: "separations", enqueued: 1 }),
}));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-i9-guard-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("retry i9-check reconstruction guard", () => {
  it("REFUSES to reconstruct a separations row carrying data.i9Check", async () => {
    const runId = "i9-member-run-001";
    const itemId = "i9-check-sess1-r0";

    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-07-16T10:00:00.000Z",
        id: itemId,
        runId,
        status: "failed",
        step: "i9-check",
        data: {
          archetype: "operation-member",
          i9Check: "true",
          name: "Sanchez, Gabriel",
          __name: "Sanchez, Gabriel",
          __id: itemId,
        },
        error: "search timed out",
      },
      tmp,
    );

    const result = await buildRetryHandler(tmp)({
      workflow: "separations",
      id: itemId,
      runId,
    });

    assert.equal(result.ok, false, "reconstruction must be refused");
    assert.match(result.error ?? "", /i9-check rows cannot be reconstructed/);
    assert.match(result.error ?? "", /re-run the\s+I-9 upload/);

    const { enqueueFromHttp } = await import("../../../src/core/daemon/enqueue-dispatch.js");
    const mockFn = enqueueFromHttp as ReturnType<typeof vi.fn>;
    assert.equal(mockFn.mock.calls.length, 0, "nothing may be enqueued for a refused i9-check retry");
  });

  it("still reconstructs a NORMAL separations row (no i9Check marker)", async () => {
    const runId = "sep-run-001";
    const itemId = "4361";

    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-07-16T10:00:00.000Z",
        id: itemId,
        runId,
        status: "failed",
        step: "ucpath-transaction",
        data: { archetype: "single", docId: itemId, __id: itemId },
        input: { docId: itemId },
        error: "timeout",
      },
      tmp,
    );

    const result = await buildRetryHandler(tmp)({
      workflow: "separations",
      id: itemId,
      runId,
    });

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  });
});
