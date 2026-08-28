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

  it("adds customization sections only as their defaults are turned off", () => {
    const full = defaultSelectedSteps(timeline);
    assert.deepEqual(runStartCustomizationSections({ timeline, defaultSteps: true, defaultOptions: true, selectedSteps: full }), []);
    assert.deepEqual(runStartCustomizationSections({ timeline, defaultSteps: false, defaultOptions: true, selectedSteps: full }), ["steps"]);
    assert.deepEqual(runStartCustomizationSections({ timeline, defaultSteps: false, defaultOptions: true, selectedSteps: ["verify-person", "submit"] }), ["steps", "values"]);
    assert.deepEqual(runStartCustomizationSections({ timeline, defaultSteps: false, defaultOptions: false, selectedSteps: full }), ["steps", "options"]);
  });

  it("projects the ordinary launcher as Input then Confirm", () => {
    assert.deepEqual(runStartStages([]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Confirm" },
    ]);
  });

  it("projects each dynamic launch path in causal order with no numbering gaps", () => {
    assert.deepEqual(runStartStages(["steps"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Confirm" },
    ]);
    assert.deepEqual(runStartStages(["steps", "values"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Values" },
      { number: 4, label: "Confirm" },
    ]);
    assert.deepEqual(runStartStages(["options"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Options" },
      { number: 3, label: "Confirm" },
    ]);
    assert.deepEqual(runStartStages(["steps", "options"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Options" },
      { number: 4, label: "Confirm" },
    ]);
    assert.deepEqual(runStartStages(["steps", "values", "options"]), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Values" },
      { number: 4, label: "Options" },
      { number: 5, label: "Confirm" },
    ]);
  });

  it("renumbers the path when restoring a supplying step removes Values", () => {
    const skipped = runStartCustomizationSections({
      timeline,
      defaultSteps: false,
      defaultOptions: false,
      selectedSteps: ["verify-person", "submit"],
    });
    assert.deepEqual(runStartStages(skipped), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Values" },
      { number: 4, label: "Options" },
      { number: 5, label: "Confirm" },
    ]);

    const restored = runStartCustomizationSections({
      timeline,
      defaultSteps: false,
      defaultOptions: false,
      selectedSteps: defaultSelectedSteps(timeline),
    });
    assert.deepEqual(runStartStages(restored), [
      { number: 1, label: "Input" },
      { number: 2, label: "Steps" },
      { number: 3, label: "Options" },
      { number: 4, label: "Confirm" },
    ]);
  });

  it("moves forward and back through only the stages that currently exist", () => {
    const stages = runStartStages(["steps", "values", "options"]);
    assert.equal(adjacentRunStartStage(stages, "Input", "next"), "Steps");
    assert.equal(adjacentRunStartStage(stages, "Steps", "next"), "Values");
    assert.equal(adjacentRunStartStage(stages, "Confirm", "previous"), "Options");
    assert.equal(adjacentRunStartStage(stages, "Input", "previous"), null);
    assert.equal(adjacentRunStartStage(stages, "Confirm", "next"), null);
  });

  it("falls back to the nearest earlier stage when a dynamic stage disappears", () => {
    assert.equal(reconcileRunStartStage(runStartStages(["steps", "options"]), "Values"), "Steps");
    assert.equal(reconcileRunStartStage(runStartStages([]), "Options"), "Input");
    assert.equal(reconcileRunStartStage(runStartStages(["options"]), "Confirm"), "Confirm");
  });
});
