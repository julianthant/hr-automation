import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  handlePersonMatch,
  personMatchWorkflow,
} from "../../../../src/workflows/person-match/workflow.js";
import type { PersonMatchInput } from "../../../../src/workflows/person-match/schema.js";
import { personMatchStatusExtensions } from "../../../../src/domain/person-match-status.js";

function makeCtx() {
  const updates: Array<Record<string, unknown>> = [];
  const screenshots: Array<Record<string, unknown>> = [];
  const ctx = {
    page: async (system: string) => {
      assert.equal(system, "ucpath");
      return {} as never;
    },
    step: async (name: string, fn: () => Promise<void>) => {
      assert.equal(name, "search");
      return fn();
    },
    updateData: (patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    screenshot: async (opts: { kind: string; label: string; systems?: string[] }) => {
      screenshots.push({ kind: opts.kind, label: opts.label, systems: opts.systems });
      return { kind: opts.kind, label: opts.label, step: "search", ts: 0, files: [] };
    },
  };
  return { ctx: ctx as never, updates, screenshots };
}

describe("personMatchWorkflow", () => {
  it("uses the person name without the workflow label as the operator subject", () => {
    const subject = personMatchWorkflow.config.operatorSubject?.({
      lastName: "Doe",
      firstName: "Jane",
      ssn: "123456789",
    });
    assert.deepEqual(subject, { kind: "person", label: "Doe, Jane" });
  });

  it("stamps found + first-match identity when UCPath has the person", async () => {
    const { ctx, updates, screenshots } = makeCtx();
    const input: PersonMatchInput = {
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
      { kind: "form", label: "person-match-search-result", systems: ["ucpath"] },
    ]);
  });

  it("stamps found=false with empty match fields on a definitive not-found", async () => {
    const { ctx, updates } = makeCtx();
    await handlePersonMatch(
      ctx,
      { lastName: "Roe", firstName: "Sam", dob: "01/02/2000" },
      (async () => ({ found: false })) as never,
    );
    assert.deepEqual(updates, [{ found: "false", matchedEmplId: "", matchedName: "" }]);
  });

  it("passes empty strings for absent ssn/dob (searchPerson's own guard owns the criteria check)", async () => {
    const { ctx } = makeCtx();
    const seen: unknown[] = [];
    await handlePersonMatch(
      ctx,
      { lastName: "Roe", firstName: "Sam", dob: "01/02/2000" },
      (async (_page: unknown, ssn: string, _f: string, _l: string, dob: string) => {
        seen.push([ssn, dob]);
        return { found: false };
      }) as never,
    );
    assert.deepEqual(seen, [["", "01/02/2000"]]);
  });
});

describe("personMatchStatusExtensions", () => {
  it("promotes a done not-found run to the notFound display status", () => {
    assert.equal(
      personMatchStatusExtensions.derivedStatus?.({
        status: "done",
        data: { found: "false" },
      } as never),
      "notFound",
    );
  });

  it("leaves found and non-terminal rows on the base status", () => {
    assert.equal(
      personMatchStatusExtensions.derivedStatus?.({
        status: "done",
        data: { found: "true" },
      } as never),
      null,
    );
    assert.equal(
      personMatchStatusExtensions.derivedStatus?.({
        status: "running",
        data: { found: "false" },
      } as never),
      null,
    );
  });
});
