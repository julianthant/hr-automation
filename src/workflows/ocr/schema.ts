import { z } from "zod/v4";
import { MAX_PARALLEL_WORKERS, MIN_PARALLEL_WORKERS } from "../../domain/run-options.js";
import { FileAttachmentIdSchema } from "../../tracker/files/file-id.js";

export const OcrInputSchema = z.object({
  pdfPath:          z.string(),
  pdfOriginalName:  z.string(),
  pdfFileId:        FileAttachmentIdSchema.optional(),
  formType:         z.string(),
  sessionId:        z.string(),
  rosterPath:       z.string().optional(),
  rosterMode:       z.enum(["existing", "download", "wait"]).default("existing"),
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
  /**
   * Operator-chosen run options (Automation-workers setting). Execution
   * metadata, NOT business data — `parallelWorkers` raises the alive-daemon
   * target for the downstream fan-out (lookup during prep, signer/contact rows
   * at approve). Mapped to daemon flags via `runOptionsToDaemonFlags`; stamped
   * onto every OCR row's `data.parallelWorkers` so the approve route can read it
   * back. Absent → Auto. See `src/domain/run-options.ts`.
   */
  runOptions:       z.object({
    parallelWorkers: z.number().int().min(MIN_PARALLEL_WORKERS).max(MAX_PARALLEL_WORKERS).optional(),
  }).optional(),
});

export type OcrInput = z.infer<typeof OcrInputSchema>;
