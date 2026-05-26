import { z } from "zod/v4";

/**
 * Input schema for the Oath Signature workflow.
 *
 * Discriminated union — `kind` decides which downstream shape the handler
 * runs.
 *
 *  - **`signer`** — today's per-EID flow. `emplId` is the UCPath employee
 *    ID (5+ digits). `date` is optional; when omitted, the workflow
 *    accepts whatever value UCPath prefills on the Add-New-Oath-Signature
 *    -Date detail form (today's date). When provided, it overrides the
 *    prefill. Must be MM/DD/YYYY to match PeopleSoft's date textbox
 *    format.
 *  - **`pdf`** — paper-roster flow. Caller hands in a PDF (already saved
 *    to disk) and a stable `sessionId`. The kernel handler delegates to
 *    the `ocr` workflow for extraction + operator approval, then fans
 *    out one `kind: "signer"` child per approved record via
 *    `ctx.delegateToAll(oathSignatureWorkflow, ...)`. The recursion is
 *    safe because the schema discriminator routes each child run back to
 *    the signer branch.
 *
 * Shared fields:
 *  - `dryRun` — skip the UCPath Save click (signer branch) or propagate
 *    to children (pdf branch).
 *  - `parentSubject` — operator-facing label inherited from the
 *    delegating parent's row.
 */
const SharedFields = z.object({
  dryRun: z.boolean().optional(),
  parentSubject: z.string().optional(),
});

const SignerSchema = SharedFields.extend({
  kind: z.literal("signer"),
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  name: z.string().optional(),
  date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Date must be in MM/DD/YYYY format")
    .optional(),
});

const PdfSchema = SharedFields.extend({
  kind: z.literal("pdf"),
  pdfPath: z.string().min(1),
  pdfOriginalName: z.string().min(1),
  pdfFileId: z.string().optional(),
  pdfHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "pdfHash must be a 64-char hex SHA-256")
    .optional(),
  sessionId: z.string().min(1),
  rosterMode: z.enum(["existing", "download"]).optional(),
  rosterPath: z.string().optional(),
});

export const OathSignatureInputSchema = z.discriminatedUnion("kind", [
  SignerSchema,
  PdfSchema,
]);
export type OathSignatureInput = z.infer<typeof OathSignatureInputSchema>;
export type OathSignerInput = z.infer<typeof SignerSchema>;
export type OathPdfInput = z.infer<typeof PdfSchema>;
