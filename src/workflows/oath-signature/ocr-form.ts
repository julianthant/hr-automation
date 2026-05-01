/**
 * OCR form spec for paper oath rosters. Implements `OcrFormSpec` so OCR's
 * orchestrator can run this form-type generically.
 *
 * Replaces the schemas + match phase that lived in `preview-schema.ts` +
 * `prepare.ts` (both deleted in Task 25 of this plan).
 */
import { z } from "zod/v4";
import { matchAgainstRoster } from "../../match/index.js";
import type { OcrFormSpec, RosterRow, LookupKind } from "../ocr/types.js";
import type { OathSignatureInput } from "./schema.js";

// ─── Verification schema ────────────────────────────────────

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

// ─── OCR-pass record (one row of a paper roster) ──────────

export const OathRosterOcrRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative(),
  printedName: z.string().min(1),
  employeeSigned: z.boolean(),
  officerSigned: z.boolean().nullable().optional(),
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
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
});
export type OathRosterOcrRecord = z.infer<typeof OathRosterOcrRecordSchema>;

export const OathOcrOutputSchema = z.array(OathRosterOcrRecordSchema);
export type OathOcrOutput = z.infer<typeof OathOcrOutputSchema>;

// ─── Match state ─────────────────────────────────────────────

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

// ─── Preview record (in-flight, post-match) ────────────────

export const OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({
  employeeId: z.string(),
  matchState: MatchStateSchema,
  matchSource: z.enum(["roster", "eid-lookup", "llm"]).optional(),
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
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
});
export type OathPreviewRecord = z.infer<typeof OathPreviewRecordSchema>;

// ─── Prompt + match logic ───────────────────────────────────

const OATH_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of paper oath signature documents in one of three formats — each page is one of:
- "signin"  — multi-row sign-in sheet (many records per page)
- "upay585" — single-form per page, UPAY585 (1997, includes Patent Acknowledgment)
- "upay586" — single-form per page, UPAY586 (2015 DocuSign, oath only)
- "unknown" — blank, irrelevant, or doesn't match any of the above

For each page you process:
1. Classify document type. Map "signin"/"upay585"/"upay586" to documentType: "expected"; "unknown" → documentType: "unknown".
2. For each record extract: printedName (always); employeeId if visible; dateSigned if visible; employeeSigned: whether the employee/officer signature line is filled (a scribble counts; an empty box doesn't); officerSigned: whether the authorized-official / witness signature is filled. For sign-in sheets that only have a single signature column, set officerSigned to null. For UPAY585/UPAY586, false when the column is empty.
3. After extraction, list which expected fields were BLANK or ILLEGIBLE on the paper in originallyMissing on each record.

Field-level rules:
- One record per signer. Multi-row sign-in sheets emit multiple records per page; single-form pages emit one.
- For handwritten text, use your best transcription. If a field is illegible, set it to null and add it to originallyMissing.
- dateSigned should be transcribed as it appears on the paper (typical formats: MM/DD/YYYY or M/D/YY).
- Output ONLY valid JSON matching the schema. No commentary.`;

const ROSTER_AUTO_ACCEPT = 0.85;

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Spec implementation ────────────────────────────────────

export const oathOcrFormSpec: OcrFormSpec<
  OathRosterOcrRecord,
  OathPreviewRecord,
  OathSignatureInput
> = {
  formType: "oath",
  label: "Oath signature",
  description: "Paper oath rosters / UPAY585 / UPAY586. Approves into the oath-signature daemon.",

  prompt: OATH_OCR_PROMPT,
  ocrRecordSchema: OathRosterOcrRecordSchema,
  ocrArraySchema: OathOcrOutputSchema,
  schemaName: "oath-roster-batch",

  matchRecord({ record, roster }): OathPreviewRecord {
    if (!record.employeeSigned) {
      return {
        ...record,
        employeeId: "",
        matchState: "extracted",
        documentType: "expected",
        originallyMissing: [],
        selected: false,
        warnings: [],
      };
    }
    const result = matchAgainstRoster(roster, record.printedName);
    if (result.bestScore >= ROSTER_AUTO_ACCEPT) {
      const top = result.candidates[0];
      return {
        ...record,
        employeeId: top.eid,
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: result.candidates.slice(0, 3),
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          top.score < 1.0
            ? [`Roster fuzzy-matched "${top.name}" (score ${top.score.toFixed(2)})`]
            : [],
      };
    }
    return {
      ...record,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: result.candidates.slice(0, 3),
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings:
        result.candidates.length > 0
          ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
          : ["No roster match — falling back to eid-lookup"],
    };
  },

  needsLookup(record): LookupKind {
    if (record.matchState === "extracted") return null;
    if (record.matchState === "lookup-pending") return "name";
    if (record.matchState === "matched" && record.employeeId) {
      if (record.verification) return null;
      return "verify";
    }
    if (record.matchState === "resolved") return null;
    if (record.matchState === "unresolved") return null;
    return null;
  },

  carryForwardKey(record): string {
    return normalizeName(record.printedName);
  },

  applyCarryForward({ v2, v1 }): OathPreviewRecord {
    return {
      ...v2,
      employeeId: v1.employeeId || v2.employeeId,
      matchState: v1.matchState !== "lookup-pending" && v1.matchState !== "lookup-running"
        ? v1.matchState
        : v2.matchState,
      matchSource: v1.matchSource ?? v2.matchSource,
      matchConfidence: v1.matchConfidence ?? v2.matchConfidence,
      verification: v1.verification ?? v2.verification,
      selected: v1.selected,
    };
  },

  isForceResearchFlag(record): boolean {
    return record.forceResearch === true;
  },

  approveTo: {
    workflow: "oath-signature",
    deriveInput(record): OathSignatureInput {
      return {
        emplId: record.employeeId,
        ...(record.dateSigned ? { date: record.dateSigned } : {}),
      };
    },
    deriveItemId(_record, parentRunId, index): string {
      return `ocr-oath-${parentRunId}-r${index}`;
    },
  },

  recordRendererId: "OathRecordView",
  rosterMode: "required",
};
