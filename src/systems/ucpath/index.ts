export { ActionPlan } from "./action-plan.js";
export type { TransactionResult, PlannedAction } from "./types.js";
export { TransactionError } from "./types.js";
export { ucpathSelectors } from "./selectors.js";
export {
  navigateToSmartHR,
  getContentFrame,
  waitForPeopleSoftProcessing,
  searchPerson,
} from "./navigate.js";
export { dismissPeopleSoftModalMask } from "../common/modal.js";
export type { PersonSearchResult } from "./navigate.js";
export {
  clickSmartHRTransactions,
  selectTemplate,
  enterEffectiveDate,
  clickCreateTransaction,
  selectReasonCode,
  fillPersonalData,
  fillComments,
  fillTerminationLastDateWorked,
  clickJobDataTab,
  fillJobData,
  clickEarnsDistTab,
  clickEmployeeExperienceTab,
  clickPersonalDataTab,
  clickSaveAndSubmit,
  waitForSaveEnabled,
  // EID-bearing templates (UC_CONC_HIRE concurrent hire, 2026-08-21)
  fillTransactionDetailsEmplId,
  acknowledgePersonIdExistsDialog,
  waitForJobDataForm,
  readPersonalDataLegalName,
  cancelTransactionDraft,
  buildConcurrentHireCommentsText,
  readLatestTransactionNumber,
  findExistingTerminationTransaction,
  deletePendingTransaction,
  extractSmartHrTransactionNumber,
  scrollToTransactionReadbackArea,
  parsePayRate,
  buildCommentsText,
  // Submit-time "Person Match Found" page (2026-08-20)
  classifySubmitSignals,
  decidePersonMatchContinue,
  candidateExcludedByHardIdentifier,
  readPersonMatchCandidates,
  formatPersonMatchCandidate,
  normalizeNationalIdLast4,
  normalizeDobMonthDay,
  ssnLast4,
} from "./transaction.js";
export type {
  PersonalDataInput,
  JobDataInput,
  ExistingTerminationResult,
  PersonMatchCandidate,
  PersonMatchHireIdentity,
  PersonMatchDecision,
} from "./transaction.js";
export {
  navigateToSsSmartHrTransactions,
  findTerminationTransactionStatus,
  findExistingHireTransaction,
  readSubmittedHireReceipt,
  receiptMatchesRequestedTransaction,
  pickTerminationRow,
  pickHireRow,
  buildHireSearchName,
  HIRE_ACTION_CODES,
} from "./ss-smart-hr.js";
export type {
  SsSmartHrRow,
  TerminationTransactionStatus,
  HireTransactionStatus,
  SubmittedHireReceipt,
} from "./ss-smart-hr.js";
export {
  navigateToWorkforceJobSummary,
  searchJobSummary,
  extractWorkLocation,
  extractJobInfo,
  extractEmployeeName,
  getJobSummaryIdentity,
  getJobSummaryData,
} from "./job-summary.js";
export type { JobSummaryData, JobSummaryIdentity } from "./job-summary.js";
