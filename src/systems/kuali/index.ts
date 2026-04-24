export {
  openActionList,
  clickDocument,
  extractSeparationData,
  isVoluntaryTermination,
  mapTerminationToUCPathReason,
  fillTimekeeperTasks,
  fillFinalTransactions,
  fillTransactionResults,
  fillTimekeeperComments,
  updateLastDayWorked,
  updateSeparationDate,
  verifyTxnNumberFilled,
  clickSave,
} from "./navigate.js";

export type { KualiSeparationData } from "./navigate.js";

export { kualiSelectors } from "./selectors.js";
