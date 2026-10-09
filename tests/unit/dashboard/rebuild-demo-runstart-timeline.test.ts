import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  adjacentRunStartStage,
  defaultSelectedSteps,
  missingReplacementInputs,
  reconcileRunStartStage,
  replacementInputsForSelection,
  runStartCustomizationSections,
  runStartStages,
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

  it("blocks Start until every promoted input has a non-blank value", () => {
    const inputs = replacementInputsForSelection(timeline, ["verify-person", "submit"]);
    assert.deepEqual(missingReplacementInputs(inputs, { eid: "  " }).map((input) => input.key), ["eid", "date"]);
    assert.deepEqual(missingReplacementInputs(inputs, { eid: "10000000", date: "08/28/2026" }), []);
  });

  it("removes a promoted requirement as soon as a supplying step is restored", () => {
    const skippedRead = replacementInputsForSelection(timeline, ["verify-person", "submit"]);
    assert.deepEqual(skippedRead.map((input) => input.key), ["eid", "date"]);

    const restoredRead = replacementInputsForSelection(timeline, ["read-kuali", "verify-person", "submit"]);
    assert.deepEqual(restoredRead, []);
  });

  it("always shows Options and adds Steps only when customization is enabled", () => {
    const full = defaultSelectedSteps(timeline);
    assert.deepEqual(runStartCustomizationSections({ timeline, customizeSteps: false, selectedSteps: full }), ["options"]);
    assert.deepEqual(runStartCustomizationSections({ timeline, customizeSteps: true, selectedSteps: full }), ["options", "steps"]);
    assert.deepEqual(runStartCustomizationSections({ timeline, customizeSteps: true, selectedSteps: ["verify-person", "submit"] }), ["options", "steps", "values"]);
  });

  it("projects the ordinary launcher as Input, Options, then Confirm", () => {
    assert.deepEqual(runStartStages(["options"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Confirm" },
    ]);
  });

  it("projects the customized path in causal order with no numbering gaps", () => {
    assert.deepEqual(runStartStages(["options", "steps"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Steps" },
      { number: 4, label: "Confirm" },
    ]);
    assert.deepEqual(runStartStages(["options", "steps", "values"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Steps" },
      { number: 4, label: "Values" },
      { number: 5, label: "Confirm" },
    ]);
  });

  it("renumbers the path when restoring a supplying step removes Values", () => {
    const skipped = runStartCustomizationSections({
      timeline,
      customizeSteps: true,
      selectedSteps: ["verify-person", "submit"],
    });
    assert.deepEqual(runStartStages(skipped), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Steps" },
      { number: 4, label: "Values" },
      { number: 5, label: "Confirm" },
    ]);

    const restored = runStartCustomizationSections({
      timeline,
      customizeSteps: true,
      selectedSteps: defaultSelectedSteps(timeline),
    });
    assert.deepEqual(runStartStages(restored), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Steps" },
      { number: 4, label: "Confirm" },
    ]);
  });

  it("moves forward and back through only the stages that currently exist", () => {
    const stages = runStartStages(["options", "steps", "values"]);
    assert.equal(adjacentRunStartStage(stages, "Input", "next"), "Options");
    assert.equal(adjacentRunStartStage(stages, "Options", "next"), "Steps");
    assert.equal(adjacentRunStartStage(stages, "Steps", "next"), "Values");
    assert.equal(adjacentRunStartStage(stages, "Confirm", "previous"), "Values");
    assert.equal(adjacentRunStartStage(stages, "Input", "previous"), null);
    assert.equal(adjacentRunStartStage(stages, "Confirm", "next"), null);
  });

  it("falls back to the nearest earlier stage when a dynamic stage disappears", () => {
    assert.equal(reconcileRunStartStage(runStartStages(["options", "steps"]), "Values"), "Steps");
    assert.equal(reconcileRunStartStage(runStartStages(["options"]), "Steps"), "Options");
    assert.equal(reconcileRunStartStage(runStartStages(["options"]), "Confirm"), "Confirm");
  });
});
