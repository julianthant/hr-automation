import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildApproveEidHandler,
  buildDismissEidHandler,
  EID_APPROVAL_WORKFLOWS,
} from "../../../src/control/ops/eid-approval.js";

/**
 * Validation-guard coverage for the workflow-agnostic EID-approval control
 * handlers. Every guard returns BEFORE any tracker/enqueue IO, so they're
 * exercised with a throwaway dir. The full re-enqueue path (fresh run carrying
 * prefilledData.eidApproved) is covered handler-side by separations'
 * `dry-run.test.ts`; the separations-named facade stays pinned by
 * `separations-eid-approval.test.ts` (both unchanged).
 */
const DIR = "/tmp/does-not-matter-validation-only";

describe("EID_APPROVAL_WORKFLOWS", () => {
  it("includes the adopters (separations + onboarding)", () => {
    assert.ok(EID_APPROVAL_WORKFLOWS.has("separations"));
    assert.ok(EID_APPROVAL_WORKFLOWS.has("onboarding"));
  });
});

describe("buildApproveEidHandler — validation", () => {
  const approve = buildApproveEidHandler(DIR);

  it("rejects an unsupported workflow before any IO", async () => {
    const r = await approve({ workflow: "oath-signature", id: "x", eid: "10401814" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /unsupported workflow "oath-signature"/);
  });

  it("rejects a non-8-digit EID", async () => {
    const r = await approve({ workflow: "onboarding", id: "a@b.com", runId: "r1", eid: "abc" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not a valid 8-digit UCPath EID/);
  });

  it("rejects a too-short EID", async () => {
    const r = await approve({ workflow: "separations", id: "4313", eid: "1061029" }); // 7 digits
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not a valid 8-digit UCPath EID/);
  });

  it("rejects a missing id (with a valid EID + workflow)", async () => {
    const r = await approve({ workflow: "onboarding", id: "", eid: "10401814" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /id is required/);
  });
});

describe("buildDismissEidHandler — validation", () => {
  const dismiss = buildDismissEidHandler(DIR);

  it("rejects an unsupported workflow before any IO", async () => {
    const r = await dismiss({ workflow: "ocr", id: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /unsupported workflow "ocr"/);
  });

  it("rejects a missing id", async () => {
    const r = await dismiss({ workflow: "onboarding", id: "" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /id is required/);
  });
});
