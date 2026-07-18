/**
 * OCR form spec for scanned **Form I-9** (Employment Eligibility Verification)
 * PDFs. Implements `OcrFormSpec` so OCR's orchestrator runs this form-type
 * generically.
 *
 * Like `verify`, `i9` is a READ-AND-FIND-OUT tool: it reads each I-9's
 * Section 1 (employee name, date of birth, SSN) and Section 2 (employer
 * certification: name line, List C document number, First Day of Employment),
 * pairs each person's two pages by name (`corroborateI9Records`), and matches
 * the Action History roster BY NAME. It does NOT write to UCPath and has NO
 * approve fan-out.
 *
 * The live UCPath person search does NOT run during OCR (rev. 2026-07-16 — it
 * used to fan out one person-match child per record here). When this run
 * completes, `/api/ocr/prepare` enqueues one REAL separations `i9-check`
 * member task per person (`enqueueI9CheckMemberTasks`), which searches
 * UCPath, re-matches the roster by the resolved EID, and appends the master
 * retention-tracker row. Enrichment here owns only what the packet itself can
 * answer (the orchestrator's eid-lookup fan-out is suppressed by
 * `needsLookup` always returning null).
 */
import { z } from "zod/v4";
import { log } from "../../../utils/log.js";
import {
  displayPersonName,
  normalizePersonNameForCompare,
} from "../../../domain/identity/person-name.js";
import { levenshteinDistance } from "../../matching/levenshtein.js";
import type { OcrFormSpec, LookupKind } from "../../../workflows/ocr/types.js";
import { VerifyCheckSchema, type VerifyCheck } from "./verify.js";
import {
  DocumentTypeSchema,
  MatchStateSchema,
  isForceResearchFlagRecord,
} from "./shared.js";

// ─── OCR-pass record (one page of the scanned PDF) ──────────

const I9_FORM_KINDS = ["i9 section 1", "i9 section 2", "i9 ssn", "unknown"] as const;
export type I9FormKind = (typeof I9_FORM_KINDS)[number];

/**
 * `formKind` tolerant coercion — mirrors verify's `VerifyFormKindSchema`
 * precedent: a PRESENT-but-unrecognized string (model hallucination/typo) must
 * not fail `safeParse` and silently drop the WHOLE record from operator review
 * (root CLAUDE.md "fail loud — no unverified silent fallbacks": losing the
 * record is worse than one wrong-looking label on it). Coerce any unrecognized
 * value to "unknown" and `log.warn` it; `undefined`/missing is the ordinary
 * "model omitted the field" case and does not warn. The legacy 2-way vocabulary
 * (pre-2026-07-17: `"i9"` = a Section 1 page, Section 2 sheets rode "unknown"
 * with `section2Name`) normalizes on read: `"i9"` → `"i9 section 1"`.
 */
const I9FormKindSchema = z.preprocess((v) => {
  if (typeof v === "string" && (I9_FORM_KINDS as readonly string[]).includes(v)) return v;
  if (v === "i9") return "i9 section 1"; // legacy rows / model shorthand
  if (v !== undefined) {
    log.warn(
      `[i9] unrecognized formKind ${JSON.stringify(v)} — coercing to "unknown" so the record still surfaces for review`,
    );
  }
  return "unknown";
}, z.enum(I9_FORM_KINDS));

/** Is this record a Section 1 (employee attestation) page? */
export function isI9Section1(rec: { formKind?: string | null }): boolean {
  return rec.formKind === "i9 section 1";
}

export const I9OcrRecordSchema = z.object({
  formKind: I9FormKindSchema,
  sourcePage: z.number().int().positive(),
  /**
   * Employee last name (family name) — UNIFORM across page kinds: the Section 1
   * name fields on a `"i9 section 1"` page, the employer-written "Employee Last
   * Name, First Name and Middle Initial from Section 1" line on a
   * `"i9 section 2"` sheet, the employee-name line on an `"i9 ssn"` sheet.
   */
  lastName: z.string().nullable().optional(),
  /** Employee first name (given name) — same per-kind sourcing as lastName. */
  firstName: z.string().nullable().optional(),
  /** Middle initial — same per-kind sourcing as lastName. */
  middleInitial: z.string().nullable().optional(),
  /** Section 1 date of birth, as printed (mm/dd/yyyy). Null on other kinds. */
  dateOfBirth: z.string().nullable().optional(),
  /**
   * The SSN this page carries, as printed — UNIFORM across page kinds:
   * Section 1 → the employee-written "U.S. Social Security Number"; Section 2 →
   * the List C document number ONLY when the List C document is a Social
   * Security card (the employer's independent transcription — on 4 of the 5
   * audited pages where it appeared it CONFIRMED the paper and CONTRADICTED our
   * Section 1 OCR); `"i9 ssn"` sheet → the sheet's Social Security Number field.
   */
  ssn: z.string().nullable().optional(),
  /**
   * The employment-start date this page carries, as printed: Section 2 →
   * "First Day of Employment (mm/dd/yyyy)"; `"i9 ssn"` sheet → its "Date of
   * Hire". Null on Section 1 pages (`corroborateI9Records` copies it onto the
   * paired Section 1 record from the sheet).
   */
  hireDate: z.string().nullable().optional(),
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
  /**
   * Fields that ARE written on the paper but could NOT be read with
   * confidence. Distinct from `originallyMissing` (genuinely blank).
   *
   * This is the field that stops a fabricated value: a scan too degraded to
   * read used to produce a confident-looking SSN/DOB anyway (live 2026-07-13,
   * page 51 — the paper is illegible and the model emitted `02/28/1972` +
   * `619-22-1272`), which then searched UCPath and returned a false "not
   * found". Now the value comes back null and the field is named here.
   */
  illegible: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type I9OcrRecord = z.infer<typeof I9OcrRecordSchema>;

export const I9OcrOutputSchema = z.array(I9OcrRecordSchema);
export type I9OcrOutput = z.infer<typeof I9OcrOutputSchema>;

// ─── Preview record (in-flight, post-match + post-enrichment) ──

export const I9PreviewRecordSchema = I9OcrRecordSchema.extend({
  /** Display name ("Last, First M") assembled from the Section 1 name fields. */
  name: z.string().default(""),
  /**
   * @deprecated No longer stamped (2026-07-16): the UCPath person search moved
   * out of OCR enrichment into the separations i9-check member tasks, whose
   * verdicts live on the member rows. Kept so historical records still parse.
   */
  ucpathFound: z.boolean().optional(),
  /** @deprecated See `ucpathFound` — historical rows only. */
  matchedEmplId: z.string().optional(),
  /** @deprecated See `ucpathFound` — historical rows only. */
  matchedName: z.string().optional(),
  /**
   * @deprecated Pre-2026-07-17 sheet fields. Section 2 / SSN-sheet data now
   * rides the UNIFORM record fields (`lastName`/`firstName`/`ssn`/`hireDate`)
   * on the sheet's own record; these remain only so historical JSONL rows
   * still parse. Never written by the current prompt or enrichment.
   */
  section2Name: z.string().nullable().optional(),
  /** @deprecated See `section2Name` — historical rows only. */
  section2DocNumber: z.string().nullable().optional(),
  /** @deprecated See `section2Name` — historical rows only. */
  section2HireDate: z.string().nullable().optional(),
  /**
   * Page of the Section 1 record this SHEET (`"i9 section 2"` / `"i9 ssn"`)
   * was paired to — the reverse link of `section2Page`/`ssnPage`, stamped by
   * `corroborateI9Records`. Absent on Section 1 records and orphan sheets.
   */
  section1Page: z.number().optional(),
  /**
   * Page of the Section 2 sheet paired to this Section 1, when one was found.
   * Presence of this field IS "Section 2 present" — the operator needs to know
   * whether a verdict rests on one page or two corroborating ones, and which
   * page to open when it doesn't.
   */
  section2Page: z.number().optional(),
  /**
   * Page of the SSN-bearing supplemental sheet (`"i9 ssn"`, e.g. a UCRS 419
   * statement) paired to this Section 1, when one exists in the packet.
   */
  ssnPage: z.number().optional(),
  /** PPS EID from the Employee Action History cross-ref roster (display: zeros stripped). */
  ppsEid: z.string().optional(),
  /** Roster PPS ID verbatim, leading zeros preserved — the spreadsheet form. */
  ppsEidPadded: z.string().optional(),
  /** UCPath Empl ID from the Action History roster (when live match missed). */
  rosterEmplId: z.string().optional(),
  /** Separation / Job End Date from the Action History TER row. */
  i9SeparationDate: z.string().optional(),
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
  /** @deprecated No person-match children run during OCR anymore — historical rows only. */
  personMatchStatus: z.enum(["pending", "running", "completed", "failed"]).optional(),
  /** @deprecated See `personMatchStatus` — historical rows only. */
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

The PDF is a stack of scanned USCIS Form I-9 (Employment Eligibility Verification) documents. Classify each page as exactly one of:
- "i9 section 1" — a Form I-9 page whose SECTION 1 (Employee Information and Attestation) is visible: it carries the employee's last name, first name, middle initial, date of birth, and U.S. Social Security Number.
- "i9 section 2" — the employer's "Section 2. Employer or Authorized Representative Review and Verification" sheet: it re-writes the employee's name at the top, lists the documents examined (Lists A/B/C), and carries "The employee's first day of employment".
- "i9 ssn" — an SSN-bearing SUPPLEMENTAL sheet about one employee that is not an I-9 page itself, e.g. a UCRS 419 "Statement Concerning Your Employment in a University Position Not Covered by Social Security": it carries the employee's name, Social Security Number, and a date of hire.
- "unknown" — anything else: Lists of Acceptable Documents, instructions, blank or irrelevant pages.

For each page produce exactly one record. Every record has the SAME fields; which ones are filled depends on the page kind.

OUTPUT SHAPE (CRITICAL — must be a FLAT JSON ARRAY at the top level):

\`\`\`json
[
  { "formKind": "i9 section 1", "sourcePage": 1, "lastName": "Doe", "firstName": "Jane", "middleInitial": "A", "dateOfBirth": "04/01/1998", "ssn": "123-45-6789", "hireDate": null, "documentType": "expected", "originallyMissing": [], "illegible": [], "notes": [] },
  { "formKind": "i9 section 2", "sourcePage": 2, "lastName": "Doe", "firstName": "Jane", "middleInitial": "A", "dateOfBirth": null, "ssn": "123-45-6789", "hireDate": "04/17/2018", "documentType": "expected", "originallyMissing": [], "illegible": [], "notes": [] },
  { "formKind": "unknown", "sourcePage": 3, "lastName": null, "firstName": null, "middleInitial": null, "dateOfBirth": null, "ssn": null, "hireDate": null, "documentType": "unknown", "originallyMissing": [], "illegible": [], "notes": [] }
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
- formKind: one of "i9 section 1", "i9 section 2", "i9 ssn", "unknown" per the classification above.
- sourcePage: the 1-indexed page number.
- lastName / firstName / middleInitial: the EMPLOYEE's name as THIS PAGE writes it. On "i9 section 1": the Section 1 name fields ONLY (labeled "Last Name (Family Name)", "First Name (Given Name)", "Middle Initial"). On "i9 section 2": the "Employee Last Name, First Name and Middle Initial from Section 1" line at the TOP of the sheet — NEVER the employer/authorized representative's own name from the Certification block. On "i9 ssn": the sheet's employee-name field. Attempt a best-guess transcription of handwritten NAMES — speak the name out loud as you read it — but transcribe the WHOLE name: do not drop a trailing letter ("Kimi" is not "Kim") and do not drop a compound surname ("Torres Perez" is not "Perez"). If the name is genuinely unreadable, null it and add "lastName"/"firstName" to "illegible". Only set null WITHOUT listing it in "illegible" when the field is genuinely BLANK. All three are null on "unknown" pages.
- dateOfBirth: the Section 1 "Date of Birth (mm/dd/yyyy)" value, exactly as printed. Subject to the ACCURACY RULE above. Do NOT confuse it with the employee's signature date or the employment start date. Null on every other page kind.
- ssn: the SSN THIS PAGE carries, subject to the ACCURACY RULE above; null when blank, masked, or not confidently legible. On "i9 section 1": the "U.S. Social Security Number" value. On "i9 section 2": the "Document Number" under LIST C **only when the List C document is a Social Security card** (its title mentions "Social Security" / "SS") — that number IS the employee's SSN as written by the employer; null when List C is anything else (birth certificate, etc.). On "i9 ssn": the sheet's Social Security Number field.
- hireDate: the employment-start date THIS PAGE carries, exactly as printed, subject to the ACCURACY RULE (same digit discipline as dateOfBirth). On "i9 section 2": "The employee's first day of employment (mm/dd/yyyy)" from the Certification block. On "i9 ssn": the sheet's "Date of Hire". Null on "i9 section 1" and "unknown" pages, and when blank or illegible.
- documentType: "expected" for any real I-9 / SSN-sheet page ("i9 section 1", "i9 section 2", "i9 ssn"); "unknown" for anything else.
- originallyMissing: expected field names that were genuinely BLANK on the paper. Use [] when nothing was missing.
- illegible: field names that ARE written on the paper but you could NOT read confidently ("ssn", "dateOfBirth", "lastName", "firstName", "hireDate"). Use [] when everything was legible. NEVER put a field in both "originallyMissing" and "illegible".
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

/**
 * Display name ("Last, First M") from the Section 1 name fields, normalized to
 * the standard title-cased display convention via `displayPersonName` — I-9s
 * are frequently hand-printed ALL-CAPS ("QIAO, WANHUI" → "Qiao, Wanhui"), and
 * this name rides everywhere: the review pane, the member row title, and the
 * retention-tracker spreadsheet. Comparison paths are unaffected (they all
 * lowercase via `normalizePersonNameForCompare` / `nameTokens`).
 */
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
  return displayPersonName(last && given ? `${last}, ${given}` : (last ?? given ?? ""));
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

/** Below this, two tokens are unrelated and contribute nothing to a pair score. */
const TOKEN_MATCH_FLOOR = 0.6;
/** Below this, a Section 1 / Section 2 pairing is not credible. */
const MIN_PAIR_SCORE = 0.45;

/** 0..1 similarity of two name tokens, tolerant of a misread character or two. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  return 1 - levenshteinDistance(a, b) / max;
}

/**
 * 0..1 similarity between a Section 1 name and a Section 2 name line.
 *
 * Every employee has BOTH a Section 1 and a Section 2 page, but they are not
 * adjacent in a scanned packet and BOTH names are independently misread — so
 * pairing must tolerate character-level damage ("Miralik"/"Mihalik") while
 * still separating two DIFFERENT people who happen to share a token.
 *
 * That last part is why a boolean "share any token" test is not enough:
 * `Tsai, Nien Chen` and `Weng, Nien-Chen` both contain "nien", so the first
 * one scanned would claim the other's sheet (live 2026-07-16 — Weng's Section 1
 * was paired to Tsai's sheet, producing a phantom last-name dispute, while
 * Weng's real sheet on page 50 was reported as an orphan). A SCORE lets the
 * pairing compare alternatives and give each sheet to its best claimant.
 */
export function i9NamePairScore(a: string, b: string): number {
  const ta = [...nameTokens(a)];
  const tb = [...nameTokens(b)];
  if (ta.length === 0 || tb.length === 0) return 0;
  let total = 0;
  for (const t of ta) {
    let best = 0;
    for (const u of tb) best = Math.max(best, tokenSimilarity(t, u));
    if (best >= TOKEN_MATCH_FLOOR) total += best;
  }
  // Normalize by the LONGER token list so extra tokens on either side dilute
  // the score rather than inflate it.
  return total / Math.max(ta.length, tb.length);
}

/** The employee name a SHEET record carries (its own uniform name fields). */
export function i9SheetName(sheet: I9PreviewRecord): string {
  return nonEmpty(sheet.name) ?? buildI9DisplayName(sheet);
}

/**
 * Assign each Section 2 / SSN sheet to the Section 1 record it best matches.
 *
 * Best-first over ALL candidate pairs (not first-fit in page order), so an
 * exact match always outranks a coincidental token collision, and each sheet
 * and record is claimed at most once.
 */
export function pairI9Section2Sheets(
  section1s: I9PreviewRecord[],
  sheets: I9PreviewRecord[],
): Map<I9PreviewRecord, I9PreviewRecord> {
  const scored: Array<{ rec: I9PreviewRecord; sheet: I9PreviewRecord; score: number }> = [];
  for (const rec of section1s) {
    const ourName = nonEmpty(rec.name) ?? buildI9DisplayName(rec);
    if (!ourName) continue;
    for (const sheet of sheets) {
      const score = i9NamePairScore(ourName, i9SheetName(sheet));
      if (score >= MIN_PAIR_SCORE) scored.push({ rec, sheet, score });
    }
  }
  // Highest score first; ties broken by page proximity, which for a scanned
  // packet is a genuine (if weak) signal that two pages belong together.
  scored.sort(
    (x, y) =>
      y.score - x.score
      || Math.abs(x.rec.sourcePage - x.sheet.sourcePage)
        - Math.abs(y.rec.sourcePage - y.sheet.sourcePage),
  );

  const paired = new Map<I9PreviewRecord, I9PreviewRecord>();
  const claimedSheets = new Set<I9PreviewRecord>();
  for (const { rec, sheet, score: _score } of scored) {
    if (paired.has(rec) || claimedSheets.has(sheet)) continue;
    paired.set(rec, sheet);
    claimedSheets.add(sheet);
  }
  return paired;
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
    (r) => r.formKind === "i9 section 2" && i9SheetName(r) !== "",
  );
  const ssnSheets = records.filter(
    (r) => r.formKind === "i9 ssn" && i9SheetName(r) !== "",
  );
  // Every employee has BOTH pages somewhere in the packet — pair them globally,
  // best match first, rather than first-fit in page order.
  const section1s = records.filter((r) => isI9Section1(r));
  const pairs = pairI9Section2Sheets(section1s, sheets);
  const ssnPairs = pairI9Section2Sheets(section1s, ssnSheets);
  const claimed = new Set<I9PreviewRecord>(pairs.values());
  const claimedSsn = new Set<I9PreviewRecord>(ssnPairs.values());

  for (const rec of records) {
    if (!isI9Section1(rec)) continue;
    const sheet = pairs.get(rec);
    const ssnSheet = ssnPairs.get(rec);
    if (!sheet && !ssnSheet) {
      rec.corroboration = "unavailable";
      rec.disputedFields = [];
      continue;
    }

    const disputed: string[] = [];
    // Compare against every sheet this person has — the Section 2 sheet and
    // (rarely) an SSN supplemental sheet are each an independent transcription.
    for (const [kindLabel, s] of [
      ["Section 2", sheet],
      ["SSN sheet", ssnSheet],
    ] as const) {
      if (!s) continue;
      if (kindLabel === "Section 2") {
        rec.section2Page = s.sourcePage;
      } else {
        rec.ssnPage = s.sourcePage;
      }
      s.section1Page = rec.sourcePage;

      // SSN: the sheet's number (Section 2 List C / the SSN sheet's own field)
      // is an independent transcription of the same identity.
      const ours = ssnDigits(rec.ssn);
      const theirs = ssnDigits(s.ssn);
      if (ours && theirs && ours !== theirs && !disputed.includes("ssn")) {
        disputed.push("ssn");
        rec.warnings.push(
          `SSN disagrees with the employer's ${kindLabel} (page ${s.sourcePage}): Section 1 reads ${maskSsn(ours)}, `
          + `the ${kindLabel} reads ${maskSsn(theirs)}. The SSN was NOT used to search UCPath — verify it against the scan.`,
        );
      }

      // Name: a partial misread ("Kim" for "Kimi") still shares a token, so the
      // pairing holds while the surname/given-name mismatch is surfaced.
      const sheetName = i9SheetName(s);
      const ourLast = nonEmpty(rec.lastName);
      if (ourLast && sheetName && !nameTokens(sheetName).has(ourLast.toLowerCase()) && !disputed.includes("lastName")) {
        disputed.push("lastName");
        rec.warnings.push(
          `Last name disagrees with the employer's ${kindLabel} (page ${s.sourcePage}): `
          + `Section 1 reads "${ourLast}", the ${kindLabel} reads "${sheetName}". Verify against the scan.`,
        );
      }

      // Hire date rides the sheets only — copy onto the Section 1 record so the
      // completeness report / Action History grid can show "Hire Date (from I-9)".
      // Section 2's "first day of employment" wins over an SSN sheet's date of hire.
      const hire = nonEmpty(s.hireDate);
      if (hire && (kindLabel === "Section 2" || !nonEmpty(rec.hireDate))) {
        rec.hireDate = normalizeI9Dob(hire) ?? hire;
      }
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
      `Section 2 for "${i9SheetName(sheet)}" is in the packet but its Section 1 page is NOT — `
      + `this person could not be checked against UCPath. Locate the missing Section 1 page.`,
    );
  }
  // An unclaimed SSN sheet is softer — the person may simply have no I-9 pages
  // in this packet — but still worth a legible flag, never a silent drop.
  for (const s of ssnSheets) {
    if (claimedSsn.has(s)) continue;
    s.warnings.push(
      `SSN sheet for "${i9SheetName(s)}" matched no Section 1 page in this packet — verify whose record it belongs to.`,
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
  if (!isI9Section1(rec)) return false;
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
  const hireDate = nonEmpty(rec.hireDate);
  const ppsEid = nonEmpty(rec.ppsEid);
  // Roster-sourced only: the live UCPath EID belongs to the separations
  // member row now (`matchedEmplId` is a deprecated pre-2026-07-16 stamp).
  const ucpathId = nonEmpty(rec.rosterEmplId);
  const sepDate = nonEmpty(rec.i9SeparationDate);

  const mkPaper = (key: string, label: string, paperValue: string | null): VerifyCheck => ({
    key,
    label,
    onPaper: paperValue !== null,
    paperValue,
    foundValue: null,
    source: "paper",
    status: paperValue !== null ? "present" : "missing",
  });

  const mkRoster = (key: string, label: string, value: string | null): VerifyCheck => ({
    key,
    label,
    onPaper: false,
    paperValue: null,
    foundValue: value,
    source: "roster",
    status: value !== null ? "found" : "missing",
    ...(value === null ? { missingLabel: "Not on Action History" } : {}),
  });

  // The UCPath verdict itself lives on the separations MEMBER row (the
  // post-completion i9-check task), not on this preview — what the preview can
  // answer is whether the roster already knows this person BY NAME.
  const rosterMatched = ppsEid !== null || nonEmpty(rec.rosterEmplId) !== null || sepDate !== null;
  const rosterNameCheck: VerifyCheck = {
    key: "rosterNameMatch",
    label: "On Action History roster (by name)?",
    onPaper: false,
    paperValue: null,
    foundValue: rosterMatched ? "Yes" : null,
    source: "roster",
    status: rosterMatched ? "found" : "missing",
    ...(rosterMatched ? {} : { missingLabel: "No name match — UCPath check runs next" }),
  };

  // Which of the person's TWO pages we actually have. Every employee should
  // have both; a verdict resting on one page is weaker than one corroborated
  // by two, and the operator needs to know which — and where to look.
  const section1Check: VerifyCheck = {
    key: "section1Present",
    label: "Section 1 present",
    onPaper: true,
    paperValue: rec.orphanSection2 ? null : `Yes — page ${rec.sourcePage}`,
    foundValue: null,
    source: "paper",
    status: rec.orphanSection2 ? "missing" : "present",
    ...(rec.orphanSection2
      ? { missingLabel: "MISSING — this person was never checked against UCPath" }
      : {}),
  };
  const section2Check: VerifyCheck = {
    key: "section2Present",
    label: "Section 2 present",
    onPaper: true,
    paperValue: rec.section2Page !== undefined ? `Yes — page ${rec.section2Page}` : null,
    foundValue: null,
    source: "paper",
    status: rec.section2Page !== undefined ? "present" : "missing",
    ...(rec.section2Page === undefined
      ? { missingLabel: "Not found — this read could not be cross-checked" }
      : {}),
  };

  return [
    mkPaper("name", "Employee Name", paperName),
    mkRoster("ppsEid", "PPS ID", ppsEid),
    mkRoster("ucpathEmplId", "UCPATH Employee ID", ucpathId),
    mkPaper("hireDate", "Hire Date (from I-9)", hireDate),
    mkRoster("i9SeparationDate", "Separation Date", sepDate),
    rosterNameCheck,
    // Keep the raw paper identifiers below the Action History grid columns
    // so the operator can still verify what was searched.
    mkPaper("dob", "Date of Birth", paperDob),
    mkPaper("ssn", "SSN", paperSsn),
    // Document provenance — which pages back this row, and what the employer
    // recorded on the Section 2 sheet.
    section1Check,
    section2Check,
    mkPaper("corroboration", "Cross-check vs Section 2", corroborationLabel(rec)),
  ];
}

/** Plain-language summary of the Section 1 vs Section 2 comparison. */
function corroborationLabel(rec: I9PreviewRecord): string | null {
  if (rec.corroboration === "confirmed") return "Confirmed — both pages agree";
  if (rec.corroboration === "disputed") {
    return `DISPUTED on ${rec.disputedFields.join(", ")} — not used to search`;
  }
  return null;
}

// ─── Spec implementation ────────────────────────────────────

export const i9OcrFormSpec: OcrFormSpec<I9OcrRecord, I9PreviewRecord> = {
  formType: "i9",
  label: "I-9 (UCPath check)",
  description:
    "Scanned Form I-9 packets. Reads each person's Section 1 + Section 2 pages, matches the Action History roster by name, then fans out one separations i9-check task per person to search UCPath and fill the retention tracker. Read-only — no UCPath writes.",

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
  // `done` right after enrichment instead of parking at awaiting-approval:
  // there is nothing to approve, and the prepare route then enqueues the
  // per-person separations i9-check member tasks (the UCPath searches) as
  // soon as the run finishes.
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
      hireDate: null,
      illegible: [],
      corroboration: "unavailable",
      disputedFields: [],
      orphanSection2: false,
      name: "",
      checks: [],
    };
  },

  // ─── Enrichment: Section 2 corroboration + roster NAME match ──
  //
  // The UCPath person search no longer runs here (it used to fan out one
  // person-match child per record). It now runs AFTER this run completes, as
  // REAL separations member tasks enqueued by `enqueueI9CheckMemberTasks`
  // (`src/tracker/dashboard/ocr/i9-check-results.ts`) — one retry-safe task
  // per person, which re-matches the roster BY the UCPath-resolved EID. This
  // phase owns what the packet alone can answer: pairing each person's two
  // pages and matching the Action History roster BY NAME.
  async enrichRecords(input): Promise<I9PreviewRecord[]> {
    const { records } = input;

    // Cross-check every Section 1 against the employer's Section 2 sheet BEFORE
    // any of it reaches UCPath. A field the two sources disagree on is dropped
    // from the eventual search (`buildI9PersonMatchInput`), because searching
    // with a known-suspect SSN manufactures a false "not found" — the exact
    // failure this whole path exists to avoid.
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
        `[i9/corroborate] page ${rec.sourcePage}: Section 2 for "${i9SheetName(rec)}" has no Section 1 page in this packet — that person cannot be checked`,
      );
    }
    input.emitProgress(records);

    // Action History cross-ref BY NAME (no live Empl ID exists at this stage —
    // the UCPath search runs later in the separations member tasks, which
    // re-match by the resolved EID). Fail loud if the roster file is
    // missing/unreadable.
    const { loadEmployeeActionHistory, crossRefI9Record, applyActionHistoryToI9Record } =
      await import("../../../services/matching/employee-action-history.js");
    const actionHistory = await loadEmployeeActionHistory();
    log.step({
      message: `[i9/action-history] loaded ${actionHistory.byEmplId.size} Empl ID(s) from ${actionHistory.sourcePath}`,
      category: "ocr",
    });

    let xrefHits = 0;
    let xrefMisses = 0;
    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      const xref = crossRefI9Record(rec, actionHistory);
      applyActionHistoryToI9Record(rec, xref);
      if (isI9Section1(rec)) {
        if (xref.ppsEid || xref.rosterEmplId) xrefHits += 1;
        else xrefMisses += 1;

        // Finalize match state: "resolved" = the separations member task CAN
        // search UCPath for this person — a full identifier search (SSN/DOB)
        // or a name-only lookup. Only a record with no legible name at all is
        // unsearchable.
        const searchable =
          buildI9PersonMatchInput(rec, {}) !== null
          || (nonEmpty(rec.name) ?? buildI9DisplayName(rec)) !== "";
        if (!searchable) {
          rec.matchState = "unresolved";
          rec.warnings.push(
            "Cannot check against UCPath: no legible name on this I-9 — verify the scan",
          );
        } else {
          if (buildI9PersonMatchInput(rec, {}) === null) {
            rec.warnings.push(
              "No usable SSN or mm/dd/yyyy date of birth — UCPath will be searched by name only",
            );
          }
          rec.matchState = "resolved";
        }
      }
      rec.checks = buildI9Checks(rec);
    }

    // Report the MATCH RATE, not just "the file loaded". A cross-ref that
    // matches nobody is the signature of a roster scoped to a different
    // population (the Action History export is filterable by department /
    // employee class / job action), and it leaves PPS EID + Separation Date
    // blank on every row. "loaded N Empl ID(s)" alone reads as success while
    // silently reporting nothing — so say out loud how many records it
    // actually resolved, and warn when the answer is none.
    const xrefTotal = xrefHits + xrefMisses;
    if (xrefTotal > 0 && xrefHits === 0) {
      log.warn({
        message:
          `[i9/action-history] cross-ref matched 0 of ${xrefTotal} I-9 record(s) against `
          + `${actionHistory.sourcePath} — PPS EID and Separation Date will be BLANK on every row. `
          + `This roster contains none of the scanned people; check that the Action History export `
          + `covers their department / employee class / job action, not a narrower slice.`,
        category: "ocr",
      });
    } else {
      log.step({
        message: `[i9/action-history] cross-ref matched ${xrefHits} of ${xrefTotal} I-9 record(s)`,
        category: "ocr",
      });
    }

    const searchableCount = records.filter(
      (rec) => isI9Section1(rec) && rec.matchState === "resolved",
    ).length;
    log.success({
      message:
        `[i9/enrich] complete records=${records.length} rosterNameMatches=${xrefHits} `
        + `searchable=${searchableCount} — UCPath person searches run next as separations member tasks`,
      category: "ocr",
      occasion: "completed",
      subject: "i9-enrichment",
    });

    input.emitProgress(records);
    return records;
  },
};
