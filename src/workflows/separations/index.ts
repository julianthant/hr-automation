import { defineDashboardMetadata } from "../../core/index.js";

// Register dashboard UI metadata at module load. Separations is NOT yet
// kernel-migrated — it uses withTrackedWorkflow + withLogContext directly.
// defineDashboardMetadata is a thin alias for register() that signals "this
// workflow opts out of the Option-A runtime warning contract," because the
// declaredDetailFields hook isn't wired through legacy withTrackedWorkflow
// call sites.
defineDashboardMetadata({
  name: "separations",
  label: "Separations",
  systems: ["kuali", "old-kronos", "new-kronos", "ucpath"],
  steps: [
    "launching",
    "authenticating",
    "kuali-extraction",
    "kronos-search",
    "ucpath-job-summary",
    "ucpath-transaction",
    "kuali-finalization",
  ],
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "eid", label: "EID" },
    { key: "docId", label: "Doc ID" },
  ],
});

export { runSeparation } from "./workflow.js";
export type { SeparationOptions, SeparationResult, SessionWindows } from "./workflow.js";
export type { SeparationData } from "./schema.js";
export {
  computeTerminationEffDate,
  buildTerminationComments,
  mapReasonCode,
  getInitials,
  buildDateChangeComments,
} from "./schema.js";
export {
  KUALI_SPACE_URL,
  NEW_KRONOS_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
  INVOLUNTARY_TYPES,
} from "./config.js";
