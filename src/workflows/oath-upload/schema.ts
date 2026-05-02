import { z } from "zod/v4";

export const OathUploadInputSchema = z.object({
  pdfPath:         z.string().min(1),
  pdfOriginalName: z.string().min(1),
  sessionId:       z.string().min(1),
  pdfHash:         z.string().regex(/^[0-9a-f]{64}$/, "expected sha256 hex (64 lowercase hex chars)"),
});

export type OathUploadInput = z.infer<typeof OathUploadInputSchema>;
