/**
 * OCR form spec for scanned **Form I-9** (Employment Eligibility Verification)
 * PDFs. Implements `OcrFormSpec` so OCR's orchestrator runs this form-type
 * generically.
 *
 * Like `verify`, `i9` is a READ-AND-FIND-OUT tool: it reads each I-9's
 * Section 1 (employee name, date of birth, SSN), then checks whether UCPath
 * already knows that person by fanning out one **person-match** child per
 * record — the same UCPath HR-Tasks person search onboarding uses to
 * discriminate new hires from rehires (`searchPerson`,
 * `src/systems/ucpath/navigate.ts`). The per-record answer (found /
 * not found, plus the matched EID when found) renders as a completeness
 * report in the OCR preview. It does NOT write to UCPath and has NO approve
 * fan-out.
 *
 * Enrichment is owned by this spec's `enrichRecords` hook (the orchestrator's
 * eid-lookup fan-out is suppressed by `needsLookup` always returning null).
 * `enrichRecords` mirrors `verify.ts`'s person fan-out: build inputs →
 * `fanOutAndWatch` → patch records from outcomes.
 */
import { z } from "zod/v4";
import { log } from "../../../utils/log.js";
import { normalizePersonNameForCompare } from "../../../domain/identity/person-name.js";
import { runOptionsToDaemonFlags } from "../../../domain/run-options.js";
import { buildTraceId } from "../../../domain/queue-trace-id.js";
import { type ChildOutcome } from "../../../tracker/delegation/watch-child-runs.js";
import {
  isOcrPrepareAbortRequested,
  isOperatorDiscardAbortError,
} from "../../../tracker/ocr-prepare-abort.js";
import { fanOutAndWatch, type FanOutResult } from "../fan-out.js";
import type { OcrFormSpec, LookupKind } from "../../../workflows/ocr/types.js";
import { VerifyCheckSchema, type VerifyCheck } from "./verify.js";
import {
  DocumentTypeSchema,
  MatchStateSchema,
  isForceResearchFlagRecord,
  ocrChildItemIdPrefix,
} from "./shared.js";

// ─── OCR-pass record (one page of the scanned PDF) ──────────

const I9_FORM_KINDS = ["i9", "unknown"] as const;

/**
 * `formKind` tolerant coercion — mirrors verify's `VerifyFormKindSchema`
 * precedent: a PRESENT-but-unrecognized string (model hallucination/typo) must
 * not fail `safeParse` and silently drop the WHOLE record from operator review
 * (root CLAUDE.md "fail loud — no unverified silent fallbacks": losing the
 * record is worse than one wrong-looking label on it). Coerce any unrecognized
 * value to "unknown" and `log.warn` it; `undefined`/missing is the ordinary
 * "model omitted the field" case and does not warn.
 */
const I9FormKindSchema = z.preprocess((v) => {
  if (typeof v === "string" && (I9_FORM_KINDS as readonly string[]).includes(v)) return v;
  if (v !== undefined) {
    log.warn(
      `[i9] unrecognized formKind ${JSON.stringify(v)} — coercing to "unknown" so the record still surfaces for review`,
    );
  }
  return "unknown";
}, z.enum(I9_FORM_KINDS));

export const I9OcrRecordSchema = z.object({
  formKind: I9FormKindSchema,
  sourcePage: z.number().int().positive(),
  /** Section 1 employee last name (family name). */
  lastName: z.string().nullable().optional(),
  /** Section 1 employee first name (given name). */
  firstName: z.string().nullable().optional(),
  /** Section 1 middle initial. */
  middleInitial: z.string().nullable().optional(),
  /** Section 1 date of birth, as printed (mm/dd/yyyy). */
  dateOfBirth: z.string().nullable().optional(),
  /** Section 1 U.S. Social Security Number, as printed. */
  ssn: z.string().nullable().optional(),
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type I9OcrRecord = z.infer<typeof I9OcrRecordSchema>;

export const I9OcrOutputSchema = z.array(I9OcrRecordSchema);
export type I9OcrOutput = z.infer<typeof I9OcrOutputSchema>;

// ─── Preview record (in-flight, post-match + post-enrichment) ──

export const I9PreviewRecordSchema = I9OcrRecordSchema.extend({
  /** Display name ("Last, First M") assembled from the Section 1 name fields. */
  name: z.string().default(""),
  /** UCPath person-search outcome: person exists ("true") or not ("false"). */
  ucpathFound: z.boolean().optional(),
  /** Empl ID of the first UCPath results-grid match, when found. */
  matchedEmplId: z.string().optional(),
  /** Name of the first UCPath results-grid match, when found. */
  matchedName: z.string().optional(),
  /** State of the person-match child that enriched this record. */
  personMatchStatus: z.enum(["pending", "running", "completed", "failed"]).optional(),
  /** Trace id of the person-match child that enriched this record. */
  personMatchTraceId: z.string().optional(),
  matchState: MatchStateSchema,
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
  checks: z.array(VerifyCheckSchema).default([]),
});
export type I9PreviewRecord = z.infer<typeof I9PreviewRecordSchema>;

// ─── Prompt ─────────────────────────────────────────────────

const I9_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of scanned USCIS Form I-9 (Employment Eligibility Verification) documents. Each page is either:
- "i9" — a Form I-9 page whose SECTION 1 (Employee Information and Attestation) is visible: it carries the employee's last name, first name, middle initial, date of birth, and U.S. Social Security Number.
- "unknown" — any other page: Section 2/3-only pages, Lists of Acceptable Documents, supplements, instructions, blank or irrelevant pages.

For each page produce exactly one record.

OUTPUT SHAPE (CRITICAL — must be a FLAT JSON ARRAY at the top level):

\`\`\`json
[
  { "formKind": "i9", "sourcePage": 1, "lastName": "Doe", "firstName": "Jane", "middleInitial": "A", "dateOfBirth": "04/01/1998", "ssn": "123-45-6789", "documentType": "expected", "originallyMissing": [], "notes": [] },
  { "formKind": "unknown", "sourcePage": 2, "lastName": null, "firstName": null, "middleInitial": null, "dateOfBirth": null, "ssn": null, "documentType": "unknown", "originallyMissing": [], "notes": [] }
]
\`\`\`

Do NOT wrap records in a page object. Do NOT nest under "records" or "data" keys. The top-level value MUST be a JSON array. Each element is exactly one record.

For EVERY record:
- formKind: "i9" when the page shows Section 1 employee fields; "unknown" otherwise.
- sourcePage: the 1-indexed page number.
- lastName / firstName / middleInitial: the SECTION 1 employee name fields ONLY (labeled "Last Name (Family Name)", "First Name (Given Name)", "Middle Initial"). Do NOT copy names from Section 2 (the employer/authorized representative) or from document titles in the Lists of Acceptable Documents. ALWAYS attempt a best-guess transcription of handwriting — speak the name out loud as you read it. Only set null when the field is genuinely BLANK.
- dateOfBirth: the Section 1 "Date of Birth (mm/dd/yyyy)" value, exactly as printed. Null if blank. Do NOT confuse it with the employee's signature date or the employment start date.
- ssn: the Section 1 "U.S. Social Security Number" value, copying ALL digits exactly (with or without dashes as printed). Null when blank or masked.
- documentType: "expected" for an I-9 Section 1 page; "unknown" for anything else.
- originallyMissing: array of expected field names that were genuinely BLANK on the paper. Use [] when nothing was missing.
- notes: free-form observations, or [].

Output ONLY the valid JSON array. No commentary, no markdown fences, no wrapper object.`;

// ─── Pure helpers (exported, unit-tested) ───────────────────

/** Trim a value to a non-empty string, or null. */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Normalize an OCR'd SSN to the 9 bare digits UCPath person search fills as
 * the National ID, or null when it isn't a complete SSN (partial / masked /
 * garbled reads must NOT be searched — a wrong NID silently yields a
 * false "not found").
 */
export function normalizeI9Ssn(v: unknown): string | null {
  const raw = nonEmpty(v);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return /^\d{9}$/.test(digits) ? digits : null;
}

/**
 * Normalize an OCR'd date of birth to the MM/DD/YYYY shape UCPath person
 * search expects. Accepts `/`, `-`, or `.` separators and unpadded month/day.
 * Returns null for anything else — including 2-digit years, whose century
 * would be a guess (fail loud at the record level rather than search a wrong
 * DOB and report a false "not found").
 */
export function normalizeI9Dob(v: unknown): string | null {
  const raw = nonEmpty(v);
  if (!raw) return null;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(raw);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(year)}`;
}

/** Display name ("Last, First M") from the Section 1 name fields. */
export function buildI9DisplayName(rec: {
  lastName?: string | null;
  firstName?: string | null;
  middleInitial?: string | null;
}): string {
  const last = nonEmpty(rec.lastName);
  const first = nonEmpty(rec.firstName);
  const middle = nonEmpty(rec.middleInitial);
  if (!last && !first) return "";
  const given = [first, middle].filter(Boolean).join(" ");
  return last && given ? `${last}, ${given}` : (last ?? given ?? "");
}

/** The person-match child input built for one i9 record. */
export type I9PersonMatchInput = {
  lastName: string;
  firstName: string;
  ssn?: string;
  dob?: string;
  parentSubject?: string;
};

/**
 * Decide how to drive the person-match child for one i9 record.
 *
 * UCPath person search needs a name plus at least one hard identifier — a
 * usable (9-digit) SSN or a normalized MM/DD/YYYY DOB. A record missing the
 * name or BOTH identifiers yields `null` (nothing searchable); the caller
 * marks it unresolved with a legible warning instead of running a search
 * guaranteed to mis-answer.
 *
 * Pure — no IO.
 */
export function buildI9PersonMatchInput(
  rec: Pick<I9PreviewRecord, "lastName" | "firstName" | "dateOfBirth" | "ssn">,
  ctx: { parentSubject?: string },
): I9PersonMatchInput | null {
  const lastName = nonEmpty(rec.lastName);
  const firstName = nonEmpty(rec.firstName);
  if (!lastName || !firstName) return null;
  const ssn = normalizeI9Ssn(rec.ssn);
  const dob = normalizeI9Dob(rec.dateOfBirth);
  if (!ssn && !dob) return null;
  return {
    lastName,
    firstName,
    ...(ssn ? { ssn } : {}),
    ...(dob ? { dob } : {}),
    ...(ctx.parentSubject ? { parentSubject: ctx.parentSubject } : {}),
  };
}

/**
 * Stamp the person-match outcome onto an i9 record from an
 * `outcome.data`-shaped object. Pure — mutates + returns the record.
 */
export function applyPersonMatchToI9Record(
  rec: I9PreviewRecord,
  data: Record<string, string> | undefined,
): I9PreviewRecord {
  const found = nonEmpty(data?.found);
  if (found === "true") rec.ucpathFound = true;
  else if (found === "false") rec.ucpathFound = false;
  const matchedEmplId = nonEmpty(data?.matchedEmplId);
  if (matchedEmplId) rec.matchedEmplId = matchedEmplId;
  const matchedName = nonEmpty(data?.matchedName);
  if (matchedName) rec.matchedName = matchedName;
  return rec;
}

/**
 * Build the completeness checklist from a record's paper + match values.
 *
 * Paper fields (name / dob / ssn) are `present` or `missing` — they are never
 * looked up. The `ucpathPerson` check is the point of the run: `found` when
 * the UCPath person search matched (foundValue names the EID when the results
 * grid was readable), `missing` with the DEFAULT "— not found" text only when
 * UCPath definitively answered no. An UNANSWERED state must never read as a
 * real not-found (fail loud): a failed/timed-out match shows "Search failed —
 * result unknown" and a not-yet-searched record (mid-prep, or a re-OCR'd page
 * whose enrichment hasn't re-run) shows "Not checked" via `missingLabel`.
 */
export function buildI9Checks(rec: I9PreviewRecord): VerifyCheck[] {
  const paperName = nonEmpty(rec.name) ?? (buildI9DisplayName(rec) || null);
  const paperDob = nonEmpty(rec.dateOfBirth);
  const paperSsn = nonEmpty(rec.ssn);

  const mkPaper = (key: string, label: string, paperValue: string | null): VerifyCheck => ({
    key,
    label,
    onPaper: paperValue !== null,
    paperValue,
    foundValue: null,
    source: "paper",
    status: paperValue !== null ? "present" : "missing",
  });

  const foundValue =
    rec.ucpathFound === true
      ? [
          rec.matchedEmplId ? `EID ${rec.matchedEmplId}` : null,
          rec.matchedName ?? null,
        ]
          .filter(Boolean)
          .join(" — ") || "Found"
      : null;

  const ucpathCheck: VerifyCheck = {
    key: "ucpathPerson",
    label: "UCPath Person",
    onPaper: false,
    paperValue: null,
    foundValue,
    source: "ucpath",
    status: rec.ucpathFound === true ? "found" : "missing",
  };
  if (rec.ucpathFound === undefined) {
    ucpathCheck.missingLabel =
      rec.personMatchStatus === "failed"
        ? "Search failed — result unknown"
        : "Not checked";
  }

  return [
    mkPaper("name", "Name", paperName),
    mkPaper("dob", "Date of Birth", paperDob),
    mkPaper("ssn", "SSN", paperSsn),
    ucpathCheck,
  ];
}

// ─── Spec implementation ────────────────────────────────────

export const i9OcrFormSpec: OcrFormSpec<I9OcrRecord, I9PreviewRecord> = {
  formType: "i9",
  label: "I-9 (UCPath check)",
  description:
    "Scanned Form I-9 packets. Reads each Section 1 (name, DOB, SSN), then runs the UCPath person search to check whether the person exists. Read-only — no UCPath writes.",

  prompt: I9_OCR_PROMPT,
  ocrRecordSchema: I9OcrRecordSchema,
  ocrArraySchema: I9OcrOutputSchema,
  schemaName: "i9-batch",

  async matchRecord({ record }): Promise<I9PreviewRecord> {
    const rec: I9PreviewRecord = {
      ...record,
      formKind: record.formKind ?? "unknown",
      name: buildI9DisplayName(record),
      documentType: record.documentType ?? "expected",
      originallyMissing: record.originallyMissing ?? [],
      notes: record.notes ?? [],
      matchState: "extracted",
      selected: true,
      warnings: [],
      checks: [],
    };
    rec.checks = buildI9Checks(rec);
    return rec;
  },

  // i9 owns all enrichment in enrichRecords — the orchestrator's eid-lookup
  // fan-out must NOT run for i9, so report no lookup need.
  needsLookup(): LookupKind {
    return null;
  },

  // needsLookup is null → the disambiguating phase never calls this.
  applyDisambiguation({ record }): I9PreviewRecord {
    return record;
  },

  carryForwardKey(record): string {
    return normalizePersonNameForCompare(record.name ?? "");
  },

  // A re-OCR'd i9 record keeps the FRESH read: enrichment re-runs the UCPath
  // person search anyway, so carrying a prior match result forward would only
  // risk showing a stale found/not-found beside re-read identity fields.
  applyCarryForward({ v2 }): I9PreviewRecord {
    return v2;
  },

  isForceResearchFlag: isForceResearchFlagRecord,

  // No approve fan-out — i9 is read-only. No approveTo / approveDocumentTo.

  rosterMode: "optional",
  traceCode: "ic",

  placeholderFields(): Record<string, unknown> {
    return {
      formKind: "unknown",
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: null,
      name: "",
      checks: [],
    };
  },

  // ─── UCPath person-match enrichment (mirrors verify's person fan-out) ──
  async enrichRecords(input): Promise<I9PreviewRecord[]> {
    const {
      records,
      runId,
      sessionId,
      trackerDir,
      date,
      parentSubject,
      rootTracePrefix,
      runOptions,
    } = input;

    // Operator's Automation-workers setting → daemon flags for the fan-out.
    const enrichDaemonFlags = runOptionsToDaemonFlags(runOptions);

    // Operator-cancel bridge — `fanOutAndWatch` polls this and cascade-cancels
    // still-queued person-match children on a discard/cancel (fail-loud; the
    // cascade lives inside fanOutAndWatch, so there is no outer catch here).
    const shouldAbort = (): boolean => isOcrPrepareAbortRequested(sessionId, runId);

    // Dynamic import avoids an import cycle (mirrors verify.ts / force-research.ts).
    const { personMatchWorkflow } = await import("../../../workflows/person-match/index.js");

    const pmInputs: I9PersonMatchInput[] = [];
    const pmItemIds: string[] = [];
    const pmItemIdToIdx = new Map<string, number>();

    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      if (rec.formKind !== "i9" && !nonEmpty(rec.lastName) && !nonEmpty(rec.firstName)) {
        // A non-I-9 page with no identity fields — nothing to check, and not an
        // error (Section 2 / list pages are expected in a scanned packet).
        continue;
      }
      const chosen = buildI9PersonMatchInput(rec, {
        ...(parentSubject ? { parentSubject } : {}),
      });
      if (!chosen) {
        rec.matchState = "unresolved";
        rec.warnings.push(
          "Cannot search UCPath: the I-9 needs a legible name plus a full SSN or a mm/dd/yyyy date of birth",
        );
        rec.checks = buildI9Checks(rec);
        continue;
      }
      const itemId = `${ocrChildItemIdPrefix("i9")}-${runId}-r${idx}`;
      pmItemIds.push(itemId);
      pmItemIdToIdx.set(itemId, idx);
      pmInputs.push(chosen);
    }

    if (pmInputs.length === 0) {
      input.emitProgress(records);
      return records;
    }

    const processedItemIds = new Set<string>();
    const applyOutcome = (outcome: ChildOutcome): void => {
      const idx = pmItemIdToIdx.get(outcome.itemId);
      if (idx === undefined) return;
      processedItemIds.add(outcome.itemId);
      applyPersonMatchToI9Record(records[idx], outcome.data);
      records[idx].personMatchStatus = outcome.status === "done" ? "completed" : "failed";
      const traceId = nonEmpty(outcome.terminalEntry?.data?.__traceId);
      if (traceId) records[idx].personMatchTraceId = traceId;
      records[idx].checks = buildI9Checks(records[idx]);
      log.step({
        message: `[i9/person-match] record ${idx} status=${records[idx].personMatchStatus ?? "unknown"} childStatus=${outcome.status} found=${records[idx].ucpathFound === undefined ? "" : String(records[idx].ucpathFound)} itemId=${outcome.itemId} traceId=${records[idx].personMatchTraceId ?? ""}`,
        category: "ocr",
        occasion: outcome.status === "done" ? "completed" : "failed",
        childWorkflow: "person-match",
        subject: `record:${idx}`,
      });
      input.emitProgress(records);
    };

    // Shared dispatch→watch→cascade-cancel pipeline (BM-1). `onDispatched`
    // stamps each record `pending` + its child trace id before the watch
    // begins; `onProgress` patches each record as its child terminates.
    //
    // A watch TIMEOUT is not an operator abort — degrade gracefully to a
    // partial report (records that settled are already stamped; the rest are
    // marked failed below). Operator-abort errors are NOT caught here — they
    // propagate so the prep unwinds as cancelled (same as verify).
    const watchResult = await fanOutAndWatch<I9PersonMatchInput>({
      sessionId,
      runId,
      parentRunId: runId,
      trackerDir,
      date,
      child: personMatchWorkflow as never,
      watchWorkflow: "person-match",
      children: pmInputs.map((inp, i) => ({ input: inp, itemId: pmItemIds[i] ?? "" })),
      timeoutMs:
        typeof process !== "undefined" && process.env["OCR_I9_WATCH_TIMEOUT_MS"]
          ? Number(process.env["OCR_I9_WATCH_TIMEOUT_MS"])
          : 30 * 60_000,
      ...(rootTracePrefix ? { rootTracePrefix } : {}),
      ...(enrichDaemonFlags.parallel ? { daemonFlags: enrichDaemonFlags } : {}),
      shouldAbort,
      onDispatched: (results) => {
        for (const result of results) {
          const idx = pmItemIdToIdx.get(result.itemId);
          if (idx === undefined) continue;
          records[idx].personMatchStatus = "pending";
          records[idx].personMatchTraceId = buildTraceId({
            code: "pm",
            runId: result.runId,
            at: new Date(),
            rootPrefix: rootTracePrefix,
          });
          log.step({
            message: `[i9/person-match] record ${idx} status=pending itemId=${result.itemId} traceId=${records[idx].personMatchTraceId ?? ""}`,
            category: "ocr",
            occasion: "started",
            childWorkflow: "person-match",
            subject: `record:${idx}`,
          });
        }
        input.emitProgress(records);
      },
      onProgress: (outcome) => applyOutcome(outcome),
    }).catch((err: unknown): FanOutResult => {
      if (isOperatorDiscardAbortError(err)) throw err; // operator cancel — rethrow
      // Timeout (or other non-abort watch failure): mark all unprocessed
      // children as failed and degrade to a partial report.
      const timedOut = pmItemIds.filter((id) => !processedItemIds.has(id));
      log.warn({
        message: `[i9/person-match] watch timed out — ${timedOut.length} of ${pmItemIds.length} matches did not settle: ${timedOut.join(", ")}`,
        category: "ocr",
        occasion: "failed",
        childWorkflow: "person-match",
        subject: "i9-enrichment",
      });
      return { outcomes: [], byItemId: new Map(), missingItemIds: timedOut };
    });
    const { outcomes, missingItemIds } = watchResult;

    for (const outcome of outcomes) {
      if (processedItemIds.has(outcome.itemId)) continue;
      applyOutcome(outcome);
    }

    for (const itemId of missingItemIds) {
      const idx = pmItemIdToIdx.get(itemId);
      if (idx === undefined) continue;
      records[idx].personMatchStatus = "failed";
      records[idx].warnings.push("UCPath person match timed out without a result");
      records[idx].checks = buildI9Checks(records[idx]);
      log.warn({
        message: `[i9/person-match] record ${idx} status=failed reason=timeout itemId=${itemId} traceId=${records[idx].personMatchTraceId ?? ""}`,
        category: "ocr",
        occasion: "failed",
        childWorkflow: "person-match",
        subject: `record:${idx}`,
      });
    }

    // Recompute checks + finalize match state for every record. "Resolved"
    // means the UCPath question was ANSWERED (found true OR false) — a failed
    // / skipped / timed-out record stays unresolved.
    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      rec.checks = buildI9Checks(rec);
      if (rec.matchState !== "unresolved" || rec.personMatchStatus) {
        rec.matchState = rec.ucpathFound === undefined ? "unresolved" : "resolved";
      }
    }

    const completed = records.filter((rec) => rec.personMatchStatus === "completed").length;
    const failed = records.filter((rec) => rec.personMatchStatus === "failed").length;
    const found = records.filter((rec) => rec.ucpathFound === true).length;
    const notFound = records.filter((rec) => rec.ucpathFound === false).length;
    log.success({
      message: `[i9/enrich] complete records=${records.length} completed=${completed} failed=${failed} found=${found} notFound=${notFound}`,
      category: "ocr",
      occasion: "completed",
      subject: "i9-enrichment",
    });

    input.emitProgress(records);
    return records;
  },
};
