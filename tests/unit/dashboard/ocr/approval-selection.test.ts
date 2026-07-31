import { describe, expect, it } from "vitest";
import {
  MANUAL_EID_WARNING,
  isApprovable,
  isApprovalSelectionBlocked,
  promoteManualEidMatch,
  readRecordEid,
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

  it("allows inactive employees (submittable — operator decision 2026-07-27)", () => {
    expect(isApprovalSelectionBlocked(ecRecord({ verification: INACTIVE }))).toBe(false);
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

  it("counts inactive when selected (Approve N includes them)", () => {
    expect(isApprovable(ecRecord({ selected: true, verification: INACTIVE }))).toBe(true);
  });

  it("excludes unknown pages even when selected", () => {
    expect(
      isApprovable(ecRecord({ selected: true, documentType: "unknown", verification: VERIFIED })),
    ).toBe(false);
  });

  it("excludes selected rows without a 5+ digit EID", () => {
    expect(isApprovable(ecRecord({ selected: true, employeeId: "", verification: VERIFIED }))).toBe(
      false,
    );
  });
});

describe("scrubHardBlockedSelection", () => {
  it("clears selected on unknown pages so stale localStorage cannot stick", () => {
    const scrubbed = scrubHardBlockedSelection(
      ecRecord({ selected: true, documentType: "unknown" }),
    );
    expect(scrubbed.selected).toBe(false);
  });

  it("leaves selected inactive rows alone (submittable)", () => {
    const rec = ecRecord({ selected: true, verification: INACTIVE });
    expect(scrubHardBlockedSelection(rec).selected).toBe(true);
  });

  it("leaves approvable selected rows alone", () => {
    const rec = ecRecord({ selected: true, verification: VERIFIED });
    expect(scrubHardBlockedSelection(rec).selected).toBe(true);
  });
});

describe("promoteManualEidMatch", () => {
  // The live case (batch 2, 2026-07-28): Person Lookup came back `ambiguous`
  // for a name with four UCPath candidates, leaving the row `unresolved` with
  // no EID. Typing the EID must make the row approvable — before this, it
  // could not be approved no matter what the operator entered.
  it("promotes an unresolved row to resolved/manual when the operator types an EID", () => {
    const base = ecRecord({ matchState: "unresolved", employeeId: "", selected: true });
    const typed = ecRecord({ matchState: "unresolved", employeeId: "10633171", selected: true });

    const promoted = promoteManualEidMatch(base, typed);

    expect(promoted.matchState).toBe("resolved");
    expect(promoted.matchSource).toBe("manual");
    expect(isApprovable(promoted)).toBe(true);
    expect(promoted.warnings).toContain(MANUAL_EID_WARNING);
  });

  it("leaves the record untouched when the EID is unchanged from the server value", () => {
    const base = ecRecord({ matchState: "unresolved", employeeId: "10633171" });
    const next = { ...ecRecord({ matchState: "unresolved", employeeId: "10633171" }), selected: true };

    expect(promoteManualEidMatch(base, next)).toBe(next);
  });

  it("does not promote on a partial/invalid EID", () => {
    const base = ecRecord({ matchState: "unresolved", employeeId: "" });
    const typed = ecRecord({ matchState: "unresolved", employeeId: "106" });

    expect(promoteManualEidMatch(base, typed).matchState).toBe("unresolved");
  });

  it("drops stale confidence and verification when overriding a resolved EID", () => {
    // The lookup's verification/confidence describe the OLD identity — they
    // must not follow a different, hand-typed one onto the card.
    const base = { ...ecRecord({ matchState: "resolved", employeeId: "10883900" }), matchConfidence: 0.97 };
    const typed = {
      ...ecRecord({ matchState: "resolved", employeeId: "10633171", verification: VERIFIED }),
      matchConfidence: 0.97,
    };

    const promoted = promoteManualEidMatch(base, typed);

    expect(promoted.matchSource).toBe("manual");
    expect(promoted.matchConfidence).toBeUndefined();
    expect(promoted.verification).toBeUndefined();
  });

  it("does not stack the provenance warning across repeated edits", () => {
    const base = ecRecord({ matchState: "unresolved", employeeId: "" });
    const once = promoteManualEidMatch(base, ecRecord({ matchState: "unresolved", employeeId: "10633171" }));
    const twice = promoteManualEidMatch(base, once);

    expect(twice.warnings.filter((w) => w === MANUAL_EID_WARNING)).toHaveLength(1);
  });

  it("promotes a manually added row, which has no base record at all", () => {
    const typed = ecRecord({ matchState: "unresolved", employeeId: "10633171", selected: true });

    expect(promoteManualEidMatch(undefined, typed).matchState).toBe("resolved");
  });
});

describe("readRecordEid", () => {
  it("reads the EC shape (nested under employee)", () => {
    expect(readRecordEid(ecRecord({ employeeId: "10633171" }))).toBe("10633171");
  });

  it("reads the oath shape (top-level employeeId)", () => {
    const oathShaped = { ...ecRecord(), employeeId: "10883900" } as unknown as PreviewRecord;
    expect(readRecordEid(oathShaped)).toBe("10883900");
  });

  it("is empty for a missing record", () => {
    expect(readRecordEid(undefined)).toBe("");
  });
});
