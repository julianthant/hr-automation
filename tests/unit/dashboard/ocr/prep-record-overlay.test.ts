import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { overlayServerOwnedPrepFields } from "../../../../src/dashboard/components/ocr/prep-record-overlay.js";
import type {
  OathPreviewRecord,
  VerifyPreviewRecord,
} from "../../../../src/dashboard/components/ocr/types.js";

function verifyRecord(overrides: Partial<VerifyPreviewRecord> = {}): VerifyPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 3,
    printedName: "Tran, Mia V",
    employeeId: "10535890",
    name: "Tran, Mia V",
    paperEmploymentDate: null,
    paperDateSigned: null,
    employeeSigned: true,
    officerSigned: false,
    matchState: "resolved",
    selected: true,
    warnings: [],
    checks: [],
    ...overrides,
  };
}

describe("overlayServerOwnedPrepFields", () => {
  it("lets fresh server-owned verify enrichment replace stale local snapshots", () => {
    const base = verifyRecord({
      i9LookupStatus: "completed",
      i9LookupTraceId: "vf-055335-6de2",
      officialSignerStatus: "unable-to-access",
      checks: [
        {
          key: "officialSigner",
          label: "Authorized Official Signer",
          onPaper: false,
          paperValue: null,
          foundValue: null,
          source: "i9",
          status: "missing",
          unavailable: true,
          missingLabel: "Unable to access",
        },
      ],
    });
    const staleLocal = verifyRecord({
      selected: false,
      i9LookupStatus: "pending",
      i9LookupTraceId: "vf-055335-6de2",
      checks: [
        {
          key: "officialSigner",
          label: "Authorized Official Signer",
          onPaper: false,
          paperValue: null,
          foundValue: null,
          source: "i9",
          status: "missing",
        },
      ],
    });

    const merged = overlayServerOwnedPrepFields(base, staleLocal) as VerifyPreviewRecord;

    assert.equal(merged.selected, false);
    assert.equal(merged.i9LookupStatus, "completed");
    assert.equal(merged.officialSignerStatus, "unable-to-access");
    assert.equal(merged.checks[0]?.unavailable, true);
    assert.equal(merged.checks[0]?.missingLabel, "Unable to access");
  });

  it("keeps mutable oath fields while refreshing server-owned lookup fields", () => {
    const base: OathPreviewRecord = {
      formKind: "oath",
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Doe, Jane",
      employeeId: "10000001",
      employeeSigned: true,
      officerSigned: true,
      dateSigned: "06/01/2026",
      notes: [],
      matchState: "resolved",
      matchSource: "form-eid",
      verification: { state: "verified", hrStatus: "active", department: "HDH", screenshotFilename: "ucpath.png", checkedAt: "2026-06-08T12:00:00Z" },
      selected: true,
      warnings: ["server warning"],
    };
    const local: OathPreviewRecord = {
      ...base,
      printedName: "Doe, Jane Edited",
      matchState: "lookup-running",
      matchSource: "manual",
      verification: undefined,
      warnings: ["stale warning"],
    };

    const merged = overlayServerOwnedPrepFields(base, local) as OathPreviewRecord;

    assert.equal(merged.printedName, "Doe, Jane Edited");
    assert.equal(merged.matchState, "resolved");
    assert.equal(merged.matchSource, "form-eid");
    assert.deepEqual(merged.warnings, ["server warning"]);
    assert.equal(merged.verification?.state, "verified");
  });
});
