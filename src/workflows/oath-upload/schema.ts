import { z } from "zod/v4";

export const OathUploadInputSchema = z.object({
  pdfPath:         z.string().min(1),
  pdfOriginalName: z.string().min(1),
  pdfFileId:       z.string().optional(),
  sessionId:       z.string().min(1),
  pdfHash:         z.string().regex(/^[0-9a-f]{64}$/, "expected sha256 hex (64 lowercase hex chars)"),
  mode:            z.enum(["full", "upload-only"]).default("full"),
  // Roster source for the delegated OCR step. "existing" requires `rosterPath`
  // (resolved by the dashboard route from disk); "download" pulls a fresh
  // copy from SharePoint via the OCR orchestrator's loading-roster step.
  rosterMode:      z.enum(["existing", "download"]).default("download"),
  rosterPath:      z.string().optional(),
  dryRun:          z.boolean().optional(),
});

export type OathUploadInput = z.infer<typeof OathUploadInputSchema>;
