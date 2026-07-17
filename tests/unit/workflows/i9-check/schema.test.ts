/**
 * The i9-check input schema — the SAFETY seam of the I-9 check workflow since
 * the 2026-07-17 split out of separations. A retried task replays its original
 * input through this schema; these tests pin that an i9-check payload parses
 * only here and can NEVER parse into the separations termination schema (a
 * legacy replay against separations must fail loud, not terminate someone).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  I9CheckMemberInputSchema,
  type I9CheckMemberInput,
} from "../../../../src/workflows/i9-check/schema.js";
import { i9CheckWorkflow } from "../../../../src/workflows/i9-check/workflow.js";
import { separationsWorkflow } from "../../../../src/workflows/separations/workflow.js";

function i9Input(over: Partial<I9CheckMemberInput> = {}): I9CheckMemberInput {
  return {
    mode: "i9-check",
    person: {
      name: "Sanchez, Gabriel",
      lastName: "Sanchez",
      firstName: "Gabriel",
      ssn: "558937070",
      dob: "10/08/1986",
      hireDate: "04/25/2016",
      sourcePage: 9,
      section2Page: 1,
    },
    roster: { ppsEid: "728527", ppsEidPadded: "000728527", separationDate: "9/19/2021" },
    ocrSessionId: "sess-1",
    ocrRunId: "run-1",
    recordIndex: 0,
    ...over,
  };
}

describe("I9CheckMemberInputSchema", () => {
  it("is the i9-check workflow's schema and parses a full input intact", () => {
    const parsed = i9CheckWorkflow.config.schema.parse(i9Input());
    assert.equal(parsed.person.name, "Sanchez, Gabriel");
    assert.equal(parsed.roster?.ppsEidPadded, "000728527");
    assert.equal(parsed.mode, "i9-check");
  });

  it("validates identifier formats (SSN 9 digits, DOB mm/dd/yyyy)", () => {
    assert.throws(() =>
      I9CheckMemberInputSchema.parse(i9Input({ person: { name: "X", ssn: "12345" } as never })),
    );
    assert.throws(() =>
      I9CheckMemberInputSchema.parse(i9Input({ person: { name: "X", dob: "1/2/86" } as never })),
    );
  });

  it("rejects a termination-shaped payload (docId is not an i9 check)", () => {
    assert.throws(() => I9CheckMemberInputSchema.parse({ docId: "4361" }));
  });
});

describe("cross-workflow safety: separations can never claim an i9-check payload", () => {
  const separationsSchema = separationsWorkflow.config.schema;

  it("a legacy i9-check payload FAILS LOUD against the separations schema", () => {
    // Pre-split, this input was a valid separations union member. Post-split
    // the separations schema is termination-only: `docId` is required and the
    // i9 fields are stripped as unknown keys — a replayed i9-check task can
    // never become a termination run.
    assert.throws(() => separationsSchema.parse(i9Input()));
  });

  it("a termination input still parses unchanged (docId + dryRun)", () => {
    const parsed = separationsSchema.parse({ docId: "4361", dryRun: true });
    assert.deepEqual(parsed, { docId: "4361", dryRun: true });
  });

  it("a hybrid payload carrying BOTH docId and mode never runs as a check — the i9 schema owns it, separations strips mode", () => {
    // The i9-check schema still claims a mode-bearing payload wholesale.
    const parsed = I9CheckMemberInputSchema.parse({ ...i9Input(), docId: "4361" });
    assert.equal(parsed.mode, "i9-check");
    assert.ok(!("docId" in parsed));
  });
});
