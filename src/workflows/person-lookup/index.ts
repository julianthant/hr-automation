// Outcome / status derivation (shared domain logic).
export {
  deriveActiveCheckOutcome,
  deriveCrmOnlyCheckOutcome,
  derivePersonLookupSelection,
  resolvePersonLookupForEidLookup,
  systemPresence,
} from "./outcome.js";
export type {
  ActiveCheckOutcome,
  ActiveCheckStatus,
  PersonLookupInput,
  PersonLookupResult,
  PersonLookupSelection,
  SystemPresence,
} from "./outcome.js";

// UCPath Person Org lookup primitive.
export { lookupPersonInUcpath, type PersonLookupRunResult } from "./lookup.js";

// UCPath Person Org system re-exports (used by composing callers + tests).
export {
  searchByName,
  searchByEid,
  parsePersonOrgNameInput as parseNameInput,
  type EidResult,
  type EidSearchResult,
} from "../../systems/ucpath/person-org-summary.js";
export { isAcceptedHdhDepartment as isAcceptedDept } from "../../domain/hdh/departments.js";

// CRM cross-verification helpers.
export { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";

// Workflow + CLI adapter.
export {
  handlePersonLookup,
  personLookupWorkflow,
  runPersonLookup,
  runPersonLookupCli,
  resolveActiveStatusResultsForPersonLookup,
  PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY,
  dedupeNames,
  prepareNames,
  type LookupResult,
} from "./workflow.js";

// Input schema + helpers.
export {
  PersonLookupItemSchema,
  PersonLookupNameInputSchema,
  PersonLookupEidInputSchema,
  PersonLookupMatchInputSchema,
  PERSON_LOOKUP_MODES,
  isEidInput,
  isMatchInput,
  resolvePersonLookupMode,
  resolvePersonLookupCrmCheck,
  parsePersonLookupMatchLine,
  buildPersonLookupCliInput,
  displayPersonLookupInput,
  derivePersonLookupItemId,
  normalizeName,
  type PersonLookupItem,
  type PersonLookupNameInput,
  type PersonLookupEidInput,
  type PersonLookupMatchInput,
  type PersonLookupSearchInput,
  type PersonLookupMode,
} from "./schema.js";
export { handlePersonMatch } from "./match.js";
