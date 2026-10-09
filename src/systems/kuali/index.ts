export {
  openActionList,
  listActionListSeparations,
  clickDocument,
  extractSeparationData,
  isVoluntaryTermination,
  mapTerminationToUCPathReason,
  fillTimekeeperTasks,
  fillFinalTransactions,
  fillTransactionResults,
  fillTimekeeperComments,
  updateEmployeeName,
  updateLastDayWorked,
  updateSeparationDate,
  verifyTxnNumberFilled,
  readTransactionNumber,
  clickSave,
  saveAndVerifySeparation,
} from "./navigate.js";

export type { KualiSeparationData } from "./navigate.js";

export { kualiSelectors } from "./selectors.js";
