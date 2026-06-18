import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveSeparationEid } from "../../../../src/workflows/separations/workflow.js";
import type { KualiSeparationData } from "../../../../src/systems/kuali/index.js";
import { personLookupWorkflow } from "../../../../src/workflows/person-lookup/index.js";

/**
 * Unit coverage for the name↔EID verification guard (`resolveSeparationEid`),
 * the `identity-check` step. The guard ALWAYS delegates to person-lookup BY
 * NAME and reconciles the resolved EID against the Kuali EID — the name is
 * authoritative. Exercised without a live browser or daemon: a scripted/stub
 * `ctx.delegateTo` stands in for the real person-lookup child run.
 *
 *   (1) verified MATCH — resolved EID == Kuali EID → returned unchanged, but a
 *       delegation DID happen (always verify), and no ctx.data.eid write.
 *   (2) MISMATCH — valid Kuali EID, a DIFFERENT valid resolved EID → take the
 *       name-derived EID + write it to ctx.data (name wins).
 *   (3) short/invalid Kuali EID, valid resolved EID → take the resolved EID
 *       (the wrong-but-typed value is corrected from the name).
 *   (4) person-lookup resolves NO valid EID (failed run, or `done` with an
 *       invalid emplId, or `done` with no data) → FAIL LOUD. We never proceed
 *       with an unverified EID, even when the Kuali EID is valid-format.
 *
 * The guard runs after kualiData is established by EITHER the extraction step
 * OR the edit-and-resume prefilled bypass — both converge on the same
 * `kualiData` object the guard reads, so this coverage applies to both.
 */

function makeKualiData(overrides: Partial<KualiSeparationData> = {}): KualiSeparationData {
  return {
    employeeName: "Mendoza, Matthew",
    eid: "1061029", // 7 digits — invalid UCPath EID
    lastDayWorked: "03/20/2026",
    separationDate: "03/21/2026",
    terminationType: "Resign - Personal Reasons",
    location: "",
    ...overrides,
  };
}

/**
 * Build a stub `ctx` exposing only the two members `resolveSeparationEid`
 * touches (`delegateTo` + `updateData`). The delegate stub records calls and
 * returns the scripted ChildRunResult.
 */
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

describe("resolveSeparationEid", () => {
  it("(1) verifies a matching valid EID — delegates BY NAME, returns it unchanged, no ctx.data write", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10772489" } });
    const kualiData = makeKualiData({ eid: "10772489", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData);

    assert.equal(result, "10772489", "matching EID returned verbatim");
    assert.equal(calls.length, 1, "always verifies — exactly one person-lookup delegation even on a match");
    assert.equal(calls[0].workflow, personLookupWorkflow.config.name, "delegated to person-lookup");
    assert.deepEqual(calls[0].input, { name: "Mendoza, Matthew" }, "delegated BY NAME");
    assert.equal(updated.eid, undefined, "no ctx.data.eid write when the EID already matches");
  });

  it("(2) takes the name-derived EID when a valid Kuali EID does NOT match the lookup (name wins)", async () => {
    // The Perez case: 10694136 is valid-FORMAT but the WRONG person; the name
    // resolves the real EID, which must win.
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10772489" } });
    const kualiData = makeKualiData({ eid: "10694136", employeeName: "Perez, Jason" });

    const result = await resolveSeparationEid(ctx, kualiData);

    assert.equal(result, "10772489", "name-derived EID returned over the mismatched Kuali EID");
    assert.equal(calls.length, 1, "exactly one delegation");
    assert.deepEqual(calls[0].input, { name: "Perez, Jason" }, "delegated BY NAME");
    assert.equal(updated.eid, "10772489", "corrected EID persisted to ctx.data for downstream + snapshot");
  });

  it("(3) corrects a short/invalid Kuali EID from the name", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10610290" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData);

    assert.equal(result, "10610290", "corrected 8-digit EID returned");
    assert.deepEqual(calls[0].input, { name: "Mendoza, Matthew" }, "delegated BY NAME (no bad EID passed)");
    assert.equal(updated.eid, "10610290", "corrected EID persisted to ctx.data");
  });

  it("(4) fails loud when person-lookup returns a FAILED run (cannot verify)", async () => {
    const { ctx } = makeStubCtx({ status: "failed", error: { message: "no match in UCPath" } });
    const kualiData = makeKualiData({ eid: "10772489", employeeName: "Mendoza, Matthew" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      (err: Error) => {
        assert.match(err.message, /Could not verify the EID for "Mendoza, Matthew"/);
        assert.match(err.message, /Kuali EID "10772489"/);
        assert.match(err.message, /Fix the name\/EID in the Kuali form and retry\./);
        return true;
      },
      "unverifiable EID must throw the clear operator error — even when the Kuali EID is valid-format",
    );
  });

  it("(4) fails loud when person-lookup is DONE but resolves no valid EID", async () => {
    // A `done` lookup that still produced a short / blank emplId is not a valid
    // verification — isUcpathEmployeeId is re-checked on the resolved value.
    const { ctx } = makeStubCtx({ status: "done", data: { emplId: "1061029" } });
    const kualiData = makeKualiData({ eid: "10772489" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      /person-lookup resolved no UCPath EID by name/,
      "a done run with an invalid emplId still fails loud",
    );
  });

  it("(4) fails loud when person-lookup returns done with no data at all", async () => {
    const { ctx } = makeStubCtx({ status: "done" });
    const kualiData = makeKualiData({ eid: "10772489" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      /Fix the name\/EID in the Kuali form and retry\./,
    );
  });
});
