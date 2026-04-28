import { z } from "zod/v4";

// ─── OCR-pass record (one row of a paper roster) ──────────
//
// Paper oath rosters look like a table: each row is one signer, with
// columns for printed name, signature, and date. The OCR pass extracts
// each row as a record. We deliberately keep this schema permissive —
// EID is not on the form (the operator hasn't transcribed it; the
// roster match phase fills it from the SharePoint xlsx) and notes are
// for any uncertainty flags the LLM wants to surface.
//
// `signed` is the LLM's call on whether the signature column is filled
// (a scribble counts; an empty box doesn't). The match phase only
// attempts to resolve names whose `signed === true`.

export const OathRosterOcrRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative(),
  printedName: z.string().min(1),
  signed: z.boolean(),
  dateSigned: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  notes: z.array(z.string()).default([]),
});
export type OathRosterOcrRecord = z.infer<typeof OathRosterOcrRecordSchema>;

export const OathOcrOutputSchema = z.array(OathRosterOcrRecordSchema);
export type OathOcrOutput = z.infer<typeof OathOcrOutputSchema>;

// ─── Match state (mirrors emergency-contact's vocabulary) ─

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

// ─── Preview record (in-flight, post-match) ───────────────
//
// One per paper-roster row. `employeeId` is empty until match/lookup
// fills it. Approve fans out one `oath-signature` queue item per
// matched/resolved selected row.

export const OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({
  employeeId: z.string(),
  matchState: MatchStateSchema,
  matchSource: z.enum(["roster", "eid-lookup"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(
      z.object({
        eid: z.string(),
        name: z.string(),
        score: z.number(),
      }),
    )
    .optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
});
export type OathPreviewRecord = z.infer<typeof OathPreviewRecordSchema>;

// ─── Prepare row data (one parent tracker row per uploaded PDF) ─

export const OathPrepareRowDataSchema = z.object({
  mode: z.literal("prepare"),
  pdfPath: z.string(),
  pdfOriginalName: z.string(),
  rosterPath: z.string(),
  records: z.array(OathPreviewRecordSchema),
  ocrProvider: z.string().optional(),
  ocrAttempts: z.number().int().nonnegative().optional(),
  ocrCached: z.boolean().optional(),
});
export type OathPrepareRowData = z.infer<typeof OathPrepareRowDataSchema>;
