/**
 * OCR form spec for MIXED oath + emergency-contact PDFs. Implements
 * `OcrFormSpec` so OCR's orchestrator runs this form-type generically.
 *
 * Unlike oath / emergency-contact, `verify` is a READ-AND-FIND-OUT tool: it
 * reads each scanned form, then enriches each record by looking up what's
 * MISSING (CRM employment + oath dates, UCPath active status, I-9 authorized
 * official signer) and renders a per-record completeness report in the OCR
 * preview. It does NOT write to UCPath and has NO approve fan-out.
 *
 * Enrichment is owned by this spec's `enrichRecords` hook (the orchestrator's
 * eid-lookup fan-out is suppressed by `needsLookup` always returning null).
 * `enrichRecords` mirrors `force-research.ts`: build inputs → delegateToAllImpl
 * → watchChildRuns → patch records from outcomes (twice — once for
 * person-lookup, once for i9-lookup).
 */
import { z } from "zod/v4";
import { log } from "../../../utils/log.js";
import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";
import { normalizePersonNameForCompare } from "../../../domain/identity/person-name.js";
import { runOptionsToDaemonFlags } from "../../../domain/run-options.js";
import { buildTraceId } from "../../../domain/queue-trace-id.js";
import { parsePersonOrgNameInput } from "../../../systems/ucpath/person-org-summary.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../eid-lookup-results.js";
import { applyPersonLookupNameToOcrRecord } from "../../../domain/identity/ocr-person-name.js";
import { isChildWatchError, type ChildOutcome } from "../../../tracker/delegation/watch-child-runs.js";
import {
  isOcrPrepareAbortRequested,
  isOperatorDiscardAbortError,
} from "../../../tracker/ocr-prepare-abort.js";
import { fanOutAndWatch, type FanOutResult } from "../fan-out.js";
import type { OcrFormSpec, LookupKind } from "../../../workflows/ocr/types.js";
import {
  DocumentTypeSchema,
  MatchStateSchema,
  VerificationSchema,
  assertCarryForwardKindCompatible,
  isForceResearchFlagRecord,
  ocrChildItemIdPrefix,
} from "./shared.js";

// ─── OCR-pass record (one page / record of a mixed PDF) ─────

const VERIFY_FORM_KINDS = ["oath", "emergency-contact", "unknown"] as const;

/**
 * `formKind` tolerant coercion — mirrors `DocumentTypeSchema`'s precedent
 * (`./shared.ts`, 2026-06-04). `z.enum([...]).default("unknown")` only covers
 * a MISSING (`undefined`) formKind: a PRESENT-but-unrecognized string (model
 * hallucination/typo) still FAILS `safeParse`, and per-page `finalize()` drops
 * the WHOLE record on any single-field failure — so a mis-labeled record
 * silently VANISHES from operator review instead of surfacing for a human to
 * catch (root CLAUDE.md "fail loud — no unverified silent fallbacks": losing
 * the record is worse than one wrong-looking label on it). Coerce any
 * unrecognized value to "unknown" and `log.warn` it so it's still visible in
 * the run log; `undefined`/missing is the ordinary "model omitted the field"
 * case and does not warn.
 */
const VerifyFormKindSchema = z.preprocess((v) => {
  if (typeof v === "string" && (VERIFY_FORM_KINDS as readonly string[]).includes(v)) return v;
  if (v !== undefined) {
    log.warn(
      `[verify] unrecognized formKind ${JSON.stringify(v)} — coercing to "unknown" so the record still surfaces for review`,
    );
  }
  return "unknown";
}, z.enum(VERIFY_FORM_KINDS));

export const VerifyOcrRecordSchema = z.object({
  formKind: VerifyFormKindSchema,
  sourcePage: z.number().int().positive(),
  /** Employee name (both forms). */
  printedName: z.string().nullable().optional(),
  /** EID if printed on the form. */
  employeeId: z.string().nullable().optional(),
  /** oath: employment date if printed. */
  paperEmploymentDate: z.string().nullable().optional(),
  /** oath: "taken & subscribed before me" date. */
  paperDateSigned: z.string().nullable().optional(),
  /** oath: employee signature present. */
  employeeSigned: z.boolean().nullable().optional(),
  /** oath: authorized-official signature present. */
  officerSigned: z.boolean().nullable().optional(),
  /** oath: authorized-official name if printed. */
  paperOfficialName: z.string().nullable().optional(),
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type VerifyOcrRecord = z.infer<typeof VerifyOcrRecordSchema>;

export const VerifyOcrOutputSchema = z.array(VerifyOcrRecordSchema);
export type VerifyOcrOutput = z.infer<typeof VerifyOcrOutputSchema>;

// ─── Completeness check (one row of the preview report) ─────

export const VerifyCheckSchema = z.object({
  /** "name" | "eid" | "employmentDate" | "oathDate" | "officialSigner" | "activeStatus" */
  key: z.string(),
  label: z.string(),
  /** Present on the scanned form. */
  onPaper: z.boolean(),
  paperValue: z.string().nullable(),
  /** Looked-up value (CRM / UCPath / i9). */
  foundValue: z.string().nullable(),
  source: z.enum(["paper", "crm", "ucpath", "i9", "roster"]).nullable(),
  /** present=on paper; found=blank but looked up; missing=blank+not found. */
  status: z.enum(["present", "found", "missing"]),
  /**
   * Set on a `missing` lookup-backed check when the lookup couldn't ACCESS the
   * record (vs. genuinely not finding it) — currently the I-9 signer when the
   * operator's account lacks permission. The UI renders "Unable to access"
   * instead of "— not found". The retry stays available.
   */
  unavailable: z.boolean().optional(),
  /**
   * Literal text to show for a `missing` check instead of the default
   * "— not found" — for blank states that carry a DIFFERENT meaning than a
   * failed lookup (mirrors the client `VerifyCheck.missingLabel`, which the
   * read-only oath/EC projection already uses for paper booleans). The i9
   * form uses it so "the search hasn't run / errored" is never displayed as
   * a definitive "not found".
   */
  missingLabel: z.string().optional(),
});
export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

// ─── Preview record (in-flight, post-match + post-enrichment) ──

export const VerifyPreviewRecordSchema = VerifyOcrRecordSchema.extend({
  /** Resolved name (falls back to printedName). */
  name: z.string().default(""),
  /** EID as read directly from the paper before person-lookup may overwrite employeeId. */
  paperEmployeeId: z.string().optional(),
  /** Resolved EID. */
  employeeId: z.string().default(""),
  /** person-lookup activeStatus. */
  activeStatus: z.string().optional(),
  /** State of the person-lookup child that enriched this record. */
  personLookupStatus: z.enum(["pending", "running", "completed", "failed"]).optional(),
  /** Trace id of the person-lookup child that enriched this record. */
  personLookupTraceId: z.string().optional(),
  /** State of the i9-lookup child that enriched the official signer. */
  i9LookupStatus: z.enum(["pending", "running", "completed", "failed"]).optional(),
  /** Trace id of the i9-lookup child that enriched the official signer. */
  i9LookupTraceId: z.string().optional(),
  /** CRM First Day of Service. */
  employmentDate: z.string().optional(),
  /** CRM Date Signed. */
  oathDate: z.string().optional(),
  /** i9 Section 2 signer. */
  officialSigner: z.string().optional(),
  /**
   * i9-lookup outcome status (`signed` | `unsigned` | `historical` |
   * `not-found` | `unable-to-access` | `error`). Drives the "Unable to
   * access" rendering when the signer is blank because the operator's account
   * can't view the I-9 record.
   */
  officialSignerStatus: z.string().optional(),
  matchState: MatchStateSchema,
  selected: z.boolean(),
  warnings: z.array(z.string()),
  verification: VerificationSchema.optional(),
  forceResearch: z.boolean().optional(),
  checks: z.array(VerifyCheckSchema).default([]),
});
export type VerifyPreviewRecord = z.infer<typeof VerifyPreviewRecordSchema>;

// ─── Prompt ─────────────────────────────────────────────────

const VERIFY_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a MIXED stack of scanned forms — each page is either:
- "oath" — a UC loyalty oath / patent acknowledgment form (UPAY585, UPAY586, or a multi-row oath sign-in sheet).
- "emergency-contact" — a UCSD Recruitment & Retention (R&R) Emergency Contact Information form.
- "unknown" — blank, irrelevant, or not one of the above.

For each page produce exactly one record (multi-row oath sign-in sheets still emit ONE element per row).

OUTPUT SHAPE (CRITICAL — must be a FLAT JSON ARRAY at the top level):

\`\`\`json
[
  { "formKind": "oath", "sourcePage": 1, "printedName": "Doe, Jane A", "employeeId": "10000001", "paperEmploymentDate": "4-1-26", "paperDateSigned": "4-23-26", "employeeSigned": true, "officerSigned": true, "paperOfficialName": "Smith, John", "documentType": "expected", "originallyMissing": [], "notes": [] },
  { "formKind": "emergency-contact", "sourcePage": 2, "printedName": "Roe, Sam", "employeeId": null, "documentType": "expected", "originallyMissing": ["employeeId"], "notes": [] }
]
\`\`\`

Do NOT wrap records in a page object. Do NOT nest under "records" or "data" keys. The top-level value MUST be a JSON array. Each element is exactly one record.

For EVERY record:
- formKind: classify the page as "oath" (UC loyalty oath / UPAY585 / UPAY586 / oath sign-in sheet) vs "emergency-contact" (UCSD R&R Emergency Contact form) vs "unknown".
- sourcePage: the 1-indexed page number.
- printedName: the printed/handwritten employee name. ALWAYS attempt a best-guess transcription — speak the name out loud as you read it. Only set null if the field is genuinely BLANK.
- employeeId: the full Employee ID if printed on the form. UCPath IDs are 8 digits starting with "10" (e.g. "10874100"). Copy ALL digits exactly; do NOT drop the leading "10". Return null when no readable Employee ID is on the page.
- documentType: "expected" for an oath or emergency-contact form; "unknown" for blank, garbage, or non-form pages.
- originallyMissing: array of expected field names that were genuinely BLANK on the paper. Use [] when nothing was missing.
- notes: free-form observations, or [].

For oath records ALSO capture. IMPORTANT — the UC State Oath of Allegiance has
TWO DISTINCT signature lines near the bottom; do NOT confuse them:
  • "Signature of Officer or Employee" — signed by the person TAKING the oath
    (the employee themself).
  • "Signature of Authorized Official" — signed by the witness / authorized
    official who administers the oath (usually a SEPARATE person, and this line
    is often left BLANK on filed forms).
- paperEmploymentDate: the employment / first-day-of-service date if printed on the form. Null if blank.
- paperDateSigned: the "taken and subscribed before me" date (the oath signing date). Null if blank.
- employeeSigned: true if the "Signature of Officer or Employee" line has any writing/scribble; false for an empty box. This is the EMPLOYEE's own signature.
- officerSigned: true if the "Signature of Authorized Official" line is filled; false when empty. Null if the form has no such line. This is the AUTHORIZED OFFICIAL's signature — NOT the employee's.
- paperOfficialName: the printed/handwritten name on the "Signature of Authorized Official" line ONLY. Null if that line is blank. NEVER copy the value from the "Signature of Officer or Employee" line here — that is the employee, not the authorized official.

For emergency-contact records, only printedName + employeeId are needed (plus the universal fields).

Output ONLY the valid JSON array. No commentary, no markdown fences, no wrapper object.`;

// ─── Pure helpers (exported, unit-tested) ───────────────────

/** Trim a value to a non-empty string, or null. */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Build the completeness checklist from a record's paper + enriched values.
 *
 * Field sets:
 *   - oath: name, eid, employmentDate, oathDate, officialSigner, activeStatus
 *   - emergency-contact: name, eid, activeStatus
 *
 * For each field, `onPaper`/`paperValue` come from the scanned form and
 * `foundValue`/`source` come from the enriched lookup result. `status` is
 * "present" when the value is on paper, "found" when blank-but-looked-up, or
 * "missing" when blank and not found. `activeStatus` is never on paper.
 */
export function buildVerifyChecks(rec: VerifyPreviewRecord): VerifyCheck[] {
  const paperName = nonEmpty(rec.printedName);
  const paperEid = paperEmployeeIdForCheck(rec);
  const paperEmploymentDate = nonEmpty(rec.paperEmploymentDate);
  const paperOathDate = nonEmpty(rec.paperDateSigned);
  const paperOfficial =
    nonEmpty(rec.paperOfficialName) ?? (rec.officerSigned === true ? "signed" : null);

  const foundName = nonEmpty(rec.name);
  const foundEid = nonEmpty(rec.employeeId);
  const foundEmploymentDate = nonEmpty(rec.employmentDate);
  const foundOathDate = nonEmpty(rec.oathDate);
  const foundOfficial = nonEmpty(rec.officialSigner);
  const foundActiveStatus = nonEmpty(rec.activeStatus);

  const mk = (
    key: string,
    label: string,
    paperValue: string | null,
    foundValue: string | null,
    source: VerifyCheck["source"],
  ): VerifyCheck => {
    const onPaper = paperValue !== null;
    const status: VerifyCheck["status"] = onPaper
      ? "present"
      : foundValue !== null
        ? "found"
        : "missing";
    return { key, label, onPaper, paperValue, foundValue, source, status };
  };

  const nameCheck = mk("name", "Name", paperName, foundName, "ucpath");
  const eidCheck = mk("eid", "Employee ID", paperEid, foundEid, "ucpath");
  const activeStatusCheck = mk(
    "activeStatus",
    "Active Status",
    null,
    foundActiveStatus,
    "ucpath",
  );

  if (rec.formKind === "oath") {
    const officialSignerCheck = mk(
      "officialSigner",
      "Authorized Official Signer",
      paperOfficial,
      foundOfficial,
      "i9",
    );
    // The signer is blank not because no one signed, but because the operator's
    // account can't view the I-9 record. Render "Unable to access" (the i9
    // lookup runs after person-lookup resolves the EID; the retry re-runs it).
    if (officialSignerCheck.status === "missing" && rec.officialSignerStatus === "unable-to-access") {
      officialSignerCheck.unavailable = true;
    }
    return [
      nameCheck,
      eidCheck,
      mk("employmentDate", "Employment Date", paperEmploymentDate, foundEmploymentDate, "crm"),
      mk("oathDate", "Oath Date", paperOathDate, foundOathDate, "crm"),
      officialSignerCheck,
      activeStatusCheck,
    ];
  }

  // emergency-contact (and unknown) — name, eid, activeStatus.
  return [nameCheck, eidCheck, activeStatusCheck];
}

function paperEmployeeIdForCheck(rec: VerifyPreviewRecord): string | null {
  if (Object.hasOwn(rec, "paperEmployeeId")) {
    return nonEmpty(rec.paperEmployeeId);
  }
  if (rec.personLookupStatus) return null;
  return nonEmpty(rec.employeeId);
}

/**
 * Stamp the enriched person-lookup fields onto a verify record from an
 * `outcome.data`-shaped object (`patchOcrRecordFromEidLookupOutcome` already
 * sets `employeeId` + `verification`; this reads the extra CRM/active fields).
 * Pure — mutates + returns the record.
 */
export function applyPersonLookupToVerifyRecord(
  rec: VerifyPreviewRecord,
  data: Record<string, string> | undefined,
): VerifyPreviewRecord {
  const emplId = nonEmpty(data?.emplId);
  if (emplId) rec.employeeId = emplId;
  const resolvedName = applyPersonLookupNameToOcrRecord(
    rec,
    data,
  );
  if (resolvedName) rec.name = resolvedName;
  else if (!nonEmpty(rec.name)) rec.name = nonEmpty(rec.printedName) ?? "";
  const activeStatus = nonEmpty(data?.activeStatus);
  if (activeStatus) rec.activeStatus = activeStatus;
  const employmentDate = nonEmpty(data?.employmentDate);
  if (employmentDate) rec.employmentDate = employmentDate;
  const oathDate = nonEmpty(data?.oathDate);
  if (oathDate) rec.oathDate = oathDate;
  return rec;
}

// ─── person-lookup child-input shape selection (pure, unit-tested) ──

/** The name-input variant of a verify person-lookup child. */
export type VerifyPlNameInput = {
  name: string;
  includeCrmDates: true;
  keepNonHdh: true;
  taskGroupId: string;
  parentSubject?: string;
};
/** The EID-input variant of a verify person-lookup child. */
export type VerifyPlEidInput = {
  emplId: string;
  name?: string;
  includeCrmDates: true;
  keepNonHdh: true;
  taskGroupId: string;
  parentSubject?: string;
};
export type VerifyPlChildInput = VerifyPlNameInput | VerifyPlEidInput;

/** The lookup kind chosen for a verify record, drives the outcome patch kind. */
export type VerifyPlKind = "eid" | "name";

/**
 * Decide how to drive the person-lookup child for one verify record.
 *
 * When the OCR record already carries a resolved/normalized EID
 * (`normalizeUcpathEmployeeId(rec.employeeId)` non-empty), drive the child as an
 * **EID input** so UCPath active status resolves by EID — a NAME search misses
 * people whose name lookup comes up empty even though their printed EID is
 * valid, leaving active status wrongly "— not found" (CRM has no active status,
 * so the EID is the only reliable key). The OCR-printed name rides along as a
 * CRM-search fallback. A record with no EID uses the **name input** path; a
 * record with neither name nor EID yields `null` (nothing to look up).
 *
 * Pure — no IO. Returns the chosen `{ kind, input }` or `null`.
 */
export function buildVerifyPersonLookupInput(
  rec: Pick<VerifyPreviewRecord, "name" | "employeeId" | "printedName">,
  ctx: { taskGroupId: string; parentSubject?: string },
): { kind: VerifyPlKind; input: VerifyPlChildInput } | null {
  const name = nonEmpty(rec.name) ?? nonEmpty(rec.printedName);
  const emplId = normalizeUcpathEmployeeId(rec.employeeId);
  if (!name && !emplId) return null;
  if (emplId) {
    return {
      kind: "eid",
      input: {
        emplId,
        ...(name ? { name } : {}),
        includeCrmDates: true,
        keepNonHdh: true,
        taskGroupId: ctx.taskGroupId,
        ...(ctx.parentSubject ? { parentSubject: ctx.parentSubject } : {}),
      },
    };
  }
  return {
    kind: "name",
    input: {
      name: name!,
      includeCrmDates: true,
      keepNonHdh: true,
      taskGroupId: ctx.taskGroupId,
      ...(ctx.parentSubject ? { parentSubject: ctx.parentSubject } : {}),
    },
  };
}

/** Map the chosen lookup kind to the `patchOcrRecordFromEidLookupOutcome` kind. */
export function verifyPlPatchKind(kind: VerifyPlKind): "name" | "verify-only" {
  // An EID-input record is already identified on the form, so patch it with the
  // EID-known semantics ("verify-only") — it must NOT be marked unresolved just
  // because the lookup returned a different/no EID; the form EID stands. A
  // name-input record uses the name→EID resolution semantics.
  return kind === "eid" ? "verify-only" : "name";
}

/**
 * Stamp the i9 Section-2 signer onto a verify record from an
 * `outcome.data`-shaped object. Pure — mutates + returns the record.
 */
export function applyI9ToVerifyRecord(
  rec: VerifyPreviewRecord,
  data: Record<string, string> | undefined,
): VerifyPreviewRecord {
  const signerName = nonEmpty(data?.signerName);
  if (signerName) rec.officialSigner = signerName;
  // Carry the i9 status so `buildVerifyChecks` can render "Unable to access"
  // (record exists but out of the operator's access scope) distinctly from a
  // genuine "— not found".
  const i9Status = nonEmpty(data?.i9Status);
  if (i9Status) rec.officialSignerStatus = i9Status;
  return rec;
}

// ─── Spec implementation ────────────────────────────────────

export const verifyOcrFormSpec: OcrFormSpec<VerifyOcrRecord, VerifyPreviewRecord> = {
  formType: "verify",
  label: "Verify (mixed)",
  description:
    "Mixed oath + emergency-contact PDFs. Reads each form and looks up what's missing (CRM dates, active status, I-9 signer). Read-only — no UCPath writes.",

  prompt: VERIFY_OCR_PROMPT,
  ocrRecordSchema: VerifyOcrRecordSchema,
  ocrArraySchema: VerifyOcrOutputSchema,
  schemaName: "verify-batch",

  async matchRecord({ record }): Promise<VerifyPreviewRecord> {
    const name = nonEmpty(record.printedName) ?? "";
    const rec: VerifyPreviewRecord = {
      ...record,
      formKind: record.formKind ?? "unknown",
      name,
      paperEmployeeId: normalizeUcpathEmployeeId(record.employeeId),
      employeeId: normalizeUcpathEmployeeId(record.employeeId),
      documentType: record.documentType ?? "expected",
      originallyMissing: record.originallyMissing ?? [],
      notes: record.notes ?? [],
      matchState: "extracted",
      selected: true,
      warnings: [],
      checks: [],
    };
    rec.checks = buildVerifyChecks(rec);
    return rec;
  },

  // verify owns all enrichment in enrichRecords — the orchestrator's eid-lookup
  // fan-out must NOT run for verify, so report no lookup need.
  needsLookup(): LookupKind {
    return null;
  },

  // needsLookup is null → the disambiguating phase never calls this.
  applyDisambiguation({ record }): VerifyPreviewRecord {
    return record;
  },

  carryForwardKey(record): string {
    return normalizePersonNameForCompare(record.name ?? "");
  },

  applyCarryForward({ v2, v1 }): VerifyPreviewRecord {
    // Loose form-kind compatibility: verify rows are heterogeneous (oath +
    // emergency-contact + unknown mixed in one PDF), so we only reject a
    // carry-forward that would merge two DIFFERENT known kinds. Legacy JSONL
    // rows (parsed without Zod defaults) may carry undefined — tolerate them.
    assertCarryForwardKindCompatible("verify", v1.formKind, v2.formKind);
    const resolved =
      v1.matchState === "resolved" && normalizeUcpathEmployeeId(v1.employeeId);
    return {
      ...v2,
      employeeId: resolved ? v1.employeeId : v2.employeeId,
      // Carry `paperEmployeeId` from v1 alongside the resolved employeeId. The
      // completeness report distinguishes the EID on PAPER (`paperEmployeeId`)
      // from the looked-up/found EID (`employeeId`); spreading `...v2` alone kept
      // v2's freshly-re-OCR'd paper value next to v1's carried resolved value,
      // silently changing paper-vs-found semantics for a carried-forward record.
      // Tolerate a v1 without the field (legacy rows) by falling back to v2's.
      paperEmployeeId: resolved
        ? (v1.paperEmployeeId ?? v2.paperEmployeeId)
        : v2.paperEmployeeId,
      matchState: resolved ? v1.matchState : v2.matchState,
      verification: resolved ? (v1.verification ?? v2.verification) : v2.verification,
    };
  },

  isForceResearchFlag: isForceResearchFlagRecord,

  // No approve fan-out — verify is read-only. No approveTo / approveDocumentTo.

  rosterMode: "optional",
  traceCode: "vf",

  // ─── Cross-system enrichment (mirrors force-research.ts) ──────────────
  async enrichRecords(input): Promise<VerifyPreviewRecord[]> {
    const { records, runId, sessionId, trackerDir, date, parentSubject, rootTracePrefix, runOptions } =
      input;
    const recs = records as unknown[];

    // Operator's Automation-workers setting → daemon flags for both fan-outs.
    // Auto → {} (default reuse-or-spawn-one); explicit N>1 → { parallel: N }.
    const enrichDaemonFlags = runOptionsToDaemonFlags(runOptions);

    // Operator-cancel bridge. The orchestrator trips the in-process prepare-abort
    // flag when `ctx.signal` aborts (queue-row Cancel ×, daemon stop), and the
    // shared `fanOutAndWatch` calls below poll `shouldAbort` and throw a
    // discard-abort error when it's set — then cascade-cancel the still-queued
    // person-lookup / i9-lookup children (so a daemon doesn't claim and run them
    // after the operator gave up) and rethrow. Fail-loud — the cascade lives
    // inside fanOutAndWatch, so there is no outer catch here.
    const shouldAbort = (): boolean => isOcrPrepareAbortRequested(sessionId, runId);

    // Dynamic imports avoid an import cycle (mirrors force-research.ts).
    // Sequential on purpose: concurrent dynamic imports of two large module
    // graphs interact badly with vitest's resetModules-based tests.
    const { personLookupWorkflow } = await import("../../../workflows/person-lookup/index.js");
    const { i9LookupWorkflow } = await import("../../../workflows/i9-lookup/index.js");

    // ── Person-lookup inputs (EID-or-name → CRM dates + active) ──────────
    //
    // Per-record input shape + outcome-patch kind are chosen by the pure
    // `buildVerifyPersonLookupInput` / `verifyPlPatchKind` helpers (unit-tested):
    // a record with a known/normalized EID is driven as an EID input (active
    // status resolves by EID in UCPath — a NAME-only search misses people whose
    // name lookup is empty even though their printed EID is valid; CRM has no
    // active status, so the EID is the only reliable key). EID-less records keep
    // the name path. The EID-input person-lookup path still runs `crm-dates`
    // (gated on `includeCrmDates`) — it searches CRM by EID first, then by the
    // UCPath-resolved name.
    type PersonLookupChildInput = VerifyPlChildInput;
    const plInputs: PersonLookupChildInput[] = [];
    const plItemIds: string[] = [];
    const plItemIdToIdx = new Map<string, number>();
    // The lookup KIND chosen per record, keyed by itemId, so the outcome patch
    // picks the matching `patchOcrRecordFromEidLookupOutcome` kind.
    const plKindByItemId = new Map<string, VerifyPlKind>();

    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      const chosen = buildVerifyPersonLookupInput(rec, {
        taskGroupId: sessionId,
        ...(parentSubject ? { parentSubject } : {}),
      });
      if (!chosen) {
        // No name AND no EID — nothing to look up; mark unresolved.
        const r = recs[idx] as Record<string, unknown>;
        r.matchState = "unresolved";
        const warnings = Array.isArray(r.warnings) ? (r.warnings as string[]) : [];
        warnings.push("No name extracted — cannot enrich");
        r.warnings = warnings;
        continue;
      }
      const itemId = `${ocrChildItemIdPrefix("verify")}-${runId}-r${idx}`;
      plItemIds.push(itemId);
      plItemIdToIdx.set(itemId, idx);
      plKindByItemId.set(itemId, chosen.kind);
      plInputs.push(chosen.input);
    }

    // ── i9-lookup inputs (oath, blank official signer) ───────────────────
    // Derived from RAW OCR fields only (formKind / officerSigned / name) —
    // person-lookup outcomes never rewrite `name` — so the two fan-outs are
    // fully independent and can run concurrently below (F-2).
    type I9ChildInput = {
      lastName: string;
      firstName: string;
      parentSubject?: string;
    };
    const i9Inputs: I9ChildInput[] = [];
    const i9ItemIds: string[] = [];
    const i9ItemIdToIdx = new Map<string, number>();

    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      if (rec.formKind !== "oath") continue;
      if (rec.officerSigned === true) continue;
      const name = nonEmpty(rec.name);
      if (!name) continue;
      let parsed: { lastName: string; first: string };
      try {
        parsed = parsePersonOrgNameInput(name);
      } catch (err) {
        log.warn(`[verify/i9] skipping record ${idx}: name parse failed for "${name}": ${String(err)}`);
        continue;
      }
      if (!parsed.lastName || !parsed.first) continue;
      const itemId = `${ocrChildItemIdPrefix("verify")}-i9-${runId}-r${idx}`;
      i9ItemIds.push(itemId);
      i9ItemIdToIdx.set(itemId, idx);
      i9Inputs.push({
        lastName: parsed.lastName,
        firstName: parsed.first,
        ...(parentSubject ? { parentSubject } : {}),
      });
    }

    // ── Concurrent fan-outs (F-2): person-lookup + i9-lookup together ────
    // The i9 dispatch used to wait for EVERY person-lookup to settle, so i9
    // children couldn't even be CLAIMED until the slowest Duo-serialized
    // person-lookup finished — doubling enrichment wall-clock for no data
    // dependency. Each branch patches disjoint per-record fields
    // (personLookup* vs i9Lookup*/officialSigner*), so concurrent onProgress
    // patching is safe.
    const runPersonFanOut = async (): Promise<void> => {
      if (plInputs.length === 0) return;
      const processedPlItemIds = new Set<string>();
      const applyPersonLookupOutcome = (outcome: ChildOutcome): void => {
        const idx = plItemIdToIdx.get(outcome.itemId);
        if (idx === undefined) return;
        processedPlItemIds.add(outcome.itemId);
        const patchKind = verifyPlPatchKind(plKindByItemId.get(outcome.itemId) ?? "name");
        patchOcrRecordFromEidLookupOutcome(recs, idx, outcome, patchKind);
        applyPersonLookupToVerifyRecord(records[idx], outcome.data);
        records[idx].personLookupStatus = outcome.status === "done" ? "completed" : "failed";
        const traceId = nonEmpty(outcome.terminalEntry?.data?.__traceId);
        if (traceId) records[idx].personLookupTraceId = traceId;
        records[idx].checks = buildVerifyChecks(records[idx]);
        log.step({
          message: `[verify/person-lookup] record ${idx} status=${records[idx].personLookupStatus ?? "unknown"} childStatus=${outcome.status} itemId=${outcome.itemId} traceId=${records[idx].personLookupTraceId ?? ""}`,
          category: "ocr",
          occasion: outcome.status === "done" ? "completed" : "failed",
          childWorkflow: "person-lookup",
          subject: `record:${idx}`,
        });
        input.emitProgress(records);
      };

      // Shared dispatch→watch→cascade-cancel pipeline (BM-1). `onDispatched`
      // stamps each record `pending` + its child trace id before the watch
      // begins (so the Preview tab shows the children queued); `onProgress`
      // patches each record as its child terminates.
      //
      // ISS-003: a watchChildRuns TIMEOUT is not an operator abort — it means a
      // backed-up person-lookup queue took longer than timeoutMs (30 min). We
      // catch it here and degrade gracefully: records that DID finish before the
      // timeout are already stamped via `onProgress`; the ones that didn't get
      // marked `personLookupStatus: "failed"` with a timed-out note, then
      // `enrichRecords` resolves normally so the operator sees a partial report
      // (`N of M enriched — lookup timed out`) instead of a hard-failed OCR run
      // that discards all completed enrichment. Operator-abort errors are NOT
      // caught here — they propagate so `Promise.allSettled` sees the rejection
      // and the `firstRejection` rethrow unwinds the prep as cancelled.
      const plWatchResult = await fanOutAndWatch<PersonLookupChildInput>({
        sessionId,
        runId,
        parentRunId: runId,
        trackerDir,
        date,
        child: personLookupWorkflow as never,
        children: plInputs.map((inp, i) => ({ input: inp, itemId: plItemIds[i] ?? "" })),
        timeoutMs:
          typeof process !== "undefined" && process.env["OCR_VERIFY_WATCH_TIMEOUT_MS"]
            ? Number(process.env["OCR_VERIFY_WATCH_TIMEOUT_MS"])
            : 30 * 60_000,
        ...(rootTracePrefix ? { rootTracePrefix } : {}),
        ...(enrichDaemonFlags.parallel ? { daemonFlags: enrichDaemonFlags } : {}),
        shouldAbort,
        onDispatched: (results) => {
          for (const result of results) {
            const idx = plItemIdToIdx.get(result.itemId);
            if (idx === undefined) continue;
            records[idx].personLookupStatus = "pending";
            records[idx].personLookupTraceId = buildTraceId({
              code: "pl",
              runId: result.runId,
              at: new Date(),
              rootPrefix: rootTracePrefix,
            });
            log.step({
              message: `[verify/person-lookup] record ${idx} status=pending itemId=${result.itemId} traceId=${records[idx].personLookupTraceId ?? ""}`,
              category: "ocr",
              occasion: "started",
              childWorkflow: "person-lookup",
              subject: `record:${idx}`,
            });
          }
          input.emitProgress(records);
        },
        onProgress: (outcome) => applyPersonLookupOutcome(outcome),
      }).catch((err: unknown): FanOutResult => {
        if (isOperatorDiscardAbortError(err)) throw err; // operator cancel — rethrow
        if (!isChildWatchError(err) || err.kind !== "timeout") throw err;
        // Timeout (or other non-abort watch failure): mark all unprocessed
        // children as failed and degrade to a partial report.
        const timedOut = plItemIds.filter((id) => !processedPlItemIds.has(id));
        log.warn({
          message: `[verify/person-lookup] watch timed out — ${timedOut.length} of ${plItemIds.length} lookups did not settle: ${timedOut.join(", ")}`,
          category: "ocr",
          occasion: "failed",
          childWorkflow: "person-lookup",
          subject: "verify-enrichment",
        });
        return { outcomes: [], byItemId: new Map(), missingItemIds: timedOut };
      });
      const { outcomes: plOutcomes, missingItemIds: plMissing } = plWatchResult;

      for (const outcome of plOutcomes) {
        if (processedPlItemIds.has(outcome.itemId)) continue;
        applyPersonLookupOutcome(outcome);
      }

      for (const itemId of plMissing) {
        const idx = plItemIdToIdx.get(itemId);
        if (idx === undefined) continue;
        patchOcrRecordUnresolved(recs, idx, "person-lookup timed out without a result");
        records[idx].personLookupStatus = "failed";
        log.warn({
          message: `[verify/person-lookup] record ${idx} status=failed reason=timeout itemId=${itemId} traceId=${records[idx].personLookupTraceId ?? ""}`,
          category: "ocr",
          occasion: "failed",
          childWorkflow: "person-lookup",
          subject: `record:${idx}`,
        });
      }
    };

    const runI9FanOut = async (): Promise<void> => {
      if (i9Inputs.length === 0) return;
      const processedI9ItemIds = new Set<string>();
      const applyI9Outcome = (outcome: ChildOutcome): void => {
        const idx = i9ItemIdToIdx.get(outcome.itemId);
        if (idx === undefined) return;
        processedI9ItemIds.add(outcome.itemId);
        applyI9ToVerifyRecord(records[idx], outcome.data);
        // A child can complete (`outcome.status === "done"`) yet report
        // `i9Status: "error"` in its DATA — the lookup ran but errored out. That
        // is a FAILURE, not a completion: counting it `completed` overstated the
        // success count in the summary. `not-found` / `unable-to-access` are
        // genuine completions (the report renders them), so only `"error"`
        // downgrades. `applyI9ToVerifyRecord` already stamped officialSignerStatus.
        const i9DataStatus = nonEmpty(outcome.data?.i9Status);
        records[idx].i9LookupStatus =
          outcome.status === "done" && i9DataStatus !== "error" ? "completed" : "failed";
        const traceId = nonEmpty(outcome.terminalEntry?.data?.__traceId);
        if (traceId) records[idx].i9LookupTraceId = traceId;
        records[idx].checks = buildVerifyChecks(records[idx]);
        log.step({
          message: `[verify/i9] record ${idx} status=${records[idx].i9LookupStatus ?? "unknown"} childStatus=${outcome.status} i9Status=${records[idx].officialSignerStatus ?? ""} itemId=${outcome.itemId} traceId=${records[idx].i9LookupTraceId ?? ""}`,
          category: "ocr",
          occasion: outcome.status === "done" ? "completed" : "failed",
          childWorkflow: "i9-lookup",
          subject: `record:${idx}`,
        });
        input.emitProgress(records);
      };

      // Shared dispatch→watch→cascade-cancel pipeline (BM-1). The watched
      // workflow is i9-lookup (not the default child name), so pass it explicitly.
      //
      // ISS-003: same graceful-timeout handling as the person fan-out above.
      // Every non-timeout watch failure still rethrows; only an explicit typed
      // timeout degrades to a partial report with unsettled records marked failed.
      const i9WatchResult = await fanOutAndWatch<I9ChildInput>({
        sessionId,
        runId,
        parentRunId: runId,
        trackerDir,
        date,
        child: i9LookupWorkflow as never,
        watchWorkflow: "i9-lookup",
        children: i9Inputs.map((inp, i) => ({ input: inp, itemId: i9ItemIds[i] ?? "" })),
        timeoutMs:
          typeof process !== "undefined" && process.env["OCR_VERIFY_WATCH_TIMEOUT_MS"]
            ? Number(process.env["OCR_VERIFY_WATCH_TIMEOUT_MS"])
            : 30 * 60_000,
        ...(rootTracePrefix ? { rootTracePrefix } : {}),
        ...(enrichDaemonFlags.parallel ? { daemonFlags: enrichDaemonFlags } : {}),
        shouldAbort,
        onDispatched: (results) => {
          for (const result of results) {
            const idx = i9ItemIdToIdx.get(result.itemId);
            if (idx === undefined) continue;
            records[idx].i9LookupStatus = "pending";
            records[idx].i9LookupTraceId = buildTraceId({
              code: "i9",
              runId: result.runId,
              at: new Date(),
              rootPrefix: rootTracePrefix,
            });
            log.step({
              message: `[verify/i9] record ${idx} status=pending itemId=${result.itemId} traceId=${records[idx].i9LookupTraceId ?? ""}`,
              category: "ocr",
              occasion: "started",
              childWorkflow: "i9-lookup",
              subject: `record:${idx}`,
            });
          }
          input.emitProgress(records);
        },
        onProgress: (outcome) => applyI9Outcome(outcome),
      }).catch((err: unknown): FanOutResult => {
        if (isOperatorDiscardAbortError(err)) throw err; // operator cancel — rethrow
        if (!isChildWatchError(err) || err.kind !== "timeout") throw err;
        // Timeout (or other non-abort watch failure): mark all unprocessed
        // i9-lookup children as failed and continue with partial results.
        const timedOut = i9ItemIds.filter((id) => !processedI9ItemIds.has(id));
        log.warn({
          message: `[verify/i9] watch timed out — ${timedOut.length} of ${i9ItemIds.length} lookups did not settle: ${timedOut.join(", ")}`,
          category: "ocr",
          occasion: "failed",
          childWorkflow: "i9-lookup",
          subject: "verify-enrichment",
        });
        return { outcomes: [], byItemId: new Map(), missingItemIds: timedOut };
      });
      const { outcomes: i9Outcomes, missingItemIds: i9Missing } = i9WatchResult;

      for (const outcome of i9Outcomes) {
        if (processedI9ItemIds.has(outcome.itemId)) continue;
        applyI9Outcome(outcome);
      }

      for (const itemId of i9Missing) {
        const idx = i9ItemIdToIdx.get(itemId);
        if (idx === undefined) continue;
        records[idx].i9LookupStatus = "failed";
        log.warn({
          message: `[verify/i9] record ${idx} status=failed reason=timeout itemId=${itemId} traceId=${records[idx].i9LookupTraceId ?? ""}`,
          category: "ocr",
          occasion: "failed",
          childWorkflow: "i9-lookup",
          subject: `record:${idx}`,
        });
      }
    };

    // Both branches settle FULLY before the first error is rethrown — on an
    // operator abort each fan-out cascade-cancels its own queued children;
    // Promise.all would orphan the surviving branch mid-watch (its later
    // rejection would surface as an unhandled rejection).
    const settled = await Promise.allSettled([runPersonFanOut(), runI9FanOut()]);
    const firstRejection = settled.find(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    if (firstRejection) throw firstRejection.reason;

    input.emitProgress(records);

    // ── Step 3: recompute checks + finalize match state for every record ──
    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      rec.checks = buildVerifyChecks(rec);
      rec.matchState = normalizeUcpathEmployeeId(rec.employeeId) ? "resolved" : "unresolved";
    }

    // The summary fires AFTER both watch calls have fully resolved, so every
    // record is terminal (completed/failed). The `i9Pending` count was therefore
    // ALWAYS 0 (no "running" enum value is ever assigned either) — a dead field;
    // dropped rather than implemented.
    const personCompleted = records.filter((rec) => rec.personLookupStatus === "completed").length;
    const personFailed = records.filter((rec) => rec.personLookupStatus === "failed").length;
    const i9Completed = records.filter((rec) => rec.i9LookupStatus === "completed").length;
    const i9Failed = records.filter((rec) => rec.i9LookupStatus === "failed").length;
    log.success({
      message: `[verify/enrich] complete records=${records.length} personCompleted=${personCompleted} personFailed=${personFailed} i9Completed=${i9Completed} i9Failed=${i9Failed}`,
      category: "ocr",
      occasion: "completed",
      subject: "verify-enrichment",
    });

    return records;
  },
};
