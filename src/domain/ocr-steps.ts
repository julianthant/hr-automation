/**
 * Canonical OCR step names — shared between the orchestrator and the
 * dashboard's StepPipeline fold/order tables.
 *
 * Adding a new orchestrator phase string WITHOUT updating this module (and
 * the StepPipeline tables that reference it) causes the dashboard to render
 * the row as "stuck at step 0" — the step guard test
 * (`tests/unit/dashboard/ocr-step-contract.test.ts`) catches this.
 *
 * LIVE step names (emitted today by `src/workflows/ocr/orchestrator.ts`):
 *   loading-roster → ocr → person-lookup → awaiting-approval
 *
 * RETIRED step names (legacy persisted rows / sub-phases):
 *   matching, disambiguating  — folded onto `ocr` in StepPipeline
 *   verification              — sat after person-lookup; remapped past it
 */

/** Steps the orchestrator actively emits today (order = pipeline order). */
export const OCR_LIVE_STEPS = [
  "loading-roster",
  "ocr",
  "person-lookup",
  "awaiting-approval",
] as const satisfies string[];

/**
 * Retired sub-phase names no longer emitted but potentially stored in
 * persisted rows. Each maps to the live step it folds onto for dashboard
 * display purposes.
 *
 * `verification` is deliberately absent: it sat AFTER `person-lookup` so it
 * is remapped via position in {@link OCR_CANONICAL_STEP_ORDER}, not a fold.
 */
export const OCR_RETIRED_STEP_FOLD: Readonly<Record<string, string>> = {
  matching: "ocr",
  disambiguating: "ocr",
};

/**
 * Full canonical ordering including retired steps, used ONLY to position a
 * parked legacy `currentStep` relative to visible live steps during remap.
 * Never rendered directly.
 */
export const OCR_CANONICAL_STEP_ORDER: readonly string[] = [
  "loading-roster",
  "ocr",
  "matching",
  "disambiguating",
  "person-lookup",
  "verification",
  "awaiting-approval",
];
