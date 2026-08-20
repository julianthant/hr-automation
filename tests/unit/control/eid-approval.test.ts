import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildApproveEidHandler,
  buildDismissEidHandler,
  buildNotThisPersonHandler,
  mergeNotMatchEids,
  EID_APPROVAL_WORKFLOWS,
  NOT_THIS_PERSON_WORKFLOWS,
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

describe("NOT_THIS_PERSON_WORKFLOWS + buildNotThisPersonHandler — validation (2026-08-20)", () => {
  const notThis = buildNotThisPersonHandler(DIR);
  it("is onboarding-only: separations must NOT proceed on a 'not this person' answer", () => {
    assert.ok(NOT_THIS_PERSON_WORKFLOWS.has("onboarding"));
    assert.ok(!NOT_THIS_PERSON_WORKFLOWS.has("separations"));
  });
  it("rejects an unsupported workflow before any IO", async () => {
    const r = await notThis({ workflow: "separations", id: "4313", eid: "10002180" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /unsupported workflow "separations"/);
  });
  it("rejects a non-8-digit EID", async () => {
    const r = await notThis({ workflow: "onboarding", id: "a@b.com", eid: "1087198" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not a valid 8-digit UCPath EID/);
  });
  it("rejects a missing id", async () => {
    const r = await notThis({ workflow: "onboarding", id: "", eid: "10002180" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /id is required/);
  });
});

describe("mergeNotMatchEids", () => {
  it("starts a list from nothing", () => {
    assert.equal(mergeNotMatchEids(undefined, "10002180"), "10002180");
    assert.equal(mergeNotMatchEids("", "10002180"), "10002180");
  });
  it("accumulates across reviews and de-duplicates", () => {
    assert.equal(mergeNotMatchEids("10001072, 10001585", "10839930"), "10001072,10001585,10839930");
    assert.equal(mergeNotMatchEids("10001072,10001585", "10001585"), "10001072,10001585");
  });
  it("ignores a non-string prior", () => {
    assert.equal(mergeNotMatchEids(["10001072"], "10002180"), "10002180");
  });
});
