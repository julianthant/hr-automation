import { isAcceptedHdhDepartment } from "../../domain/hdh/departments.js";
import { displayPersonName, toLastFirstName } from "../../domain/identity/person-name.js";

export type ActiveCheckStatus = "active" | "inactive" | "not-found" | "non-hdh" | "ambiguous";
export type PersonLookupStatus = "resolved" | "not-found" | "ambiguous";

export interface PersonLookupResult {
  emplId: string;
  name: string;
  lastName?: string;
  department?: string;
  hrStatus?: string;
  effectiveDate?: string;
  terminationDate?: string;
  expectedJobEndDate?: string;
  jobCodeDescription?: string;
}

export type PersonLookupInput =
  | { kind: "by-eid"; emplId: string }
  | { kind: "by-name"; name: string };

export interface PersonLookupSelection {
  input: PersonLookupInput;
  status: PersonLookupStatus;
  searchName: string;
  selected: PersonLookupResult | null;
  results: PersonLookupResult[];
  candidateEids: string[];
}

export interface ActiveCheckOutcome {
  activeStatus: ActiveCheckStatus;
  isActive: boolean;
  isHdhAccepted: boolean;
  searchName: string;
  emplId: string;
  name: string;
  department: string;
  hrStatus: string;
  effdt: string;
  terminationDate: string;
  expectedJobEndDate: string;
  candidateEids: string[];
}

function outcomeSearchName(input: PersonLookupInput): string {
  if (input.kind === "by-eid") return input.emplId;
  const display = displayPersonName(input.name);
  return display || input.name.trim();
}

function normalizeDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed && trimmed !== "Active" ? trimmed : "";
}

function isInactiveResult(result: PersonLookupResult): boolean {
  const terminationDate = normalizeDate(result.terminationDate);
  const hrStatus = result.hrStatus || "";
  return Boolean(terminationDate) || /inactive|terminated|separated/i.test(hrStatus);
}

function comparePreferredResult(
  a: PersonLookupResult,
  b: PersonLookupResult,
): number {
  const aActive = !isInactiveResult(a);
  const bActive = !isInactiveResult(b);
  if (aActive !== bActive) return aActive ? -1 : 1;

  const aHdh = isAcceptedHdhDepartment(a.department);
  const bHdh = isAcceptedHdhDepartment(b.department);
  if (aHdh !== bHdh) return aHdh ? -1 : 1;

  const aEffdt = normalizeDate(a.effectiveDate);
  const bEffdt = normalizeDate(b.effectiveDate);
  if (aEffdt !== bEffdt) return bEffdt.localeCompare(aEffdt);
  return 0;
}

function uniqueCandidateEids(results: PersonLookupResult[]): string[] {
  return Array.from(new Set(results.map((result) => result.emplId).filter(Boolean)));
}

function selectPreferredResult(results: PersonLookupResult[]): PersonLookupResult {
  return [...results].sort(comparePreferredResult)[0] ?? results[0]!;
}

export function derivePersonLookupSelection(
  input: PersonLookupInput,
  results: PersonLookupResult[],
): PersonLookupSelection {
  const searchName = outcomeSearchName(input);
  const candidateEids = uniqueCandidateEids(results);
  if (results.length === 0) {
    return {
      input,
      status: "not-found",
      searchName,
      selected: null,
      results,
      candidateEids,
    };
  }

  if (input.kind !== "by-eid" && candidateEids.length > 1) {
    return {
      input,
      status: "ambiguous",
      searchName,
      selected: null,
      results,
      candidateEids,
    };
  }

  return {
    input,
    status: "resolved",
    searchName,
    selected: selectPreferredResult(results),
    results,
    candidateEids,
  };
}

export function deriveActiveCheckOutcome(
  input: PersonLookupInput,
  results: PersonLookupResult[],
): ActiveCheckOutcome {
  const selection = derivePersonLookupSelection(input, results);
  if (selection.status === "not-found") {
    return {
      activeStatus: "not-found",
      isActive: false,
      isHdhAccepted: false,
      searchName: selection.searchName,
      emplId: input.kind === "by-eid" ? input.emplId : "",
      name: "",
      department: "",
      hrStatus: "Not found",
      effdt: "",
      terminationDate: "",
      expectedJobEndDate: "",
      candidateEids: [],
    };
  }

  if (selection.status === "ambiguous") {
    return {
      activeStatus: "ambiguous",
      isActive: false,
      isHdhAccepted: false,
      searchName: selection.searchName,
      emplId: "",
      name: "",
      department: "",
      hrStatus: "Ambiguous",
      effdt: "",
      terminationDate: "",
      expectedJobEndDate: "",
      candidateEids: selection.candidateEids,
    };
  }

  const result = selection.selected!;
  const terminationDate = normalizeDate(result.terminationDate);
  const expectedJobEndDate = normalizeDate(result.expectedJobEndDate);
  const hrStatus = result.hrStatus || "";
  const isInactiveStatus = /inactive|terminated|separated/i.test(hrStatus);
  const isActive = !terminationDate && !isInactiveStatus;
  const isHdhAccepted = isAcceptedHdhDepartment(result.department);
  let activeStatus: ActiveCheckStatus;
  if (!isActive) {
    activeStatus = "inactive";
  } else if (isHdhAccepted) {
    activeStatus = "active";
  } else {
    activeStatus = "non-hdh";
  }

  return {
    activeStatus,
    isActive,
    isHdhAccepted,
    searchName: selection.searchName,
    emplId: result.emplId,
    name: toLastFirstName(result.name, result.lastName),
    department: result.department ?? "",
    hrStatus,
    effdt: normalizeDate(result.effectiveDate),
    terminationDate,
    expectedJobEndDate,
    candidateEids: selection.candidateEids.length > 0 ? selection.candidateEids : [result.emplId],
  };
}

export function resolvePersonLookupForEidLookup<TInput extends PersonLookupInput>(args: {
  input: TInput;
  sdcmpFromSearch: PersonLookupResult[];
  crmMatchedEmplId?: string;
}): {
  deriveInput: PersonLookupInput;
  results: PersonLookupResult[];
} {
  if (args.input.kind === "by-eid") {
    return {
      deriveInput: { kind: "by-eid", emplId: args.input.emplId },
      results: args.sdcmpFromSearch,
    };
  }

  const matchedEid = args.crmMatchedEmplId?.trim();
  if (matchedEid) {
    const matched = args.sdcmpFromSearch.find((result) => result.emplId === matchedEid);
    return {
      deriveInput: { kind: "by-eid", emplId: matchedEid },
      results: matched ? [matched] : [],
    };
  }

  return {
    deriveInput: { kind: "by-name", name: args.input.name },
    results: args.sdcmpFromSearch,
  };
}
