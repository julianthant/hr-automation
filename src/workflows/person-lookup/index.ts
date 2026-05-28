import type { Page } from "playwright";
import {
  deriveActiveCheckOutcome,
  derivePersonLookupSelection,
  resolvePersonLookupForEidLookup,
  type ActiveCheckOutcome,
  type ActiveCheckStatus,
  type PersonLookupInput,
  type PersonLookupResult,
  type PersonLookupSelection,
} from "./outcome.js";
import {
  searchByEid,
  searchByName,
  type EidSearchResult,
} from "../../systems/ucpath/person-org-summary.js";

export type {
  ActiveCheckOutcome,
  ActiveCheckStatus,
  PersonLookupInput,
  PersonLookupResult,
  PersonLookupSelection,
};
export {
  deriveActiveCheckOutcome,
  derivePersonLookupSelection,
  resolvePersonLookupForEidLookup,
};

export interface PersonLookupRunResult {
  input: PersonLookupInput;
  results: PersonLookupResult[];
  selection: PersonLookupSelection;
  allAttempts: EidSearchResult[];
}

/**
 * Internal UCPath Person Org lookup primitive.
 *
 * This is intentionally not registered in WORKFLOW_LOADERS or dashboard run
 * surfaces. Operator-facing workflows derive from it; operators do not start
 * it directly.
 */
export async function lookupPersonInUcpath(
  page: Page,
  input: PersonLookupInput,
  options: {
    keepNonHdh?: boolean;
    onAfterSearchAttempt?: (attempt: EidSearchResult) => Promise<void>;
  } = {},
): Promise<PersonLookupRunResult> {
  if (input.kind === "by-eid") {
    const result = await searchByEid(page, input.emplId);
    const results = result ? [result] : [];
    return {
      input,
      results,
      selection: derivePersonLookupSelection(input, results),
      allAttempts: [],
    };
  }

  const search = await searchByName(page, input.name, {
    keepNonHdh: options.keepNonHdh,
    onAfterSearchAttempt: options.onAfterSearchAttempt,
  });
  const results = search.sdcmpResults;
  return {
    input,
    results,
    selection: derivePersonLookupSelection(input, results),
    allAttempts: search.allAttempts,
  };
}
