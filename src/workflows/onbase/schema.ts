import { z } from "zod/v4";
import {
  ONBASE_EC_DOCUMENT_TYPE,
  ONBASE_EC_DOCUMENT_NAME,
} from "../../systems/onbase/index.js";

/**
 * One OnBase import = one person = one page of the combined PDF. The OCR approve
 * fan-out enqueues one of these per approved record.
 *
 * The only field the import strictly needs is `ucpathId` — typing it + Tab
 * fires the Employee Lookup keyset which autofills every other keyword. The
 * `*Fallback` fields (from OCR + person-lookup) are used ONLY when the keyset
 * comes up empty (bad/unknown UCPath ID). `pdfFileId` + `sourcePage` resolve the
 * person's single page from the combined PDF for OnBase's file picker.
 */
export const OnbaseInputSchema = z.object({
  /** UCPath employee id — the keyset primary key. */
  ucpathId: z.string().regex(/^\d{5,}$/, "UCPath ID must be numeric (5+ digits)"),
  /** 1-based page of the combined PDF that belongs to this person. */
  sourcePage: z.number().int().positive(),
  /** Registered-file id of the combined PDF (resolved to a path, page split out). */
  pdfFileId: z.string().min(1),
  /** Original uploaded filename (display / prep-row title). */
  pdfOriginalName: z.string().optional(),
  /** OnBase document type to select (e.g. X_HR_Emergency Contact). */
  documentType: z.string().default(ONBASE_EC_DOCUMENT_TYPE),
  /** Document Name keyword constant — the one field the keyset does not fill. */
  documentName: z.string().default(ONBASE_EC_DOCUMENT_NAME),

  /** Display name (member-row title) + fallback for the name keywords. */
  employeeName: z.string().optional(),

  // ── Fallback keyword values (used only if the keyset autofill fails) ──
  lastName: z.string().optional(),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  suffix: z.string().optional(),
  departmentName: z.string().optional(),
  departmentCode: z.string().optional(),
  viceChancellor: z.string().optional(),
  viceChancellorCode: z.string().optional(),

  /** Operation/session id this person belongs to (grouping + idempotency). */
  sessionId: z.string().optional(),
  /** Dry run: walk the form but never click Import. */
  dryRun: z.boolean().optional(),
});

export type OnbaseInput = z.infer<typeof OnbaseInputSchema>;
