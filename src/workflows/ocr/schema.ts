import { z } from "zod/v4";

export const OcrInputSchema = z.object({
  pdfPath:          z.string(),
  pdfOriginalName:  z.string(),
  formType:         z.string(),
  sessionId:        z.string(),
  rosterPath:       z.string().optional(),
  rosterMode:       z.enum(["existing", "download"]).default("existing"),
  parentRunId:      z.string().optional(),
  previousRunId:    z.string().optional(),
  forceResearchAll: z.boolean().optional(),
});

export type OcrInput = z.infer<typeof OcrInputSchema>;
