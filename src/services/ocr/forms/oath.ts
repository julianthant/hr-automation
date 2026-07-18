/**
 * OCR form spec for paper oath rosters. Implements `OcrFormSpec` so OCR's
 * orchestrator can run this form-type generically.
 *
 * Replaces the schemas + match phase that lived in `preview-schema.ts` +
 * `prepare.ts` (both deleted in Task 25 of this plan).
 */
import { z } from "zod/v4";
import { matchAgainstRoster } from "../../matching/index.js";
import { log } from "../../../utils/log.js";
import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";
import { normalizePersonNameForCompare } from "../../../domain/identity/person-name.js";
import { resolveOcrPersonDisplayName } from "../../../domain/identity/ocr-person-name.js";
import type {
  OcrFormSpec,
  LookupKind,
} from "../../../workflows/ocr/types.js";
import type { OathSignerInput } from "../../../workflows/oath-signature/schema.js";
import type { OathUploadInput } from "../../../workflows/oath-upload/schema.js";
import {
  DocumentTypeSchema,
  MatchStateSchema,
  VerificationSchema,
  applyDisambiguationStd,
  assertCarryForwardKindCompatible,
  isForceResearchFlagRecord,
  ocrChildItemIdPrefix,
} from "./shared.js";

// ─── OCR-pass record (one row of a paper roster) ──────────

const OATH_FORM_KINDS = ["oath", "emergency-contact", "unknown"] as const;

/**
 * `formKind` tolerant coercion — mirrors `DocumentTypeSchema`'s precedent
 * (`./shared.ts`, 2026-06-04). `z.enum([...]).default("oath")` only covers a
 * MISSING (`undefined`) formKind: a PRESENT-but-unrecognized string (model
 * hallucination/typo) still FAILS `safeParse`, and per-page `finalize()` drops
 * the WHOLE record on any single-field failure — so a mis-labeled record
 * silently VANISHES from operator review instead of surfacing for a human to
 * catch (root CLAUDE.md "fail loud — no unverified silent fallbacks": losing
 * the record is worse than one wrong-looking label on it). Coerce any
 * unrecognized value to "oath" and `log.warn` it so it's still visible in the
 * run log; `undefined`/missing is the ordinary "model omitted the field" case
 * and does not warn.
 */
const OathFormKindSchema = z.preprocess((v) => {
  if (typeof v === "string" && (OATH_FORM_KINDS as readonly string[]).includes(v)) return v;
  if (v !== undefined) {
    log.warn(
      `[oath] unrecognized formKind ${JSON.stringify(v)} — coercing to "oath" so the record still surfaces for review`,
    );
  }
  return "oath";
}, z.enum(OATH_FORM_KINDS));

export const OathRosterOcrRecordSchema = z.object({
  formKind: OathFormKindSchema,
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative().optional(),
  // `nullable` because the prompt tells the model to NULL oath-specific fields
  // (printedName, employeeSigned, …) on non-oath pages (EC/unknown classified
  // inside an oath run). `.optional()` alone rejects an explicit `null`, which
  // would schema-drop a correctly-classified wrong-form page (per-page.ts then
  // flips it to success:false → data loss). Mirrors the 2026-06-04
  // documentType tolerant-coercion precedent. dateSigned/officerSigned are
  // already nullable below.
  printedName: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  employeeId: z.string().nullable().optional(),
  employeeSigned: z.boolean().nullable().optional(),
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
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
});
export type OathRosterOcrRecord = z.infer<typeof OathRosterOcrRecordSchema>;

export const OathOcrOutputSchema = z.array(OathRosterOcrRecordSchema);
export type OathOcrOutput = z.infer<typeof OathOcrOutputSchema>;

// ─── Preview record (in-flight, post-match) ────────────────

export const OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({
  employeeId: z.string(),
  matchState: MatchStateSchema,
  matchSource: z.enum(["roster", "eid-lookup", "llm", "form-eid", "manual"]).optional(),
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
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
});
export type OathPreviewRecord = z.infer<typeof OathPreviewRecordSchema>;

// ─── Prompt + match logic ───────────────────────────────────

const OATH_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF page.

The PDF is a stack of paper oath signature documents. BEFORE extracting fields, classify each page:
- "oath"              — UC loyalty oath / patent acknowledgment (signin sheet, UPAY585, or UPAY586)
- "emergency-contact" — UCSD R&R Emergency Contact Information form
- "unknown"           — blank, irrelevant, or does not match any of the above

OUTPUT SHAPE (CRITICAL — must be a FLAT JSON ARRAY at the top level):

\`\`\`json
[
  { "formKind": "oath", "rowIndex": 0, "printedName": "Doe, Jane, A", "employeeId": "10000001", "dateSigned": "4-23-26", "employeeSigned": true, "officerSigned": true, "documentType": "expected", "originallyMissing": [] }
]
\`\`\`

Do NOT wrap records in a page object. Do NOT nest under "records" or "data" keys. The top-level value MUST be a JSON array. Each element is exactly one record. Multi-row sign-in sheets emit multiple array elements; single-form pages (UPAY585/UPAY586) emit exactly one element.

For each record extract these fields:
- formKind: classify the page — "oath", "emergency-contact", or "unknown". Set "emergency-contact" if the page is a UCSD R&R Emergency Contact Information form. Set "unknown" for a blank or irrelevant page. Oath pages (signin, UPAY585, UPAY586) get "oath". Leave oath-specific fields (printedName, dateSigned, employeeSigned, officerSigned) null for non-oath pages.
- rowIndex: 0-indexed position on the page, starting from 0 for the first record
- printedName: the printed/handwritten name on the form. ALWAYS attempt a best-guess transcription — speak the name out loud as you read it. Only set null if the field is genuinely BLANK (no writing at all). Faint or hard-to-read writing should still be transcribed.
- employeeId: the full Employee ID number. UCPath IDs are exactly 8 digits starting with "10" (e.g. "10874100"). Scan the ENTIRE page for this number before returning null, including the top page margin, the white space above the form header, and handwritten notes outside the printed Employee ID box. Standalone handwritten 8-digit numbers above the form header are usually the correct employeeId, especially on UPAY585 scans where the printed Employee ID box is faint, clipped, or partially filled. Copy ALL digits exactly as printed — do NOT drop the leading "10". Return null ONLY when the whole page has no readable Employee ID anywhere. If you can read any digits, return them all.
- dateSigned: the date signed (typical formats: MM/DD/YYYY, M/D/YY, M-D-YY). Null if blank or if formKind is not "oath".
- employeeSigned: true if the employee signature line has any writing/scribble. False for an empty box. For sign-in sheets with one signature column, set true if the row's signature box is filled. Null if formKind is not "oath".
- officerSigned: true if the authorized-officer / witness signature is filled. Null for sign-in sheets with one signature column. False for UPAY585/UPAY586 when empty. Null if formKind is not "oath".
- documentType: emit the LITERAL string "expected" for any real form (oath or emergency-contact), or the LITERAL string "unknown" for a blank, garbage, or non-form page. Do NOT put the format name (e.g. "upay586") here — only "expected" or "unknown".
- originallyMissing: array of field names that were genuinely BLANK on the paper (not just hard to read). Use [] when nothing was missing.

Output ONLY the valid JSON array. No commentary, no markdown fences, no wrapper object.`;

const NAME_AUTO_ACCEPT_GAP = 0.10;
const NAME_DISAMBIG_FLOOR = 0.40;
const OCR_NAME_CONFIDENCE_DISAMBIG_SKIP = 0.85;

// ─── Spec implementation ────────────────────────────────────

export const oathOcrFormSpec: OcrFormSpec<
  OathRosterOcrRecord,
  OathPreviewRecord,
  OathSignerInput,
  OathUploadInput
> = {
  formType: "oath",
  label: "Oath signature",
  description: "Paper oath rosters / UPAY585 / UPAY586. Approves into the oath-signature daemon.",

  prompt: OATH_OCR_PROMPT,
  ocrRecordSchema: OathRosterOcrRecordSchema,
  ocrArraySchema: OathOcrOutputSchema,
  schemaName: "oath-roster-batch",

  async matchRecord({ record, roster }): Promise<OathPreviewRecord> {
    const printedName = (record.printedName ?? "").trim();
    const formEidRaw = (record.employeeId ?? "").trim();
    const ocrConfidence = typeof record.confidence === "number" ? record.confidence : undefined;
    const confidenceText = ocrConfidence === undefined ? "" : ` confidence=${ocrConfidence.toFixed(2)}`;
    log.step(`[oath/match] page ${record.sourcePage} row ${record.rowIndex ?? "?"}: name="${printedName || "(empty)"}" eid="${formEidRaw || "(empty)"}" signed=${record.employeeSigned} doc=${record.documentType ?? "expected"}${confidenceText}`);

    // Empty printedName + no form-EID means the LLM gave us nothing usable.
    // Surface as a manual record so the operator sees it in the preview pane
    // (with the page image visible) and can type from the source.
    if (!printedName && !formEidRaw) {
      log.step(`[oath/match] → manual: LLM returned no name + no EID; operator must fill from page image`);
      return {
        ...record,
        printedName: "",
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        documentType: record.documentType ?? "expected",
        originallyMissing: ["printedName"],
        selected: false,
        warnings: ["LLM extracted no name from this page — type from the page image on the left"],
      };
    }

    if (!record.employeeSigned) {
      log.step(`[oath/match] → extracted (deselected): row not signed, kept for visibility but not approvable`);
      return {
        ...record,
        employeeId: normalizeUcpathEmployeeId(record.employeeId),
        matchState: "extracted",
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: false,
        warnings: [],
      };
    }

    // Form-EID short-circuit: when the LLM extracted an EID from the page
    // (UPAY585/586 has an "Employee ID" field), trust the structured value
    // over the handwritten name. Roster-exact match → auto-accept; no roster
    // match → flag for eid-lookup-by-EID (verify-only branch).
    const formEid = normalizeUcpathEmployeeId(formEidRaw);
    if (formEidRaw.length > 0 && formEid.length === 0) {
      log.step(`[oath/match] page ${record.sourcePage} row ${record.rowIndex ?? "?"}: extracted EID "${formEidRaw}" is not a valid UCPath EID (expected 8 digits starting with "10") — falling back to name-based lookup`);
    }
    if (formEid.length > 0) {
      const rosterHit = roster.find((row) => row.eid === formEid);
      if (rosterHit) {
        log.step(`[oath/match] → form-eid matched: EID ${formEid} found on roster as "${rosterHit.name}"`);
        return {
          ...record,
          employeeId: formEid,
          matchState: "matched",
          matchSource: "form-eid",
          documentType: record.documentType ?? "expected",
          originallyMissing: [],
          selected: true,
          warnings: [],
        };
      }
      log.step(`[oath/match] → form-eid pending verify: EID ${formEid} not on roster, will eid-lookup-by-EID`);
      return {
        ...record,
        employeeId: formEid,
        matchState: "lookup-pending",
        matchSource: "form-eid",
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: true,
        warnings: [`EID ${formEid} extracted from form but not in roster — verifying`],
      };
    }

    // Name-resolution chain:
    //   - Exactly one fuzzy roster candidate → take it, then active-check
    //     verifies the EID before approval.
    //   - Multiple fuzzy roster candidates → mark lookup-pending;
    //     orchestrator's disambiguating phase runs the LLM and
    //     applyDisambiguation patches the record.
    //   - Top score < NAME_DISAMBIG_FLOOR (0.40) / no candidates → manual
    //     fall-through (matchSource: "manual"); eid-lookup-by-name still runs
    //     as a backstop downstream
    const ranked = matchAgainstRoster(roster, record.printedName ?? "");
    const top = ranked.candidates[0];
    const second = ranked.candidates[1];
    const topCandidates = ranked.candidates.slice(0, 5);
    log.step(`[oath/match] roster scan: ${ranked.candidates.length} candidates above threshold; top="${top?.name ?? "(none)"}" score=${top?.score.toFixed(2) ?? "—"}; second="${second?.name ?? "(none)"}" score=${second?.score.toFixed(2) ?? "—"}`);

    if (!top || top.score < NAME_DISAMBIG_FLOOR) {
      log.step(`[oath/match] → manual: best score ${top?.score.toFixed(2) ?? "0"} < ${NAME_DISAMBIG_FLOOR} disambig floor`);
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        rosterCandidates: topCandidates,
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          ranked.candidates.length > 0
            ? [`Best roster score ${top.score.toFixed(2)} < ${NAME_DISAMBIG_FLOOR} — manual review`]
            : ["No roster match — manual review"],
      };
    }

    if (ranked.candidates.length === 1 && top.eid) {
      log.step(`[oath/match] → roster single-candidate accept: "${top.name}" eid=${top.eid} score=${top.score.toFixed(2)}`);
      return {
        ...record,
        employeeId: top.eid,
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: topCandidates,
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: true,
        warnings: top.score < 1.0
          ? [`Single roster candidate "${top.name}" accepted (score ${top.score.toFixed(2)}); active-check will verify`]
          : [],
      };
    }

    if (ocrConfidence !== undefined && ocrConfidence >= OCR_NAME_CONFIDENCE_DISAMBIG_SKIP) {
      log.step(`[oath/match] → lookup-pending (skip LLM disambiguation): OCR name confidence ${ocrConfidence.toFixed(2)} >= ${OCR_NAME_CONFIDENCE_DISAMBIG_SKIP}`);
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        matchConfidence: ocrConfidence,
        rosterCandidates: topCandidates,
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: true,
        warnings: [
          `High OCR name confidence (${ocrConfidence.toFixed(2)}) — skipping LLM disambiguation; eid-lookup will search by name`,
        ],
      };
    }

    // Ambiguous: defer to the orchestrator's disambiguating phase.
    const closeSecond = second && top.score - second.score < NAME_AUTO_ACCEPT_GAP;
    const reason = closeSecond
      ? `top ${top.score.toFixed(2)} too close to second ${second.score.toFixed(2)} (gap < ${NAME_AUTO_ACCEPT_GAP})`
      : `${ranked.candidates.length} fuzzy candidates require LLM selection`;
    log.step(`[oath/match] → lookup-pending (will disambiguate via LLM): ${reason}`);
    return {
      ...record,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: topCandidates,
      documentType: record.documentType ?? "expected",
      originallyMissing: [],
      selected: true,
      warnings: closeSecond
        ? [`Top score ${top.score.toFixed(2)} but close second ${second.score.toFixed(2)} — disambiguating`]
        : [`Top score ${top.score.toFixed(2)} in disambiguation band — disambiguating`],
    };
  },

  applyDisambiguation({ record, result }): OathPreviewRecord {
    // Shared 3-branch outcome (forms/shared.ts); oath writes the flat
    // `employeeId` and routes the no-candidate branch to manual review.
    return applyDisambiguationStd({
      record,
      result,
      writeEid: (r, eid) => ({ ...r, employeeId: eid }),
      noMatch: {
        matchSource: "manual",
        warning: "LLM disambiguation: no candidate matched — manual review",
      },
    });
  },

  needsLookup(record): LookupKind {
    if (record.matchState === "extracted") return null;
    if (record.matchState === "lookup-pending") {
      // form-eid lookup-pending → we know the EID, just need to verify it
      if (record.matchSource === "form-eid") return "verify-only";
      // manual + we have a printed name → still worth trying eid-lookup-by-name
      // (UCPath knows about more people than the local roster). Only skip
      // when there's literally nothing to look up.
      if (record.matchSource === "manual") {
        const name = (record.printedName ?? "").trim();
        return name.length > 0 ? "name" : null;
      }
      return "name";
    }
    if (record.matchState === "matched" && normalizeUcpathEmployeeId(record.employeeId)) {
      if (record.verification) return null;
      // Roster-backed match — EID + name came from the onboarding roster.
      if (record.matchSource === "form-eid" || record.matchSource === "roster") return null;
      return "verify";
    }
    if (record.matchState === "resolved") return null;
    if (record.matchState === "unresolved") return null;
    return null;
  },

  carryForwardKey(record): string {
    return normalizePersonNameForCompare(record.printedName ?? "");
  },

  applyCarryForward({ v2, v1 }): OathPreviewRecord {
    // Defensive: TS already enforces both inputs are OathPreviewRecord via
    // the OcrFormSpec generic, but `applyCarryForward` in carry-forward.ts
    // uses `as never` casts that erase the discriminant, AND v1 records
    // come from a JSON.parse of a previous run's JSONL (`readPreviousRecords`
    // in orchestrator.ts) which bypasses Zod's defaults — so a legacy row
    // may have `formKind: undefined`. Only reject merging two DIFFERENT known
    // kinds (mirrors `verify.applyCarryForward`). Tolerate undefined (legacy)
    // and tolerate "emergency-contact"/"unknown" (a re-run that re-classified
    // the same page) by carrying the v2 formKind forward.
    assertCarryForwardKindCompatible("oath", v1.formKind, v2.formKind);
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

  isForceResearchFlag: isForceResearchFlagRecord,

  // ─── Approve fan-out: per-record → oath-signature signer rows ─────────
  // Each approved record (a signed row with a valid 5+-digit EID) becomes one
  // EID signer row on the oath-signature daemon (UCPath transaction + Duo).
  // Records without a valid signer input are skipped (no enqueue) — the approve
  // route keeps the per-record itemIds in sync with what was actually enqueued.
  approveTo: {
    workflow: "oath-signature",
    deriveInput(record): OathSignerInput {
      const built = buildOathSignerInputFromApprovedRecord(record);
      if (!built) {
        // Should never happen — the approve route only calls deriveInput for
        // records that pass `hasOathSignerInput`. Fail loud.
        throw new Error(
          "oath.approveTo.deriveInput: record has no valid signer input (selected + 5+-digit EID required)",
        );
      }
      return built;
    },
    deriveItemId(_record, parentRunId, index): string {
      return `${ocrChildItemIdPrefix("oath")}-${parentRunId}-r${index}`;
    },
    canFanOut(record): boolean {
      // Skip records EXPLICITLY classified as non-oath pages (EC or unknown) —
      // they have no oath-shape signer data and must not be fanned out as oath
      // signers. A record with no formKind (legacy/partial row) defaults to oath
      // (mirrors applyCarryForward's legacy tolerance), so it still fans out.
      const kind = record.formKind as string | undefined;
      if (kind === "emergency-contact" || kind === "unknown") return false;
      // Inactive employees are hard-blocked in the review pane — mirror here so
      // a stale selected flag cannot enqueue a signer transaction.
      if (record.verification?.state === "inactive") return false;
      return hasOathSignerInput(record);
    },
  },

  // ─── Approve fan-out: once-per-document → oath-upload ticket row ──────
  // One ServiceNow HR-ticket row per approved PDF, running on the oath-upload
  // daemon. It waits for every signer row above (`signerItemIds`) to finish and
  // succeed BEFORE filing the ticket. This wait is cross-daemon (oath-upload
  // waits on oath-signature rows), so nothing waits on its own daemon's
  // children — fixing the prior single-worker deadlock.
  approveDocumentTo: {
    workflow: "oath-upload",
    deriveInput(doc): OathUploadInput {
      // pdfPath/pdfHash are resolved by oath-upload's handler from `pdfFileId`
      // (the OCR review data carries the file id, not always the on-disk path).
      return {
        pdfFileId: doc.pdfFileId,
        pdfOriginalName: doc.pdfOriginalName ?? doc.sessionId,
        sessionId: doc.sessionId,
        ...(doc.pdfPath ? { pdfPath: doc.pdfPath } : {}),
        ...(doc.pdfHash ? { pdfHash: doc.pdfHash } : {}),
        signerItemIds: doc.perRecordItemIds,
        mode: "full",
        ...(doc.dryRun ? { dryRun: true } : {}),
      };
    },
    deriveItemId(doc): string {
      return `ocr-oath-upload-${doc.runId}`;
    },
  },

  rosterMode: "required",

  // No `traceCode` (E2E-007): a STANDALONE oath upload to the OCR panel brands
  // the OCR default `oc-…`. Operation runs are branded by their intent
  // (`operationTraceCode`: oath-signature → os, oath-upload → ou) — the old
  // spec-level `"ou"` made a standalone OCR oath prep indistinguishable from a
  // real oath-upload ticket when grepping `ou-…`.
};

/**
 * Whether an approved OCR record can be turned into a valid oath-signature
 * signer input (selected + a 5+-digit employee id). The approve route uses
 * this to keep the per-record fan-out itemIds in sync with what is actually
 * enqueued, so oath-upload waits on exactly the rows that were created.
 */
export function hasOathSignerInput(rec: unknown): boolean {
  return buildOathSignerInputFromApprovedRecord(rec) !== null;
}

/**
 * Read an approved OCR record's printed name / employeeId / dateSigned and
 * build the `oath-signature` signer input. Returns null when the record is
 * not selected or has no valid 5+-digit employee id. Resolves the name via the
 * OCR person-name helper and the date via `normalizeOathDate`.
 *
 * Moved here from `oath-signature/workflow.ts` (the old PDF branch's
 * `readApprovedSignerInputs`) — it's now only used by the OCR approve fan-out.
 */
export function buildOathSignerInputFromApprovedRecord(
  rec: unknown,
  opts: { parentSubject?: string; dryRun?: boolean } = {},
): OathSignerInput | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  if (r.selected !== true) return null;
  const emplId = typeof r.employeeId === "string" ? r.employeeId : "";
  if (!/^\d{5,}$/.test(emplId)) return null;
  const displayName = resolveOcrPersonDisplayName({
    firstName: typeof r.firstName === "string" ? r.firstName : undefined,
    lastName: typeof r.lastName === "string" ? r.lastName : undefined,
    fullName: typeof r.printedName === "string" ? r.printedName : undefined,
  });
  const dateSigned = typeof r.dateSigned === "string" ? r.dateSigned : null;
  const normalizedDate = normalizeOathDate(dateSigned);
  return {
    emplId,
    ...(displayName ? { name: displayName } : {}),
    ...(normalizedDate ? { date: normalizedDate } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.parentSubject ? { parentSubject: opts.parentSubject } : {}),
  };
}

/**
 * Coerce an LLM-extracted handwritten date into the MM/DD/YYYY shape that
 * `OathSignatureInputSchema` requires (and that PeopleSoft's date textbox
 * accepts). Tolerates `/` and `-` separators, 1- or 2-digit month/day, and
 * 2- or 4-digit years (2-digit years assumed 2000–2099). Returns `null` for
 * inputs that don't parse — the caller drops the field and the workflow
 * falls back to UCPath's today-prefill on the form.
 *
 * Examples:
 *   "4-23-26"      → "04/23/2026"
 *   "4/23/2026"    → "04/23/2026"
 *   "04/23/2026"   → "04/23/2026"
 *   "12-9-25"      → "12/09/2025"
 *   ""             → null
 *   "next tuesday" → null
 */
export function normalizeOathDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!m) return null;
  const month = Number.parseInt(m[1], 10);
  const day = Number.parseInt(m[2], 10);
  const yearRaw = Number.parseInt(m[3], 10);
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  const year = m[3].length === 2 ? 2000 + yearRaw : yearRaw;
  if (year < 1900 || year > 2999) return null;
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}
