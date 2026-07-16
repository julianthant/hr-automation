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
import { isChildWatchError, type ChildOutcome } from "../../../tracker/delegation/watch-child-runs.js";
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
  /**
   * Section 1 fields that ARE written on the paper but could NOT be read with
   * confidence. Distinct from `originallyMissing` (genuinely blank).
   *
   * This is the field that stops a fabricated value: a scan too degraded to
   * read used to produce a confident-looking SSN/DOB anyway (live 2026-07-13,
   * page 51 — the paper is illegible and the model emitted `02/28/1972` +
   * `619-22-1272`), which then searched UCPath and returned a false "not
   * found". Now the value comes back null and the field is named here.
   */
  illegible: z.array(z.string()).default([]),
  /**
   * SECTION 2 pages only (`formKind: "unknown"`): the employee name the
   * EMPLOYER re-writes at the top of Section 2. An independent second reading
   * of the same person, in the same packet.
   */
  section2Name: z.string().nullable().optional(),
  /**
   * SECTION 2 pages only: the List C document number when the List C document
   * is a Social Security card — i.e. the SSN, written by the employer.
   *
   * On 4 of the 5 audited pages where it appears, this value CONFIRMED the
   * paper and CONTRADICTED our Section 1 OCR. It is the cheapest independent
   * check available and it was sitting unused in the same PDF.
   */
  section2DocNumber: z.string().nullable().optional(),
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
  /**
   * The pool cell (`<provider>-<keyIndex>:<model>`) that produced this read —
   * stamped by the orchestrator. Without it an extraction cannot be attributed
   * to the model that made it, and per-model accuracy is unmeasurable (see the
   * orchestrator's attribution step). Updated when a second opinion is adopted.
   */
  extractedBy: z.string().optional(),
  /**
   * Result of cross-checking this Section 1 against the employer's Section 2
   * sheet for the same person (see `corroborateI9Records`).
   *
   * - `confirmed`  — an independent second source agrees with what we read.
   * - `disputed`   — the two sources DISAGREE on a field. The read is confidently
   *                  wrong somewhere, so a "not found" from it means nothing.
   * - `unavailable`— no Section 2 sheet to check against (can't corroborate).
   */
  corroboration: z.enum(["confirmed", "disputed", "unavailable"]).default("unavailable"),
  /** Fields where Section 1 and Section 2 disagree — never trusted for a search. */
  disputedFields: z.array(z.string()).default([]),
  /** A Section 2 sheet whose person has no Section 1 page anywhere in the packet. */
  orphanSection2: z.boolean().default(false),
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
  { "formKind": "i9", "sourcePage": 1, "lastName": "Doe", "firstName": "Jane", "middleInitial": "A", "dateOfBirth": "04/01/1998", "ssn": "123-45-6789", "documentType": "expected", "originallyMissing": [], "illegible": [], "section2Name": null, "section2DocNumber": null, "notes": [] },
  { "formKind": "unknown", "sourcePage": 2, "lastName": null, "firstName": null, "middleInitial": null, "dateOfBirth": null, "ssn": null, "documentType": "unknown", "originallyMissing": [], "illegible": [], "section2Name": "Doe, Jane A", "section2DocNumber": "123-45-6789", "notes": [] }
]
\`\`\`

Do NOT wrap records in a page object. Do NOT nest under "records" or "data" keys. The top-level value MUST be a JSON array. Each element is exactly one record.

═══ ACCURACY RULE — READ THIS FIRST ═══
These values are used to search a real HR system. A single wrong DIGIT does not
produce a wrong answer — it produces NO answer, which is indistinguishable from
"this person does not work here". A guess is therefore WORSE than an admission.

So, for the SSN and the DATE OF BIRTH specifically:
- Transcribe ONLY digits you can actually SEE. Do not infer, complete, or
  "clean up" a number. Do not assume a plausible value.
- If ANY digit of the SSN is smudged, cut off, overwritten, ambiguous, or you
  are otherwise not confident of it: set the WHOLE field to null and add the
  field name to "illegible". The same for the date of birth.
- Handwritten digits in boxed fields are commonly confused: 0/6, 9/4, 8/9, 1/7,
  3/5. If you are choosing between two digits, you are NOT confident — null it
  and list it in "illegible".
- Never round a 2-digit year into a century. If the year is written "94", that
  is not "1974" and not "1994" — report what you see or null it.
It is CORRECT and EXPECTED to return null here. A null costs the operator one
manual check. A wrong digit silently reports a real employee as a stranger.

For EVERY record:
- formKind: "i9" when the page shows Section 1 employee fields; "unknown" otherwise.
- sourcePage: the 1-indexed page number.
- lastName / firstName / middleInitial: the SECTION 1 employee name fields ONLY (labeled "Last Name (Family Name)", "First Name (Given Name)", "Middle Initial"). Do NOT copy names from Section 2 (the employer/authorized representative) or from document titles in the Lists of Acceptable Documents. Attempt a best-guess transcription of handwritten NAMES — speak the name out loud as you read it — but transcribe the WHOLE name: do not drop a trailing letter ("Kimi" is not "Kim") and do not drop a compound surname ("Torres Perez" is not "Perez"). If the name is genuinely unreadable, null it and add "lastName"/"firstName" to "illegible". Only set null WITHOUT listing it in "illegible" when the field is genuinely BLANK.
- dateOfBirth: the Section 1 "Date of Birth (mm/dd/yyyy)" value, exactly as printed. Subject to the ACCURACY RULE above. Do NOT confuse it with the employee's signature date or the employment start date.
- ssn: the Section 1 "U.S. Social Security Number" value. Subject to the ACCURACY RULE above. Null when blank, masked, or not confidently legible.
- documentType: "expected" for an I-9 Section 1 page; "unknown" for anything else.
- originallyMissing: expected field names that were genuinely BLANK on the paper. Use [] when nothing was missing.
- illegible: field names that ARE written on the paper but you could NOT read confidently ("ssn", "dateOfBirth", "lastName", "firstName"). Use [] when everything was legible. NEVER put a field in both "originallyMissing" and "illegible".
- notes: free-form observations, or [].

SECTION 2 PAGES (formKind "unknown" — the employer's "Section 2. Employer Review and Verification" sheet).
These pages independently repeat the SAME employee's identity, so they are our cross-check. On such a page ALSO fill:
- section2Name: the employee name written at the TOP of Section 2 ("Employee Info from Section 1" / Last Name, First Name, M.I.). Null if not present.
- section2DocNumber: the "Document Number" under LIST C **only when the List C document is a Social Security card** (its title mentions "Social Security"). That number IS the employee's SSN as written by the employer — transcribe its digits exactly, subject to the ACCURACY RULE. Null when the List C document is anything else (birth certificate, etc.), when it is blank, or when the digits are not confidently legible.
Leave section2Name / section2DocNumber null on every page that is NOT a Section 2 sheet.

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

// ─── Section 2 corroboration ─────────────────────────────────

/** Identity tokens of a name, lowercased — order-independent. */
function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .split(/[\s-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1),
  );
}

/** Do two names refer to the same person? Any shared token ≥2 chars. */
export function i9NamesShareToken(a: string, b: string): boolean {
  const ta = nameTokens(a);
  if (ta.size === 0) return false;
  for (const t of nameTokens(b)) if (ta.has(t)) return true;
  return false;
}

/** Bare digits of an SSN-ish string, or "" when it isn't 9 digits. */
function ssnDigits(v: unknown): string {
  const raw = nonEmpty(v);
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  return /^\d{9}$/.test(d) ? d : "";
}

/**
 * Cross-check every Section 1 read against the employer's Section 2 sheet for
 * the same person — an INDEPENDENT second transcription of the same identity,
 * already sitting in the same PDF and, until now, thrown away.
 *
 * Why this exists: the I-9 check's only real failure mode is a confidently
 * wrong read. UCPath answers "no results" for a wrong SSN digit exactly as it
 * does for a person who truly isn't there, so a bad extraction is invisible —
 * it looks like an answer. The second-opinion machinery could not catch it
 * either: it only re-reads records it can't SEARCH, and a wrong-but-searchable
 * record sails through. Section 2 is the missing oracle. (Live 2026-07-13: of
 * the 5 packet pages where the employer recorded the SSN under List C, 4
 * contradicted our Section 1 OCR and matched the paper.)
 *
 * Pairing is by NAME, not page position — a packet can be missing a sheet, so
 * an offset assumption would silently pair the wrong people. A Section 2 sheet
 * matches a Section 1 record when their names share an identity token, which
 * survives exactly the kind of partial misread we're hunting ("Miralik" vs
 * "Mihalik" still share "joshua").
 *
 * Stamps `corroboration` / `disputedFields` on each Section 1 record, flags
 * orphan Section 2 sheets (an employee whose Section 1 page is missing from the
 * packet — a real document-set gap the operator otherwise never sees), and
 * pushes a legible warning per finding. Pure — mutates and returns `records`.
 */
export function corroborateI9Records(records: I9PreviewRecord[]): I9PreviewRecord[] {
  const sheets = records.filter(
    (r) => r.formKind !== "i9" && nonEmpty(r.section2Name) !== null,
  );
  const claimed = new Set<I9PreviewRecord>();

  for (const rec of records) {
    if (rec.formKind !== "i9") continue;
    const ourName = nonEmpty(rec.name) ?? buildI9DisplayName(rec);
    const sheet = ourName
      ? sheets.find((s) => !claimed.has(s) && i9NamesShareToken(ourName, s.section2Name ?? ""))
      : undefined;
    if (!sheet) {
      rec.corroboration = "unavailable";
      rec.disputedFields = [];
      continue;
    }
    claimed.add(sheet);

    const disputed: string[] = [];

    // SSN: the employer's List C number is an independent transcription.
    const ours = ssnDigits(rec.ssn);
    const theirs = ssnDigits(sheet.section2DocNumber);
    if (ours && theirs && ours !== theirs) {
      disputed.push("ssn");
      rec.warnings.push(
        `SSN disagrees with the employer's Section 2 (page ${sheet.sourcePage}): Section 1 reads ${maskSsn(ours)}, `
        + `Section 2 List C reads ${maskSsn(theirs)}. The SSN was NOT used to search UCPath — verify it against the scan.`,
      );
    }

    // Name: a partial misread ("Kim" for "Kimi") still shares a token, so the
    // pairing holds while the surname/given-name mismatch is surfaced.
    const s2 = sheet.section2Name ?? "";
    const ourLast = nonEmpty(rec.lastName);
    if (ourLast && s2 && !nameTokens(s2).has(ourLast.toLowerCase())) {
      disputed.push("lastName");
      rec.warnings.push(
        `Last name disagrees with the employer's Section 2 (page ${sheet.sourcePage}): `
        + `Section 1 reads "${ourLast}", Section 2 reads "${s2}". Verify against the scan.`,
      );
    }

    rec.disputedFields = disputed;
    rec.corroboration = disputed.length > 0 ? "disputed" : "confirmed";
  }

  // A Section 2 sheet nobody claimed = an employee in the packet with no
  // Section 1 page. Not an OCR error — a missing document. Surface it.
  for (const sheet of sheets) {
    if (claimed.has(sheet)) continue;
    sheet.orphanSection2 = true;
    sheet.warnings.push(
      `Section 2 for "${sheet.section2Name}" is in the packet but its Section 1 page is NOT — `
      + `this person could not be checked against UCPath. Locate the missing Section 1 page.`,
    );
  }
  return records;
}

/** Never log or display a whole SSN — first 3 + last 2, the rest masked. */
function maskSsn(digits: string): string {
  return `${digits.slice(0, 3)}-**-*${digits.slice(-2)}`;
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
 * A field the employer's Section 2 sheet CONTRADICTS is never searched with.
 * UCPath matches on the criteria you give it, so one wrong SSN digit returns
 * "no results" — a false "this person does not work here". When the two
 * transcriptions disagree we do not pick a winner (that would be a coin-flip
 * substitution of real HR data); we drop the disputed identifier and search on
 * what still holds — name + DOB, which is proven to find real people. The
 * dispute rides the record as a warning for the operator to settle.
 *
 * Pure — no IO.
 */
export function buildI9PersonMatchInput(
  rec: Pick<I9PreviewRecord, "lastName" | "firstName" | "dateOfBirth" | "ssn">
    & { disputedFields?: string[] },
  ctx: { parentSubject?: string },
): I9PersonMatchInput | null {
  const lastName = nonEmpty(rec.lastName);
  const firstName = nonEmpty(rec.firstName);
  if (!lastName || !firstName) return null;
  const disputed = new Set(rec.disputedFields ?? []);
  const ssn = disputed.has("ssn") ? null : normalizeI9Ssn(rec.ssn);
  const dob = disputed.has("dateOfBirth") ? null : normalizeI9Dob(rec.dateOfBirth);
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
 * Second-opinion rank for one i9 record — orders extraction QUALITY by what
 * the UCPath person search can do with it (higher = better): 1 = unsearchable
 * (no legible name, or neither a 9-digit SSN nor a mm/dd/yyyy DOB), 2 =
 * searchable by DOB only, 3 = searchable with an SSN. i9 has no roster
 * oracle, so searchability is the misread signature the tier-1 re-read is
 * anchored on: a weak-tier model mangling any Section 1 field turns the whole
 * UCPath check into a false "not found". Pure — exported for tests.
 */
export function i9SecondOpinionRank(
  rec: Pick<I9PreviewRecord, "lastName" | "firstName" | "dateOfBirth" | "ssn">
    & { disputedFields?: string[] },
): number {
  const input = buildI9PersonMatchInput(rec, {});
  if (!input) return 1;
  return input.ssn ? 3 : 2;
}

/**
 * Suspect = an i9 page whose Section 1 read cannot be TRUSTED, not merely one
 * that cannot be SEARCHED.
 *
 * The old rule (unsearchable only) was the reason the second opinion never
 * fired on the run that motivated all of this: all 17 misread records were
 * perfectly searchable — just wrong — so none of them qualified. A page the
 * model itself flagged as `illegible` is the highest-yield re-read there is:
 * the first model told us it could not read a field, and a stronger tier
 * routinely can. Recovering that field also RAISES the searchability rank,
 * which is exactly the gate the orchestrator adopts a re-read on.
 */
export function isI9SecondOpinionSuspect(rec: I9PreviewRecord): boolean {
  if (rec.formKind !== "i9") return false;
  return i9SecondOpinionRank(rec) === 1 || (rec.illegible ?? []).length > 0;
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
      illegible: record.illegible ?? [],
      notes: record.notes ?? [],
      matchState: "extracted",
      selected: true,
      warnings: [],
      checks: [],
      // Corroboration is decided later, by `corroborateI9Records` in
      // `enrichRecords` — it needs the WHOLE packet (a record's Section 2 sheet
      // is a different page), so a single-record match cannot know it yet.
      corroboration: "unavailable",
      disputedFields: [],
      orphanSection2: false,
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
  // A delegated run (under the separations operation coordinator) completes
  // `done` right after the person-match enrichment instead of parking at
  // awaiting-approval: there is nothing to approve, and the prepare route's
  // result fan-back emits the per-person member rows into the separations
  // panel as soon as the run finishes.
  completeDelegatedRun: true,

  rosterMode: "optional",
  traceCode: "ic",

  // Roster-less second-opinion policy: without this, the orchestrator's
  // tier-1 re-read phase (gated on a loaded roster) never runs for i9, so a
  // weak-tier misread of Section 1 sails straight into the person-match
  // search. Suspect = an i9 page that is unsearchable; a re-read is adopted
  // only when it strictly improves searchability (and, when the first read
  // had a name, shares a name token with it — orchestrator identity gate).
  secondOpinion: {
    isSuspect: isI9SecondOpinionSuspect,
    reason: (rec) =>
      (rec.illegible ?? []).length > 0
        ? `the first model could not read ${rec.illegible.join(", ")} on this scan`
        : !nonEmpty(rec.lastName) || !nonEmpty(rec.firstName)
          ? "Section 1 name is missing or unreadable"
          : "has no usable SSN or mm/dd/yyyy date of birth to search UCPath",
    readName: (rec) => nonEmpty(rec.name) ?? buildI9DisplayName(rec),
    rank: i9SecondOpinionRank,
  },

  placeholderFields(): Record<string, unknown> {
    return {
      formKind: "unknown",
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: null,
      section2Name: null,
      section2DocNumber: null,
      illegible: [],
      corroboration: "unavailable",
      disputedFields: [],
      orphanSection2: false,
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

    // Cross-check every Section 1 against the employer's Section 2 sheet BEFORE
    // any of it reaches UCPath. A field the two sources disagree on is dropped
    // from the search (`buildI9PersonMatchInput`), because searching with a
    // known-suspect SSN manufactures a false "not found" — the exact failure
    // this whole path exists to avoid.
    corroborateI9Records(records);
    const corroborated = records.filter((r) => r.corroboration === "confirmed").length;
    const disputed = records.filter((r) => r.corroboration === "disputed");
    const orphans = records.filter((r) => r.orphanSection2);
    log.step({
      message:
        `[i9/corroborate] ${corroborated} record(s) confirmed by their Section 2 sheet, `
        + `${disputed.length} DISPUTED, ${orphans.length} orphan Section 2 sheet(s) (no Section 1 page in the packet)`,
      category: "ocr",
    });
    for (const rec of disputed) {
      log.warn(
        `[i9/corroborate] page ${rec.sourcePage} "${nonEmpty(rec.name) ?? buildI9DisplayName(rec)}": `
        + `Section 1 and Section 2 disagree on ${rec.disputedFields.join(", ")} — `
        + `disputed field(s) will NOT be used to search UCPath`,
      );
    }
    for (const rec of orphans) {
      log.warn(
        `[i9/corroborate] page ${rec.sourcePage}: Section 2 for "${rec.section2Name}" has no Section 1 page in this packet — that person cannot be checked`,
      );
    }
    input.emitProgress(records);

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
      if (!isChildWatchError(err) || err.kind !== "timeout") throw err;
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
