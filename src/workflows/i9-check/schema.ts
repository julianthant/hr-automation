import { z } from "zod/v4";

/**
 * Input for one **i9-check task** — one person from a scanned I-9 packet.
 * The daemon resolves them via person-match → optional hire-dated
 * person-lookup → Action History roster rematch (search-only; see `check.ts`).
 * Fanned out by `enqueueI9CheckMemberTasks`
 * (`src/tracker/dashboard/ocr/i9-check-results.ts`) under the upload's
 * i9-check operation coordinator when the delegated OCR run completes.
 *
 * The `mode: "i9-check"` literal predates the 2026-07-17 split (when these
 * tasks ran inside the separations daemon and the literal made the input union
 * disjoint from the termination variant). It stays: the payload remains
 * self-describing, and if one ever lands in the wrong queue it can parse ONLY
 * as an i9 check — never as anything that mutates a live HR system.
 */
export const I9CheckMemberInputSchema = z.object({
  mode: z.literal("i9-check"),
  person: z.object({
    /** Display name, "Last, First M" (from Section 1, else the Section 2 name line). */
    name: z.string().min(1),
    lastName: z.string().optional(),
    firstName: z.string().optional(),
    middleInitial: z.string().optional(),
    /** 9 bare digits, pre-normalized; disputed/illegible SSNs are dropped upstream. */
    ssn: z.string().regex(/^\d{9}$/).optional(),
    /** MM/DD/YYYY, pre-normalized; disputed/illegible DOBs are dropped upstream. */
    dob: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional(),
    /** First day of employment from the Section 2 certification. */
    hireDate: z.string().optional(),
    /** 1-indexed Section 1 page (absent for an orphan-Section-2 person). */
    sourcePage: z.number().int().positive().optional(),
    /** 1-indexed Section 2 page when paired. */
    section2Page: z.number().int().positive().optional(),
    /** Employer verified this person but their Section 1 page is missing. */
    orphanSection2: z.boolean().optional(),
  }),
  /**
   * Roster seed from the OCR stage's NAME-based Action History match. The
   * daemon re-matches the roster BY EID once UCPath resolves the person; this
   * seed is what backs the spreadsheet row when UCPath does NOT know the
   * person (mirrors the operator's manual sheet, where not-found people still
   * carry the roster PPS EID).
   */
  roster: z
    .object({
      ppsEid: z.string().optional(),
      /** Zero-padded PPS ID verbatim — the spreadsheet writes this form. */
      ppsEidPadded: z.string().optional(),
      emplId: z.string().optional(),
      separationDate: z.string().optional(),
    })
    .optional(),
  ocrSessionId: z.string().min(1),
  ocrRunId: z.string().min(1),
  /** Index of the source OCR record (log correlation + stable itemIds). */
  recordIndex: z.number().int().nonnegative(),
});

export type I9CheckMemberInput = z.infer<typeof I9CheckMemberInputSchema>;
