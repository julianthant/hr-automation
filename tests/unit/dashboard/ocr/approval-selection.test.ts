import { describe, expect, it } from "vitest";
import {
  isApprovable,
  isApprovalSelectionBlocked,
  scrubHardBlockedSelection,
} from "../../../../src/dashboard/components/ocr/approval-selection.js";
import type { PreviewRecord } from "../../../../src/dashboard/components/ocr/types.js";
import type { Verification } from "../../../../src/services/ocr/forms/shared.js";

const VERIFIED: Verification = {
  state: "verified",
  hrStatus: "Active",
  department: "HDH",
  screenshotFilename: "x.png",
  checkedAt: "2026-07-17T00:00:00.000Z",
};
const INACTIVE: Verification = {
  state: "inactive",
  hrStatus: "Terminated",
  screenshotFilename: "x.png",
  checkedAt: "2026-07-17T00:00:00.000Z",
};
const LOOKUP_FAILED: Verification = {
  state: "lookup-failed",
  error: "no row",
  checkedAt: "2026-07-17T00:00:00.000Z",
};

function ecRecord(overrides: {
  verification?: Verification;
  selected?: boolean;
  documentType?: PreviewRecord["documentType"];
  matchState?: PreviewRecord["matchState"];
  employeeId?: string;
} = {}): PreviewRecord {
  return {
    formKind: "emergency-contact",
    sourcePage: 1,
    employee: {
      name: "Test, Person",
      employeeId: overrides.employeeId ?? "10864270",
    },
    emergencyContact: {
      name: "Contact",
      relationship: "Spouse",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
    matchState: overrides.matchState ?? "resolved",
    selected: overrides.selected ?? false,
    warnings: [],
    documentType: overrides.documentType ?? "expected",
    originallyMissing: [],
    ...(overrides.verification ? { verification: overrides.verification } : {}),
  };
}

describe("isApprovalSelectionBlocked", () => {
  it("blocks unknown pages", () => {
    expect(isApprovalSelectionBlocked(ecRecord({ documentType: "unknown" }))).toBe(true);
  });

  it("blocks inactive employees", () => {
    expect(isApprovalSelectionBlocked(ecRecord({ verification: INACTIVE }))).toBe(true);
  });

  it("allows verified / lookup-failed / unmatched rows", () => {
    expect(isApprovalSelectionBlocked(ecRecord({ verification: VERIFIED }))).toBe(false);
    expect(isApprovalSelectionBlocked(ecRecord({ verification: LOOKUP_FAILED }))).toBe(false);
    expect(isApprovalSelectionBlocked(ecRecord({ matchState: "lookup-pending" }))).toBe(false);
  });
});

describe("isApprovable", () => {
  it("counts resolved+verified with EID when selected", () => {
    expect(isApprovable(ecRecord({ selected: true, verification: VERIFIED }))).toBe(true);
  });

  it("excludes inactive even when selected (Approve N must not count them)", () => {
    expect(isApprovable(ecRecord({ selected: true, verification: INACTIVE }))).toBe(false);
  });

  it("excludes selected rows without a 5+ digit EID", () => {
    expect(isApprovable(ecRecord({ selected: true, employeeId: "", verification: VERIFIED }))).toBe(
      false,
    );
  });
});

describe("scrubHardBlockedSelection", () => {
  it("clears selected on inactive so Select-all / stale localStorage cannot stick", () => {
    const scrubbed = scrubHardBlockedSelection(
      ecRecord({ selected: true, verification: INACTIVE }),
    );
    expect(scrubbed.selected).toBe(false);
  });

  it("leaves approvable selected rows alone", () => {
    const rec = ecRecord({ selected: true, verification: VERIFIED });
    expect(scrubHardBlockedSelection(rec).selected).toBe(true);
  });
});
