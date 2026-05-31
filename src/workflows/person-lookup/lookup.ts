import type { Page } from "playwright";
import {
  derivePersonLookupSelection,
  type PersonLookupInput,
  type PersonLookupResult,
  type PersonLookupSelection,
} from "./outcome.js";
import {
  searchByEid,
  searchByName,
  type EidSearchResult,
} from "../../systems/ucpath/person-org-summary.js";

export interface PersonLookupRunResult {
  input: PersonLookupInput;
  results: PersonLookupResult[];
  selection: PersonLookupSelection;
  allAttempts: EidSearchResult[];
}

/**
 * Internal UCPath Person Org lookup primitive.
 *
 * Shared by the Person Lookup workflow handler steps and by any downstream
 * caller that needs the same UCPath Person Org read + preferred-assignment
 * selection. Keep status derivation fed by this primitive so name and EID
 * paths handle hidden active Employment Instances consistently.
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
