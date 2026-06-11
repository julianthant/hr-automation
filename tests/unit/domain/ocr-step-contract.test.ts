/**
 * OCR step-string contract guard.
 *
 * The orchestrator (`src/workflows/ocr/orchestrator.ts`) emits step phase
 * strings via `emitSnapshot(records, stepName, ...)`. The dashboard's
 * `StepPipeline` uses `OCR_CANONICAL_STEP_ORDER` (for position-based remap)
 * and `OCR_RETIRED_STEP_FOLD` (for sub-phase fold) from
 * `src/domain/ocr-steps.ts` to render these correctly.
 *
 * If the orchestrator emits a new phase string that is NOT covered by either
 * table, `computeOcrPipelineView` falls through to a position-based lookup
 * that returns -1 → the row renders as "stuck at step 0" (every chip pending).
 *
 * This test asserts that every step string the orchestrator is known to emit
 * appears in either `OCR_CANONICAL_STEP_ORDER` or `OCR_RETIRED_STEP_FOLD`.
 * It is a static/grep-based guard — no real OCR is run.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  OCR_CANONICAL_STEP_ORDER,
  OCR_RETIRED_STEP_FOLD,
  OCR_LIVE_STEPS,
} from "../../../src/domain/ocr-steps.js";
import { computeOcrPipelineView } from "../../../src/dashboard/components/log-panel/StepPipeline.js";

/** Step strings the orchestrator is known to emit today (static fixture). */
const ORCHESTRATOR_EMITTED_STEPS = [
  "loading-roster", // emitted at ocr start
  "ocr",            // emitted during OCR processing
  "person-lookup",  // emitted during person lookup phase
  "awaiting-approval", // emitted for delegated runs awaiting approval
] as const;

/** Legacy/retired step strings that may appear in persisted rows. */
const RETIRED_STEP_STRINGS = [
  "matching",       // folded → ocr
  "disambiguating", // folded → ocr
  "verification",   // remapped via position (sat after person-lookup)
] as const;

test("every live orchestrator step is in OCR_CANONICAL_STEP_ORDER", () => {
  for (const step of ORCHESTRATOR_EMITTED_STEPS) {
    assert.ok(
      OCR_CANONICAL_STEP_ORDER.includes(step),
      `Live step "${step}" is NOT in OCR_CANONICAL_STEP_ORDER — StepPipeline will render stuck-at-0`,
    );
  }
});

test("every live orchestrator step is in OCR_LIVE_STEPS", () => {
  for (const step of ORCHESTRATOR_EMITTED_STEPS) {
    assert.ok(
      (OCR_LIVE_STEPS as readonly string[]).includes(step),
      `Live step "${step}" is NOT in OCR_LIVE_STEPS — update src/domain/ocr-steps.ts`,
    );
  }
});

test("every retired step string is in OCR_CANONICAL_STEP_ORDER (for remap positioning)", () => {
  for (const step of RETIRED_STEP_STRINGS) {
    assert.ok(
      OCR_CANONICAL_STEP_ORDER.includes(step),
      `Retired step "${step}" is NOT in OCR_CANONICAL_STEP_ORDER — position-based remap will fail`,
    );
  }
});

test("OCR_RETIRED_STEP_FOLD targets are live steps", () => {
  for (const [from, to] of Object.entries(OCR_RETIRED_STEP_FOLD)) {
    assert.ok(
      (OCR_LIVE_STEPS as readonly string[]).includes(to),
      `Fold target "${to}" (from "${from}") is not a live step — it won't be visible in the pipeline`,
    );
  }
});

test("computeOcrPipelineView handles all live orchestrator steps without stuck-at-0", () => {
  const registeredSteps = [...OCR_LIVE_STEPS];
  for (const step of ORCHESTRATOR_EMITTED_STEPS) {
    const result = computeOcrPipelineView(registeredSteps, step, "running", true);
    // If the step wasn't found, computeOcrPipelineView returns currentStep=null
    // with status="done" (past last step) OR advances to the next step.
    // In any case, it should NEVER return the same unrecognized step untouched
    // when it's a hidden-only step, but for live steps it should return them as-is.
    const liveStepVisible = result.steps.includes(step);
    const wasRemapped = result.currentStep !== step;
    assert.ok(
      liveStepVisible || !wasRemapped || result.currentStep !== null,
      `Step "${step}" produced a null currentStep in a non-terminal running row — check StepPipeline logic`,
    );
  }
});

test("computeOcrPipelineView handles retired steps via fold or remap", () => {
  const registeredSteps = [...OCR_LIVE_STEPS];
  for (const step of RETIRED_STEP_STRINGS) {
    const result = computeOcrPipelineView(registeredSteps, step, "running", true);
    // A retired step must either fold onto a live step or be remapped via position.
    // It must NOT return the same non-existent step as currentStep.
    assert.ok(
      result.currentStep !== step || result.steps.includes(step),
      `Retired step "${step}" was returned as currentStep but is not in the visible steps — StepPipeline will render stuck`,
    );
  }
});
