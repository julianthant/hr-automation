import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { personLookupStatusExtensions } from "../../../../src/domain/person-lookup-status.js";
import {
  handlePersonLookup,
  personLookupWorkflow,
} from "../../../../src/workflows/person-lookup/workflow.js";
import { handlePersonMatch } from "../../../../src/workflows/person-lookup/match.js";
import type { PersonLookupMatchInput } from "../../../../src/workflows/person-lookup/schema.js";

function makeMatchCtx() {
  const updates: Array<Record<string, unknown>> = [];
  const screenshots: Array<Record<string, unknown>> = [];
  const steps: string[] = [];
  const skipped: string[] = [];
  const data: Record<string, unknown> = {};
  const ctx = {
    get data() {
      return { ...data };
    },
    page: async (system: string) => {
      assert.equal(system, "ucpath");
      return {} as never;
    },
    step: async (name: string, fn: () => Promise<unknown>) => {
      steps.push(name);
      return fn();
    },
    skipStep: (name: string) => {
      skipped.push(name);
    },
    updateData: (patch: Record<string, unknown>) => {
      updates.push(patch);
      Object.assign(data, patch);
    },
    screenshot: async (opts: { kind: string; label: string; systems?: string[] }) => {
      screenshots.push({ kind: opts.kind, label: opts.label, systems: opts.systems });
      return { kind: opts.kind, label: opts.label, step: "searching", ts: 0, files: [] };
    },
  };
  return { ctx: ctx as never, updates, screenshots, steps, skipped };
}

describe("Person Lookup Match mode", () => {
  it("uses the legal name without the workflow label as the operator subject", () => {
    const subject = personLookupWorkflow.config.operatorSubject?.({
      mode: "match",
      lastName: "Doe",
      firstName: "Jane",
      ssn: "123456789",
    });
    assert.deepEqual(subject, { kind: "person", label: "Doe, Jane" });
  });

  it("stamps the first UCPath match and captures the result page", async () => {
    const { ctx, updates, screenshots } = makeMatchCtx();
    const input: PersonLookupMatchInput = {
      mode: "match",
      lastName: "Doe",
      firstName: "Jane",
      ssn: "123456789",
      dob: "04/01/1998",
    };
    const seen: unknown[] = [];

    await handlePersonMatch(ctx, input, (async (
      _page: unknown,
      ssn: string,
      firstName: string,
      lastName: string,
      dob: string,
    ) => {
      seen.push([ssn, firstName, lastName, dob]);
      return {
        found: true,
        matches: [{ emplId: "10874100", firstName: "Jane", lastName: "Doe" }],
      };
    }) as never);

    assert.deepEqual(seen, [["123456789", "Jane", "Doe", "04/01/1998"]]);
    assert.deepEqual(updates, [
      { found: "true", matchedEmplId: "10874100", matchedName: "Jane Doe" },
    ]);
    assert.deepEqual(screenshots, [
      { kind: "form", label: "person-lookup-match-result", systems: ["ucpath"] },
    ]);
  });

  it("stamps found=false with empty match fields on a definitive miss", async () => {
    const { ctx, updates } = makeMatchCtx();
    await handlePersonMatch(
      ctx,
      { mode: "match", lastName: "Roe", firstName: "Sam", dob: "01/02/2000" },
      (async () => ({ found: false })) as never,
    );
    assert.deepEqual(updates, [{ found: "false", matchedEmplId: "", matchedName: "" }]);
  });

  it("passes empty strings for absent SSN or DOB", async () => {
    const { ctx } = makeMatchCtx();
    const seen: unknown[] = [];
    await handlePersonMatch(
      ctx,
      { mode: "match", lastName: "Roe", firstName: "Sam", dob: "01/02/2000" },
      (async (_page: unknown, ssn: string, _f: string, _l: string, dob: string) => {
        seen.push([ssn, dob]);
        return { found: false };
      }) as never,
    );
    assert.deepEqual(seen, [["", "01/02/2000"]]);
  });

  it("uses searching and skips CRM, active status, and CRM dates by default", async () => {
    const { ctx, steps, skipped } = makeMatchCtx();
    await handlePersonLookup(
      ctx,
      { mode: "match", lastName: "Roe", firstName: "Sam", dob: "01/02/2000" },
      (async () => ({ found: false })) as never,
    );
    assert.deepEqual(steps, ["searching"]);
    assert.deepEqual(skipped, ["cross-verification", "active-status", "crm-dates"]);
  });
});

describe("personLookupStatusExtensions Match answer", () => {
  it("promotes a done UCPath miss to the notFound display status", () => {
    assert.equal(
      personLookupStatusExtensions.derivedStatus?.({
        workflow: "person-lookup",
        status: "done",
        data: { found: "false" },
      } as never),
      "notFound",
    );
  });

  it("leaves found and non-terminal rows on the base status", () => {
    assert.equal(
      personLookupStatusExtensions.derivedStatus?.({
        workflow: "person-lookup",
        status: "done",
        data: { found: "true" },
      } as never),
      null,
    );
    assert.equal(
      personLookupStatusExtensions.derivedStatus?.({
        workflow: "person-lookup",
        status: "running",
        data: { found: "false" },
      } as never),
      null,
    );
  });
});
