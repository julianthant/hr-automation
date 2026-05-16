import { isAcceptedHdhDepartment } from "./hdh/departments.js";
import { displayPersonName, toLastFirstName } from "./identity/person-name.js";

export type ActiveCheckStatus = "active" | "inactive" | "not-found" | "non-hdh" | "ambiguous";

export interface ActiveOutcomePersonOrgResult {
  emplId: string;
  name: string;
  lastName?: string;
  department?: string;
  hrStatus?: string;
  effectiveDate?: string;
  terminationDate?: string;
  expectedJobEndDate?: string;
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

/** Narrow input for UCPath Person Org Summary outcome derivation (shared by active-check + eid-lookup). */
export type DeriveActiveOutcomeInput =
  | { kind: "by-eid"; emplId: string }
  | { kind: "by-name"; name: string };

function outcomeSearchName(input: DeriveActiveOutcomeInput): string {
  if (input.kind === "by-eid") return input.emplId;
  const display = displayPersonName(input.name);
  return display || input.name.trim();
}

function normalizeDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed && trimmed !== "Active" ? trimmed : "";
}

export function deriveActiveCheckOutcome(
  input: DeriveActiveOutcomeInput,
  results: ActiveOutcomePersonOrgResult[],
): ActiveCheckOutcome {
  const searchName = outcomeSearchName(input);
  if (results.length === 0) {
    return {
      activeStatus: "not-found",
      isActive: false,
      isHdhAccepted: false,
      searchName,
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

  if (input.kind !== "by-eid" && results.length > 1) {
    return {
      activeStatus: "ambiguous",
      isActive: false,
      isHdhAccepted: false,
      searchName,
      emplId: "",
      name: "",
      department: "",
      hrStatus: "Ambiguous",
      effdt: "",
      terminationDate: "",
      expectedJobEndDate: "",
      candidateEids: results.map((result) => result.emplId),
    };
  }

  const result = results[0];
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
    searchName,
    emplId: result.emplId,
    name: toLastFirstName(result.name, result.lastName),
    department: result.department ?? "",
    hrStatus,
    effdt: normalizeDate(result.effectiveDate),
    terminationDate,
    expectedJobEndDate,
    candidateEids: [result.emplId],
  };
}
