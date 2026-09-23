import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { deriveProcessEidResult } from "../../../../src/workflows/process-eid/workflow.js";
import type { TransactionEidLookupResult } from "../../../../src/systems/ucpath/ss-smart-hr.js";

function lookupResult(
  overrides: Partial<TransactionEidLookupResult>,
): TransactionEidLookupResult {
  return {
    transactionFound: true,
    transactionId: "T002235451",
    eid: "",
    approvalStatus: "Pending",
    effectiveDate: "2026-09-28",
    ucpathName: "Ineza Marekani",
    ...overrides,
  };
}

describe("deriveProcessEidResult", () => {
  test("returns Found only when the exact transaction has an assigned EID", () => {
    assert.equal(
      deriveProcessEidResult(lookupResult({ eid: "10901366" })),
      "Found",
    );
  });

  test("returns Pending when the exact transaction exists without an EID", () => {
    assert.equal(deriveProcessEidResult(lookupResult({ eid: "" })), "Pending");
  });

  test("returns Not found when the exact roster transaction is absent", () => {
    assert.equal(
      deriveProcessEidResult(
        lookupResult({
          transactionFound: false,
          eid: "",
          approvalStatus: "",
          effectiveDate: "",
          ucpathName: "",
        }),
      ),
      "Not found",
    );
  });
});
