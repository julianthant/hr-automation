import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildApproveSeparationEidHandler,
  buildDismissSeparationEidHandler,
} from "../../../src/control/ops/separations-eid-approval.js";

/**
 * Validation-guard coverage for the EID-approval control handlers. Both guards
 * return BEFORE any tracker/enqueue IO, so they're exercised with a throwaway
 * dir. The full re-enqueue path (fresh run carrying prefilledData.eidApproved)
 * is covered handler-side by `dry-run.test.ts` ("EID-approval re-run …").
 */
const DIR = "/tmp/does-not-matter-validation-only";

describe("buildApproveSeparationEidHandler — validation", () => {
  const approve = buildApproveSeparationEidHandler(DIR);

  it("rejects a non-8-digit EID before any IO", async () => {
    const r = await approve({ id: "4313", runId: "r1", eid: "abc" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not a valid 8-digit UCPath EID/);
  });

  it("rejects a too-short EID", async () => {
    const r = await approve({ id: "4313", eid: "1061029" }); // 7 digits
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not a valid 8-digit UCPath EID/);
  });

  it("rejects a missing id (with a valid EID)", async () => {
    const r = await approve({ id: "", eid: "10401814" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /id is required/);
  });
});

describe("buildDismissSeparationEidHandler — validation", () => {
  const dismiss = buildDismissSeparationEidHandler(DIR);

  it("rejects a missing id before any IO", async () => {
    const r = await dismiss({ id: "" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /id is required/);
  });
});
