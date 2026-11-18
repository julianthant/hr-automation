import assert from "node:assert/strict";
import type { Page } from "playwright";
import { test, vi } from "vitest";
import { log } from "../../../../src/utils/log.js";
import { buildWorkStudyPlan } from "../../../../src/workflows/work-study/enter.js";
import { WorkStudyInputSchema } from "../../../../src/workflows/work-study/schema.js";

test("Work Study dry run prepares the PayPath form with no submit action", () => {
  const input = { emplId: "12345", effectiveDate: "09/13/2026" };
  const page = {} as Page;
  const context = { employeeName: "" };
  const step = vi.spyOn(log, "step").mockImplementation(() => {});
  const stepLabels = () => step.mock.calls.map(([message]) => message).filter((message) => typeof message === "string");
  try {
    const dryRun = WorkStudyInputSchema.parse({ ...input, dryRun: true });
    buildWorkStudyPlan(dryRun, page, context).preview();
    const dryRunSteps = stepLabels();
    assert.ok(dryRunSteps.some((message) => message.includes("Fill Position Data")));
    assert.ok(dryRunSteps.some((message) => message.includes("Fill Initiator's Comments")));
    assert.ok(dryRunSteps.every((message) => !message.endsWith(". Save and Submit")));

    step.mockClear();
    buildWorkStudyPlan(WorkStudyInputSchema.parse(input), page, context).preview();
    assert.ok(stepLabels().some((message) => message.endsWith(". Save and Submit")));
  } finally {
    step.mockRestore();
  }
});
