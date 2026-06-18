export { searchByEmail, searchCrmOnboardingRecords, selectLatestResult } from "./search.js";
export { navigateToSection } from "./navigate.js";
export { extractField, extractCrmPersonName } from "./extract.js";
export type { CrmPersonName } from "./extract.js";
export { ExtractionError } from "./types.js";
export { crmSelectors } from "./selectors.js";
export {
  DEFAULT_CRM_DOC_INDICES,
  buildCrmDocumentDownloadPath,
  buildCrmDocumentFolderName,
  sanitizeOnboardingFolderName,
  ensureCrmDocumentDownloadFolder,
  parseCrmDocumentFilename,
  downloadCrmIdocsDocuments,
} from "./idocs-download.js";
export type {
  CrmDocumentDownloadSubject,
  DownloadedCrmDocument,
  CrmIdocsDownloadOptions,
} from "./idocs-download.js";
