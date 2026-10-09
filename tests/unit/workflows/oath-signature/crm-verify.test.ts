import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  decideCrmGate,
  type CrmOathVerification,
} from "../../../../src/workflows/oath-signature/crm-verify.js";

/**
 * `decideCrmGate` is the pure decision that turns a CRM verification result into
 * the oath-signature gate outcome. The verification itself drives CRM (live);
 * this pins the branch logic + the operator-facing labels.
 */

const base: CrmOathVerification = {
  matched: false,
  oathSigned: false,
  signedDate: null,
  signedTime: null,
  processStage: null,
};

describe("decideCrmGate", () => {
  it("skips when no matching CRM record was found", () => {
    assert.deepEqual(decideCrmGate({ ...base, matched: false }), {
      skip: true,
      skipReason: "No CRM onboarding record",
      crmOnboarding: "No record",
      signedDate: null,
      signedTime: null,
    });
  });

  it("skips when a record exists but the oath was not signed in onboarding", () => {
    const d = decideCrmGate({
      ...base,
      matched: true,
      oathSigned: false,
      processStage: "Campus Forms Approved",
    });
    assert.equal(d.skip, true);
    assert.equal(d.skipReason, "Oath not signed in onboarding");
    assert.equal(d.crmOnboarding, "Not signed (Campus Forms Approved)");
    assert.equal(d.signedDate, null);
  });

  it("labels a not-signed record without a process stage plainly", () => {
    const d = decideCrmGate({ ...base, matched: true, oathSigned: false, processStage: null });
    assert.equal(d.crmOnboarding, "Not signed");
  });

  it("proceeds (no skip) and carries the CRM signature date/time when verified", () => {
    const d = decideCrmGate({
      matched: true,
      oathSigned: true,
      signedDate: "07/01/2026",
      signedTime: "1:27 PM",
      processStage: "Completed",
    });
    assert.deepEqual(d, {
      skip: false,
      skipReason: null,
      crmOnboarding: "Verified (Completed)",
      signedDate: "07/01/2026",
      signedTime: "1:27 PM",
    });
  });

  it("THROWS when the oath is signed but the history timestamp was unparseable — never proceeds with a null date", () => {
    // Proceeding with signedDate:null would fall through to UCPath's today
    // prefill and silently record a wrong signature date.
    assert.throws(
      () =>
        decideCrmGate({
          matched: true,
          oathSigned: true,
          signedDate: null,
          signedTime: null,
          processStage: "Completed",
        }),
      /refusing to substitute today's date/,
    );
  });

  it("verified label falls back to plain 'Verified' with no process stage", () => {
    const d = decideCrmGate({
      matched: true,
      oathSigned: true,
      signedDate: "07/01/2026",
      signedTime: null,
      processStage: null,
    });
    assert.equal(d.skip, false);
    assert.equal(d.crmOnboarding, "Verified");
    assert.equal(d.signedTime, null);
  });
});
