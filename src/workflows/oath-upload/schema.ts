import { z } from "zod/v4";

export const OathUploadInputSchema = z.object({
  // `pdfPath` is optional now: rows born from the OCR approve fan-out arrive
  // with only `pdfFileId` (the OCR review data carries the registered file id,
  // not always the on-disk path). The handler resolves the actual path + hash
  // from the file store when `pdfPath`/`pdfHash` are absent.
  pdfPath:         z.string().min(1).optional(),
  pdfOriginalName: z.string().min(1),
  pdfFileId:       z.string().optional(),
  sessionId:       z.string().min(1),
  pdfHash:         z.string().regex(/^[0-9a-f]{64}$/, "expected sha256 hex (64 lowercase hex chars)").optional(),
  mode:            z.enum(["full", "upload-only"]).default("full"),
  /**
   * OCR-hub fan-out: the `oath-signature` signer itemIds this ticket must wait
   * for (and verify all succeeded) BEFORE filing the ServiceNow ticket. Set by
   * the OCR approve `approveDocumentTo` fan-out. Empty/absent → no wait (e.g.
   * `upload-only` mode).
   */
  signerItemIds:   z.array(z.string()).optional(),
  // `rosterMode`/`rosterPath` were REMOVED (E2E-006): the handler never read
  // them — OCR owns roster matching — yet the born-at-upload input hardcoded
  // rosterMode:"download", silently contradicting the operator's modal choice.
  // Old persisted inputs that still carry the keys parse fine (Zod strips
  // unknown keys), so retries of pre-removal tasks are unaffected.
  dryRun:          z.boolean().optional(),
});

export type OathUploadInput = z.infer<typeof OathUploadInputSchema>;
