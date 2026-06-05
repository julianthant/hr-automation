import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  handleI9Lookup,
  i9LookupWorkflow,
} from "../../../../src/workflows/i9-lookup/workflow.js";
import type { I9LookupInput } from "../../../../src/workflows/i9-lookup/schema.js";

describe("i9LookupWorkflow", () => {
  it("uses the person name without the workflow label as the operator subject", () => {
    const subject = i9LookupWorkflow.config.operatorSubject?.({
      lastName: "Provenzano",
      firstName: "Vincent",
    });

    assert.deepEqual(subject, {
      kind: "person",
      label: "Provenzano, Vincent",
    });
  });

  it("labels signerName as Authorized Official Signer", () => {
    const signerField = i9LookupWorkflow.config.detailFields?.find((field) =>
      typeof field !== "string" && field.key === "signerName"
    );

    assert.deepEqual(signerField, {
      key: "signerName",
      label: "Authorized Official Signer",
    });
  });

  it("captures an I9 screenshot after lookup data is stamped", async () => {
    const input: I9LookupInput = { lastName: "Provenzano", firstName: "Vincent" };
    const updates: Array<Record<string, unknown>> = [];
    const screenshots: Array<Record<string, unknown>> = [];
    const page = {};

    await handleI9Lookup(
      {
        page: async (system: string) => {
          assert.equal(system, "i9");
          return page as never;
        },
        step: async (name, fn) => {
          assert.equal(name, "lookup");
          return fn();
        },
        updateData: (patch) => {
          updates.push(patch);
        },
        screenshot: async (opts) => {
          screenshots.push({ kind: opts.kind, label: opts.label, systems: opts.systems });
          return {
            kind: opts.kind,
            label: opts.label,
            step: "lookup",
            ts: 0,
            files: [],
          };
        },
      },
      input,
      async () => ({
        status: "signed",
        signerName: "KENIA QUINONEZ",
        profileId: "1670462",
        i9Id: "1602018",
      }),
    );

    assert.deepEqual(updates, [
      {
        signerName: "KENIA QUINONEZ",
        i9Status: "signed",
        profileId: "1670462",
      },
    ]);
    assert.deepEqual(screenshots, [
      { kind: "form", label: "i9-lookup-summary", systems: ["i9"] },
    ]);
  });
});
