import { z } from "zod/v4";

export const OcrInputSchema = z.object({
  pdfPath:          z.string(),
  pdfOriginalName:  z.string(),
  pdfFileId:        z.string().optional(),
  formType:         z.string(),
  sessionId:        z.string(),
  rosterPath:       z.string().optional(),
  rosterMode:       z.enum(["existing", "download"]).default("existing"),
  parentRunId:      z.string().optional(),
  parentSubject:    z.string().optional(),
  /**
   * Target-workflow operation mode: the downstream workflow whose operation /
   * single coordinator row owns this OCR run (oath-signature | emergency-contact
   * | oath-upload). Stamped onto every OCR row so the approve route can route
   * the fan-out by intent (e.g. an oath-signature PDF run fans out signers but
   * files no ServiceNow ticket). Absent for a standalone OCR-hub upload.
   */
  operationWorkflow: z.string().optional(),
  previousRunId:    z.string().optional(),
  forceResearchAll: z.boolean().optional(),
  dryRun:           z.boolean().optional(),
});

export type OcrInput = z.infer<typeof OcrInputSchema>;
