import { privateValue } from "../../../../src/private-data.js";
import { test } from "vitest";
import assert from "node:assert/strict";

import { maskSsn, isUcpathRejectedSsn, ssnForUcpathEntry } from "../../../../src/domain/identity/ssn.js";

test("maskSsn keeps only the last four digits", () => {
  assert.equal(maskSsn(privateValue("ssn:01a54629efb95228")), "***-**-6789");
  assert.equal(maskSsn("123456789"), "***-**-6789");
  assert.equal(maskSsn(""), "");
  assert.equal(maskSsn(undefined), "");
  assert.equal(maskSsn("12"), "***");
});

test("isUcpathRejectedSsn flags the 900-999 area range UCPath refuses", () => {
  // The live rejection (2026-08-18): "cannot begin with 9 ... 900-999 in 1 to 3 Positions".
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:1438887c12c566c8")), true, "all-9s placeholder");
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:f8c5ef7e1ddb97c6")), true, "bottom of the range");
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:dd6eb82a4d9831b0")), true, "a real ITIN");
  assert.equal(isUcpathRejectedSsn("999999999"), true, "undashed still detected");
});

test("isUcpathRejectedSsn leaves ordinary SSNs alone", () => {
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:01a54629efb95228")), false);
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:073109fb3771fce7")), false, "just below the range");
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:6aaac7c44f069e4a")), false, "a 9 that is not in the AREA digits");
  // A trailing 9999 alone must NOT trip it — only positions 1-3 matter.
  assert.equal(isUcpathRejectedSsn(privateValue("ssn:11930e5e009e15dc")), false);
});

test("isUcpathRejectedSsn is false for absent or malformed input rather than guessing", () => {
  assert.equal(isUcpathRejectedSsn(undefined), false);
  assert.equal(isUcpathRejectedSsn(null), false);
  assert.equal(isUcpathRejectedSsn(""), false);
  assert.equal(isUcpathRejectedSsn("999-99"), false, "too short to judge");
  assert.equal(isUcpathRejectedSsn("999-99-99999"), false, "too long to judge");
});

test("ssnForUcpathEntry drops a rejected SSN and never substitutes another value", () => {
  assert.equal(ssnForUcpathEntry(privateValue("ssn:1438887c12c566c8")), undefined);
  assert.equal(ssnForUcpathEntry(privateValue("ssn:dd6eb82a4d9831b0")), undefined);
  // An enterable SSN passes through byte-identical.
  assert.equal(ssnForUcpathEntry(privateValue("ssn:01a54629efb95228")), privateValue("ssn:01a54629efb95228"));
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
