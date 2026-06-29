import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveSeparationEid } from "../../../../src/workflows/separations/workflow.js";
import type { KualiSeparationData } from "../../../../src/systems/kuali/index.js";
import { personLookupWorkflow } from "../../../../src/workflows/person-lookup/index.js";

/**
 * Unit coverage for the "very different name" / "EID not found" arm of the
 * `identity-check` step (`resolveSeparationEid`). The three-tier name gate
 * itself (`same` / `similar` / `different`) is covered by
 * `classifyNameSimilarity` in `tests/unit/services/matching/match.test.ts`; the
 * handler's branch wiring (skip on "same", correct-name on "similar", PAUSE on a
 * resolved-different EID, eidPreApproved re-run skip) is covered by
 * `dry-run.test.ts`.
 *
 * The handler calls `resolveSeparationEid` ONLY when the Workforce Job Summary
 * result needs a NAME SEARCH, passing the Job Summary `{ found, name }`. Since
 * the 2026-06-29 EID-approval change, this NO LONGER silently overrides the EID
 * — a resolved DIFFERENT EID returns `needs-approval` (the handler pauses for
 * operator approval) and it performs NO `ctx.updateData`:
 *
 *   (1) FOUND + name mismatch, resolved EID DIFFERS → `needs-approval` carrying
 *       the proposed person's context (no auto-override).
 *   (2) FOUND + name mismatch, resolved EID MATCHES the Kuali one → `verified`
 *       (the names just rendered differently; the EID was right).
 *   (3) NOT found + short/incomplete EID, resolved EID DIFFERS → `needs-approval`.
 *   (4) NOT found + a COMPLETE 8-digit EID → FAIL LOUD with NO delegation.
 *   (5) delegation resolves NO valid EID (failed / done-but-invalid / no data) →
 *       FAIL LOUD.
 *
 * A scripted/stub `ctx.delegateTo` stands in for the real person-lookup child
 * run — no live browser or daemon.
 */

function makeKualiData(overrides: Partial<KualiSeparationData> = {}): KualiSeparationData {
  return {
    employeeName: "Mendoza, Matthew",
    eid: "1061029", // 7 digits — incomplete UCPath EID
    lastDayWorked: "03/20/2026",
    separationDate: "03/21/2026",
    terminationType: "Resign - Personal Reasons",
    location: "",
    ...overrides,
  };
}

function makeStubCtx(delegateResult: {
  status: "done" | "failed" | "cancelled" | "pending";
  data?: Record<string, string>;
  error?: { message: string };
}) {
  const calls: Array<{ workflow: string; input: unknown }> = [];
  const ctx = {
    delegateTo: async (child: { config: { name: string } }, input: unknown) => {
      calls.push({ workflow: child.config.name, input });
      return {
        workflow: child.config.name,
        runId: "stub-run",
        itemId: "stub-item",
        ...delegateResult,
      };
    },
  } as unknown as Parameters<typeof resolveSeparationEid>[0];
  return { ctx, calls };
}

describe("resolveSeparationEid (conditional)", () => {
  it("(1) FOUND + name mismatch + different resolved EID → needs-approval (no silent override)", async () => {
    // The Perez case: 10694136 is a valid-FORMAT EID Job Summary FOUND, but its
    // detail-page name didn't match — so the handler calls us with found:true.
    // person-lookup returns the proposed person's name/department/payrollTitle.
    const { ctx, calls } = makeStubCtx({
      status: "done",
      data: {
        emplId: "10772489",
        name: "Jason Perez",
        department: "FACILITIES MANAGEMENT",
        payrollTitle: "BLDG MAINT WORKER SR",
      },
    });
    const kualiData = makeKualiData({ eid: "10694136", employeeName: "Perez, Jason" });

    const result = await resolveSeparationEid(ctx, kualiData, {
      found: true,
      name: "Some Other Person",
    });

    assert.equal(result.status, "needs-approval", "a DIFFERENT EID pauses for approval");
    assert.equal(result.status === "needs-approval" && result.proposedEid, "10772489");
    assert.equal(result.status === "needs-approval" && result.proposedName, "Jason Perez");
    assert.equal(result.status === "needs-approval" && result.proposedDepartment, "FACILITIES MANAGEMENT");
    assert.equal(result.status === "needs-approval" && result.proposedPayrollTitle, "BLDG MAINT WORKER SR");
    assert.equal(calls.length, 1, "exactly one delegation");
    assert.equal(calls[0].workflow, personLookupWorkflow.config.name);
    assert.deepEqual(calls[0].input, { name: "Perez, Jason" }, "delegated BY NAME");
  });

  it("(2) FOUND + name mismatch but resolved EID matches Kuali → verified", async () => {
    const { ctx, calls } = makeStubCtx({ status: "done", data: { emplId: "10772489" } });
    const kualiData = makeKualiData({ eid: "10772489", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData, { found: true, name: "M. Mendoza" });

    assert.equal(result.status, "verified", "matching EID is verified, not paused");
    assert.equal(result.status === "verified" && result.eid, "10772489");
    assert.equal(calls.length, 1, "still delegated to confirm");
  });

  it("(3) NOT found + short EID → needs-approval with the resolved 8-digit EID", async () => {
    const { ctx, calls } = makeStubCtx({ status: "done", data: { emplId: "10610290" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData, { found: false, name: "" });

    assert.equal(result.status, "needs-approval", "a new EID resolved by name pauses for approval");
    assert.equal(result.status === "needs-approval" && result.proposedEid, "10610290");
    assert.deepEqual(calls[0].input, { name: "Mendoza, Matthew" }, "delegated BY NAME (no bad EID passed)");
  });

  it("(4) NOT found + a COMPLETE 8-digit EID → fails loud with NO delegation", async () => {
    const { ctx, calls } = makeStubCtx({ status: "done", data: { emplId: "10999999" } });
    const kualiData = makeKualiData({ eid: "10772489", employeeName: "Mendoza, Matthew" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData, { found: false, name: "" }),
      (err: Error) => {
        assert.match(err.message, /found no record for "Mendoza, Matthew"/);
        assert.match(err.message, /complete 8 digits/);
        assert.match(err.message, /Fix the EID\/name in the Kuali form and retry\./);
        return true;
      },
    );
    assert.equal(calls.length, 0, "a complete-but-missing EID is never looked up by name");
  });

  it("(5) fails loud when person-lookup returns a FAILED run", async () => {
    const { ctx } = makeStubCtx({ status: "failed", error: { message: "no match in UCPath" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData, { found: false, name: "" }),
      (err: Error) => {
        assert.match(err.message, /Could not verify the EID for "Mendoza, Matthew"/);
        assert.match(err.message, /person-lookup resolved no UCPath EID by name/);
        return true;
      },
    );
  });

  it("(5) fails loud when person-lookup is DONE but resolves an invalid emplId", async () => {
    const { ctx } = makeStubCtx({ status: "done", data: { emplId: "1061029" } });
    const kualiData = makeKualiData({ eid: "1061029" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData, { found: false, name: "" }),
      /person-lookup resolved no UCPath EID by name/,
    );
  });

  it("(5) fails loud when person-lookup returns done with no data at all", async () => {
    const { ctx } = makeStubCtx({ status: "done" });
    const kualiData = makeKualiData({ eid: "1061029" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData, { found: false, name: "" }),
      /Fix the name\/EID in the Kuali form and retry\./,
    );
  });
});
