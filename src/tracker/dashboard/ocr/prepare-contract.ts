import { z } from "zod/v4";

import {
  MAX_PARALLEL_WORKERS,
  MIN_PARALLEL_WORKERS,
} from "../../../domain/run-options.js";

/**
 * Complete launch contract for the in-process OCR prepare surface. This is
 * persisted verbatim for retry because there is no daemon task row carrying
 * `original_input_json` for this workflow.
 */
export const OcrPrepareInputSchema = z.object({
  pdfPath: z.string().min(1),
  pdfOriginalName: z.string().min(1),
  pdfFileId: z.string().min(1).optional(),
  formType: z.string().min(1),
  rosterMode: z.enum(["existing", "download", "wait"]),
  rosterPath: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  previousRunId: z.string().min(1).optional(),
  isReupload: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  targetWorkflow: z.string().min(1).optional(),
  runOptions: z.object({
    parallelWorkers: z.number().int().min(MIN_PARALLEL_WORKERS).max(MAX_PARALLEL_WORKERS).optional(),
  }).strict().optional(),
}).strict();

export type PrepareInput = z.infer<typeof OcrPrepareInputSchema>;
