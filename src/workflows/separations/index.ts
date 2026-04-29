// Barrel exports for the separations workflow.
//
// Dashboard metadata auto-registers via `defineWorkflow` in `workflow.ts` at
// module load — no `defineDashboardMetadata` call needed.

export { separationsWorkflow, runSeparation, runSeparationBatch, runSeparationCli } from "./workflow.js";
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
