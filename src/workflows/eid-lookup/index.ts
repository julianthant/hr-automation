export { searchByName, parseNameInput, type EidResult, type EidSearchResult } from "./search.js";
export { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
export {
  runEidLookup,
  eidLookupWorkflow,
  eidLookupCrmWorkflow,
  dedupeNames,
  type EidLookupOptions,
  type LookupResult,
} from "./workflow.js";
export {
  EidLookupInputSchema,
  EidLookupCrmInputSchema,
  EidLookupItemSchema,
  type EidLookupInput,
  type EidLookupCrmInput,
  type EidLookupItem,
} from "./schema.js";
