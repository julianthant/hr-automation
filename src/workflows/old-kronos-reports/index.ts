// Importing workflow.ts triggers defineWorkflow side-effects that register
// dashboard metadata in the kernel's registry — same outcome as the old
// explicit metadata registration call that lived here pre-migration.
export {
  kronosReportsWorkflow,
  KronosItemSchema,
  setKronosRuntime,
  clearKronosRuntime,
} from "./workflow.js";
export type { KronosItem } from "./workflow.js";

export { EmployeeIdSchema, KronosInputSchema } from "./schema.js";
export type { KronosInput } from "./schema.js";

export {
  updateKronosTracker,
  buildTrackerRow,
  TRACKER_PATH,
} from "./tracker.js";
export type { KronosTrackerRow } from "./tracker.js";

export { validatePdf, validateAndClean, extractPdfIdentity, verifyPdfMatch } from "./validate.js";

export {
  REPORTS_DIR,
  SESSION_DIR,
  DEFAULT_START_DATE,
  DEFAULT_END_DATE,
  DEFAULT_WORKERS,
} from "./config.js";
