import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  defaultSelectedSteps,
  missingReplacementInputs,
  replacementInputsForSelection,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-runstart-timeline.js";
import type { StartTimelineWire } from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";

const timeline: StartTimelineWire = {
  note: "fixture",
  steps: [
    {
      key: "read-kuali",
      label: "Read Kuali",
      system: "Kuali",
      outcome: "identity and dates",
      replacementInputs: [
        { key: "eid", label: "EID", placeholder: "10000000", inputKind: "id" },
        { key: "date", label: "Date", placeholder: "MM/DD/YYYY", inputKind: "date" },
      ],
    },
    {
      key: "verify-person",
      label: "Verify person",
      system: "UCPath",
      outcome: "confirmed EID",
      replacementInputs: [
        { key: "eid", label: "EID", placeholder: "10000000", inputKind: "id" },
      ],
    },
    {
      key: "submit",
      label: "Submit",
      system: "UCPath",
      outcome: "transaction",
    },
  ],
};

describe("rebuild demo run-start timeline", () => {
  it("selects the full workflow by default and requires no replacement inputs", () => {
    const selected = defaultSelectedSteps(timeline);
    assert.deepEqual(selected, ["read-kuali", "verify-person", "submit"]);
    assert.deepEqual(replacementInputsForSelection(timeline, selected), []);
  });

  it("promotes skipped-step outputs into one deduplicated required-input form", () => {
    const inputs = replacementInputsForSelection(timeline, ["submit"]);
    assert.deepEqual(inputs.map((input) => input.key), ["eid", "date"]);
  });

  it("blocks review until every promoted input has a non-blank value", () => {
    const inputs = replacementInputsForSelection(timeline, ["verify-person", "submit"]);
    assert.deepEqual(missingReplacementInputs(inputs, { eid: "  " }).map((input) => input.key), ["eid", "date"]);
    assert.deepEqual(missingReplacementInputs(inputs, { eid: "10000000", date: "08/28/2026" }), []);
  });
});

