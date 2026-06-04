import { z } from "zod/v4";

/** Minimum LLM confidence to auto-accept a disambiguation result as `matched`. */
export const LLM_HIGH_CONFIDENCE = 0.6;

export const VerificationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("verified"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("inactive"),
    hrStatus: z.string(),
    department: z.string().optional(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("non-hdh"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("lookup-failed"),
    error: z.string(),
    checkedAt: z.string(),
  }),
]);

export type Verification = z.infer<typeof VerificationSchema>;

/**
 * `documentType` classifier from an OCR pass: `"expected"` = a real form page,
 * `"unknown"` = blank / garbage / non-form page.
 *
 * The vision prompt shows the model the page-format codes (signin / upay585 /
 * upay586 / unknown), so models routinely emit a format name (e.g. `"upay586"`)
 * here instead of the abstract `"expected"`. A strict `z.enum` would reject
 * that, and per-page `finalize()` drops the WHOLE record on any field failure —
 * so one classifier quibble silently discarded an otherwise-perfect row (name,
 * EID, signatures) and left the operator with 0 records to approve.
 *
 * The field only means "is this a real form page or junk", so coerce ANY
 * non-`"unknown"` value to `"expected"` rather than dropping the record. Only an
 * explicit (case-insensitive) `"unknown"` maps to `"unknown"`.
 */
export const DocumentTypeSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim().toLowerCase() === "unknown" ? "unknown" : "expected"),
  z.enum(["expected", "unknown"]),
);

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);

export type MatchState = z.infer<typeof MatchStateSchema>;
