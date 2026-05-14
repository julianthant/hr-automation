export { searchByEmail, searchCrmOnboardingRecords, selectLatestResult } from "./search.js";
export { navigateToSection } from "./navigate.js";
export { extractField } from "./extract.js";
export { ExtractionError } from "./types.js";
export { crmSelectors } from "./selectors.js";
export {
  DEFAULT_CRM_DOC_INDICES,
  buildCrmDocumentDownloadPath,
  ensureCrmDocumentDownloadFolder,
  parseCrmDocumentFilename,
  downloadCrmIdocsDocuments,
  downloadCrmIdocsDocumentsFromFrame,
} from "./idocs-download.js";
export type {
  CrmDocumentDownloadSubject,
  DownloadedCrmDocument,
  CrmIdocsDownloadOptions,
} from "./idocs-download.js";
