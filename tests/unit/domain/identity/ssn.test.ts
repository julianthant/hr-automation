import { test } from "vitest";
import assert from "node:assert/strict";

import { maskSsn, isUcpathRejectedSsn, ssnForUcpathEntry } from "../../../../src/domain/identity/ssn.js";

test("maskSsn keeps only the last four digits", () => {
  assert.equal(maskSsn("123-45-6789"), "***-**-6789");
  assert.equal(maskSsn("123456789"), "***-**-6789");
  assert.equal(maskSsn(""), "");
  assert.equal(maskSsn(undefined), "");
  assert.equal(maskSsn("12"), "***");
});

test("isUcpathRejectedSsn flags the 900-999 area range UCPath refuses", () => {
  // The live rejection (2026-08-18): "cannot begin with 9 ... 900-999 in 1 to 3 Positions".
  assert.equal(isUcpathRejectedSsn("999-99-9999"), true, "all-9s placeholder");
  assert.equal(isUcpathRejectedSsn("900-00-0000"), true, "bottom of the range");
  assert.equal(isUcpathRejectedSsn("912-34-5678"), true, "a real ITIN");
  assert.equal(isUcpathRejectedSsn("999999999"), true, "undashed still detected");
});

test("isUcpathRejectedSsn leaves ordinary SSNs alone", () => {
  assert.equal(isUcpathRejectedSsn("123-45-6789"), false);
  assert.equal(isUcpathRejectedSsn("899-99-9999"), false, "just below the range");
  assert.equal(isUcpathRejectedSsn("089-99-9999"), false, "a 9 that is not in the AREA digits");
  // A trailing 9999 alone must NOT trip it — only positions 1-3 matter.
  assert.equal(isUcpathRejectedSsn("123-45-9999"), false);
});

test("isUcpathRejectedSsn is false for absent or malformed input rather than guessing", () => {
  assert.equal(isUcpathRejectedSsn(undefined), false);
  assert.equal(isUcpathRejectedSsn(null), false);
  assert.equal(isUcpathRejectedSsn(""), false);
  assert.equal(isUcpathRejectedSsn("999-99"), false, "too short to judge");
  assert.equal(isUcpathRejectedSsn("999-99-99999"), false, "too long to judge");
});

test("ssnForUcpathEntry drops a rejected SSN and never substitutes another value", () => {
  assert.equal(ssnForUcpathEntry("999-99-9999"), undefined);
  assert.equal(ssnForUcpathEntry("912-34-5678"), undefined);
  // An enterable SSN passes through byte-identical.
  assert.equal(ssnForUcpathEntry("123-45-6789"), "123-45-6789");
  assert.equal(ssnForUcpathEntry(undefined), undefined);
  assert.equal(ssnForUcpathEntry(""), undefined);
});

// ── Transaction comment wording (operator-specified, 2026-08-18) ──
// Lives here because the no-SSN sentence and the SSN-rejection rule are one
// behaviour: a rejected SSN must produce the "no SSN yet" comment.
test("buildCommentsText: base line, and the no-SSN sentence appended", async () => {
  const { buildCommentsText } = await import("../../../../src/systems/ucpath/transaction.js");

  assert.equal(
    buildCommentsText("09/11/2026", "1169086", true),
    "New Dining Student Hire Effective 09/11/2026. Job number #1169086.",
  );
  assert.equal(
    buildCommentsText("09/11/2026", "1169086", false),
    "New Dining Student Hire Effective 09/11/2026. Job number #1169086."
      + " EE does not have an SSN yet, we will add it as soon as it is provided.",
  );
});
