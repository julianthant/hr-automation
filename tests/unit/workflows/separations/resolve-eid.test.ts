import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveSeparationEid } from "../../../../src/workflows/separations/workflow.js";
import type { KualiSeparationData } from "../../../../src/systems/kuali/index.js";
import { personLookupWorkflow } from "../../../../src/workflows/person-lookup/index.js";

/**
 * Unit coverage for the short-EID → person-lookup delegation guard
 * (`resolveSeparationEid`). Exercises the three contract cases without a live
 * browser or daemon: a scripted/stub `ctx.delegateTo` stands in for the real
 * person-lookup child run.
 *
 *   (a) a short/invalid Kuali EID triggers a person-lookup delegation BY NAME
 *       and the corrected 8-digit EID is returned + written to ctx.data.
 *   (b) a valid 8-digit EID does NOT delegate (returned verbatim).
 *   (c) person-lookup returning no/invalid EID (failed run, or `done` with no
 *       valid emplId) makes the guard FAIL LOUD with the clear operator error.
 *
 * The guard runs after kualiData is established by EITHER the extraction step
 * OR the edit-and-resume prefilled bypass — both paths converge on the same
 * `kualiData` object the guard reads, so this coverage applies to both (the
 * stub kualiData mirrors what either path produces).
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
  it("(b) returns a valid 8-digit EID unchanged and does NOT delegate", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10999999" } });
    const kualiData = makeKualiData({ eid: "10772489" });

    const result = await resolveSeparationEid(ctx, kualiData);

    assert.equal(result, "10772489", "valid EID returned verbatim");
    assert.equal(calls.length, 0, "no person-lookup delegation for a valid EID");
    assert.equal(updated.eid, undefined, "no ctx.data.eid write when nothing changed");
  });

  it("(a) delegates a short EID to person-lookup BY NAME and uses the corrected EID", async () => {
    const { ctx, calls, updated } = makeStubCtx({ status: "done", data: { emplId: "10610290" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    const result = await resolveSeparationEid(ctx, kualiData);

    assert.equal(result, "10610290", "corrected 8-digit EID returned");
    assert.equal(calls.length, 1, "exactly one delegation");
    assert.equal(calls[0].workflow, personLookupWorkflow.config.name, "delegated to person-lookup");
    assert.deepEqual(
      calls[0].input,
      { name: "Mendoza, Matthew" },
      "delegated by NAME (no bad EID passed — the name path has no EID-format constraint)",
    );
    assert.equal(updated.eid, "10610290", "corrected EID persisted to ctx.data for downstream + snapshot");
  });

  it("(c) fails loud when person-lookup returns a FAILED run (no EID)", async () => {
    const { ctx } = makeStubCtx({ status: "failed", error: { message: "no match in UCPath" } });
    const kualiData = makeKualiData({ eid: "1061029", employeeName: "Mendoza, Matthew" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      (err: Error) => {
        assert.match(err.message, /Short\/invalid EID "1061029"/);
        assert.match(err.message, /Mendoza, Matthew/);
        assert.match(err.message, /Fix the EID in the Kuali form and retry\./);
        return true;
      },
      "unresolvable short EID must throw the clear operator error, never continue silently",
    );
  });

  it("(c) fails loud when person-lookup is DONE but resolves no valid EID", async () => {
    // A `done` lookup that still produced a short / blank emplId must not be
    // accepted — isUcpathEmployeeId is re-checked on the resolved value.
    const { ctx } = makeStubCtx({ status: "done", data: { emplId: "1061029" } });
    const kualiData = makeKualiData({ eid: "1061029" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      /person-lookup returned no EID/,
      "a done run with an invalid emplId still fails loud",
    );
  });

  it("(c) fails loud when person-lookup returns done with no data at all", async () => {
    const { ctx } = makeStubCtx({ status: "done" });
    const kualiData = makeKualiData({ eid: "10" });

    await assert.rejects(
      () => resolveSeparationEid(ctx, kualiData),
      /Fix the EID in the Kuali form and retry\./,
    );
  });
});
