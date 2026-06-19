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
 * handler's branch wiring (skip on "same", correct-name on "similar",
 * delegate on "different") is covered by `dry-run.test.ts`.
 *
 * The handler calls `resolveSeparationEid` ONLY when the Workforce Job Summary
 * result needs a NAME SEARCH, passing the Job Summary `{ found, name }`:
 *
 *   (1) FOUND + name mismatch, resolved EID differs → take the name-derived EID
 *       (name wins) + write it to ctx.data.
 *   (2) FOUND + name mismatch, resolved EID happens to MATCH the Kuali one →
 *       return unchanged, no ctx.data write (the names just rendered
 *       differently; the EID was right).
 *   (3) NOT found + short/incomplete EID → delegate BY NAME, take the resolved
 *       8-digit EID.
 *   (4) NOT found + a COMPLETE 8-digit EID → FAIL LOUD with NO delegation (we do
 *       not silently look up a complete-looking EID; the operator fixes Kuali).
 *   (5) delegation resolves NO valid EID (failed run / done-but-invalid / no
 *       data) → FAIL LOUD.
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
  const updated: Record<string, unknown> = {};
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
    updateData: (patch: Record<string, unknown>) => {
      Object.assign(updated, patch);
    },
  } as unknown as Parameters<typeof resolveSeparationEid>[0];
  return { ctx, calls, updated };
}

describe("resolveSeparationEid (conditional)", () => {
  it("(1) FOUND + name mismatch + different resolved EID → takes the name-derived EID", async () => {
    // The Perez case: 10694136 is a valid-FORMAT EID Job Summary FOUND, but its
    // detail-page name didn't match — so the handler calls us with found:true.
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10772489" } });
    const kualiData = makeKualiData({ eid: "10694136", employeeName: "Perez, Jason" });

    const result = await resolveSeparationEid(ctx, kualiData, {
      found: true,
      name: "Some Other Person",
    });

    assert.equal(result, "10772489", "name-derived EID returned over the mismatched Kuali EID");
    assert.equal(calls.length, 1, "exactly one delegation");
    assert.equal(calls[0].workflow, personLookupWorkflow.config.name);
    assert.deepEqual(calls[0].input, { name: "Perez, Jason" }, "delegated BY NAME");
    assert.equal(updated.eid, "10772489", "corrected EID persisted to ctx.data");
  });

  it("(2) FOUND + name mismatch but resolved EID matches Kuali → returns unchanged, no ctx.data write", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10772489" } });
    const kualiData = makeKualiData({ eid: "10772489", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData, { found: true, name: "M. Mendoza" });

    assert.equal(result, "10772489", "EID returned verbatim");
    assert.equal(calls.length, 1, "still delegated to confirm");
    assert.equal(updated.eid, undefined, "no ctx.data.eid write when the resolved EID matches");
  });

  it("(3) NOT found + short EID → delegates BY NAME and corrects to the resolved 8-digit EID", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10610290" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData, { found: false, name: "" });

    assert.equal(result, "10610290", "corrected 8-digit EID returned");
    assert.deepEqual(calls[0].input, { name: "Mendoza, Matthew" }, "delegated BY NAME (no bad EID passed)");
    assert.equal(updated.eid, "10610290", "corrected EID persisted to ctx.data");
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
