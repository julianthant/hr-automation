import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildIdentityApprovalPauseData,
  identityApprovalState,
  identityApprovalStatusExtensions,
  IDENTITY_APPROVAL_PENDING_STATUS,
} from "../../../src/domain/identity-approval.js";

/**
 * The workflow-agnostic identity-approval gate — the pause/approve/reject state
 * machine's pure core, extracted from separations so onboarding (and later
 * emergency-contact / onbase) share it. Pins the PAUSE data stamp (what the
 * banner reads) + the derived status badge (pending → awaitingApproval,
 * dismissed → dismissed). The re-enqueue/dismiss control side is pinned in
 * `tests/unit/control/eid-approval.test.ts`; the separations wiring stays pinned
 * by `separations-status.test.ts` + `dry-run.test.ts` (unchanged).
 */

describe("buildIdentityApprovalPauseData", () => {
  it("stamps pending + both candidates when the original EID resolved a UCPath record", () => {
    // Separations' wrong-person case: Kuali EID found a different-named person;
    // a name search resolved a different valid EID.
    const data = buildIdentityApprovalPauseData({
      original: {
        eid: "10833507",
        name: "Santos Hernandez",
        found: true,
        department: "HOUSING/DINING/HOSPITALITY",
        payrollTitle: "STDT 3",
      },
      proposed: {
        eid: "10401814",
        name: "Jose Hernandez",
        department: "FACILITIES MANAGEMENT",
        payrollTitle: "BLDG MAINT WORKER SR",
      },
    });

    assert.equal(data.eidApproval, "pending");
    assert.equal(data.status, IDENTITY_APPROVAL_PENDING_STATUS);
    assert.equal(data.status, "Awaiting EID Approval");
    // Original candidate (the input record's EID).
    assert.equal(data.originalEid, "10833507");
    assert.equal(data.originalEidName, "Santos Hernandez");
    assert.equal(data.originalEidDepartment, "HOUSING/DINING/HOSPITALITY");
    assert.equal(data.originalEidPayrollTitle, "STDT 3");
    assert.equal(data.originalEidFound, "true");
    // Proposed candidate (resolved by name).
    assert.equal(data.proposedEid, "10401814");
    assert.equal(data.proposedEidName, "Jose Hernandez");
    assert.equal(data.proposedEidDepartment, "FACILITIES MANAGEMENT");
    assert.equal(data.proposedEidPayrollTitle, "BLDG MAINT WORKER SR");
  });

  it("blanks the original name when the original EID did NOT resolve a record", () => {
    // Onboarding's case: a new-hire CRM record has no UCPath EID / never resolves.
    const data = buildIdentityApprovalPauseData({
      original: { eid: "", name: "Jane Doe", found: false },
      proposed: { eid: "10401814", name: "Jane Roe" },
    });

    assert.equal(data.originalEidFound, "false");
    assert.equal(data.originalEidName, "", "no name shown for an unresolved original");
    assert.equal(data.originalEid, "");
    // Missing department/title default to empty strings (banner renders no detail line).
    assert.equal(data.originalEidDepartment, "");
    assert.equal(data.originalEidPayrollTitle, "");
    assert.equal(data.proposedEidDepartment, "");
    assert.equal(data.proposedEidPayrollTitle, "");
    assert.equal(data.proposedEid, "10401814");
    assert.equal(data.proposedEidName, "Jane Roe");
  });

  it("honors a custom status label", () => {
    const data = buildIdentityApprovalPauseData({
      original: { eid: "10000001", name: "A", found: true },
      proposed: { eid: "10000002", name: "B" },
      statusLabel: "Needs identity review",
    });
    assert.equal(data.status, "Needs identity review");
  });

  it("returns only string values (survives the stringified tracker channel)", () => {
    const data = buildIdentityApprovalPauseData({
      original: { eid: "10000001", name: "A", found: true },
      proposed: { eid: "10000002", name: "B" },
    });
    for (const [k, v] of Object.entries(data)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
    }
  });
});

describe("identityApprovalState", () => {
  it("reads data.eidApproval, defaulting to empty string", () => {
    assert.equal(identityApprovalState({ data: { eidApproval: "pending" } }), "pending");
    assert.equal(identityApprovalState({ data: { eidApproval: "dismissed" } }), "dismissed");
    assert.equal(identityApprovalState({ data: {} }), "");
    assert.equal(identityApprovalState({}), "");
  });
});

describe("identityApprovalStatusExtensions.derivedStatus", () => {
  const derived = (eidApproval?: string) => {
    const data: Record<string, string> = {};
    if (eidApproval !== undefined) data.eidApproval = eidApproval;
    return identityApprovalStatusExtensions.derivedStatus!({ workflow: "x", status: "done", data });
  };

  it("→ awaitingApproval when pending", () => {
    assert.equal(derived("pending"), "awaitingApproval");
  });

  it("→ dismissed when dismissed", () => {
    assert.equal(derived("dismissed"), "dismissed");
  });

  it("→ null on a normal row (no / unknown eidApproval)", () => {
    assert.equal(derived(), null);
    assert.equal(derived("approved"), null, "approved re-runs are normal rows, no badge");
  });

  it("declares no secondaryTag", () => {
    assert.equal(identityApprovalStatusExtensions.secondaryTag, undefined);
  });
});
