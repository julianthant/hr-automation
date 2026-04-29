export { searchByName, parseNameInput, isAcceptedDept, type EidResult, type EidSearchResult } from "./search.js";
export { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
export {
  runEidLookupCli,
  eidLookupCrmWorkflow,
  dedupeNames,
  prepareNames,
  type LookupResult,
} from "./workflow.js";
export {
  EidLookupInputSchema,
  EidLookupCrmInputSchema,
  EidLookupItemSchema,
  normalizeName,
  type EidLookupInput,
  type EidLookupCrmInput,
  type EidLookupItem,
} from "./schema.js";
