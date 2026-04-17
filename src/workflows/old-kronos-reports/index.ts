import { defineDashboardMetadata } from "../../core/index.js";

// Register dashboard UI metadata at module load. This workflow is NOT
// kernel-based (uses withTrackedWorkflow + withLogContext directly from
// parallel.ts), so we call defineDashboardMetadata rather than
// defineWorkflow. The CLI path imports this module's runParallelKronos —
// the side-effect here runs before the dashboard can query the registry.
defineDashboardMetadata({
  name: "kronos-reports",
  label: "Kronos Reports",
  systems: ["old-kronos"],
  steps: ["searching", "extracting", "downloading"],
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "id", label: "ID" },
  ],
});

export { runKronosForEmployee } from "./workflow.js";
export type { KronosOptions } from "./workflow.js";

export { runParallelKronos, loadBatchFile } from "./parallel.js";

export { KronosInputSchema, EmployeeIdSchema } from "./schema.js";
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
  BATCH_FILE,
} from "./config.js";
