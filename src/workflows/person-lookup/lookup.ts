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
import { buildLastFirstSearchNames } from "../../domain/identity/person-name.js";

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
    searchByNameImpl?: typeof searchByName;
    searchByEidImpl?: typeof searchByEid;
  } = {},
): Promise<PersonLookupRunResult> {
  if (input.kind === "by-eid") {
    const searchByEidImpl = options.searchByEidImpl ?? searchByEid;
    const result = await searchByEidImpl(page, input.emplId);
    const results = result ? [result] : [];
    return {
      input,
      results,
      selection: derivePersonLookupSelection(input, results),
      allAttempts: [],
    };
  }

  const candidateNames = buildLastFirstSearchNames(input.name);
  const namesToTry = candidateNames.length > 0 ? candidateNames : [input.name];
  const searchByNameImpl = options.searchByNameImpl ?? searchByName;
  const allAttempts: EidSearchResult[] = [];
  let selectedInput: PersonLookupInput = { kind: "by-name", name: namesToTry[0] ?? input.name };
  let results: PersonLookupResult[] = [];

  for (const name of namesToTry) {
    const search = await searchByNameImpl(page, name, {
      keepNonHdh: options.keepNonHdh,
      onAfterSearchAttempt: options.onAfterSearchAttempt,
    });
    allAttempts.push(...search.allAttempts);
    selectedInput = { kind: "by-name", name };
    results = search.sdcmpResults;
    if (results.length > 0) break;
  }

  return {
    input: selectedInput,
    results,
    selection: derivePersonLookupSelection(selectedInput, results),
    allAttempts,
  };
}
