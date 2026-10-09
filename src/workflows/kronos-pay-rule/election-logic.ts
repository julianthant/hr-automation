import { log } from "../../utils/log.js";

export interface EmployeeElectionData {
  employeeName: string;
  employeeId: string;
  unionCode: string;
  payRuleInUKG: string;
  currentElection: string;
  newElection: string;
  timekeepingSystem: string;
  alreadyUpdated: string;
}

export type PayRuleAction =
  | {
    action: "change";
    currentPayRule: string;
    newPayRule: string;
    oldCode: "CT" | "OT";
    newCode: "CT" | "OT";
    reason: string;
  }
  | { action: "skip"; reason: string };

/** Extract the OT/CT election segment from a UKG pay rule code. */
export function payRuleElectionCode(payRule: string): "CT" | "OT" | null {
  if (!payRule || payRule.startsWith("N/A")) return null;
  if (payRule.includes("-CT-")) return "CT";
  if (payRule.includes("-OT-")) return "OT";
  return null;
}

/** Union codes that default to OT when no new election is submitted. */
const DEFAULTS_TO_OT = new Set(["HX", "CX", "SV", "SX", "RP"]);

/** Union codes whose previous election continues when no new election is submitted. */
const PREVIOUS_CONTINUES = new Set(["RX", "TX", "K6"]);

/**
 * Normalize raw election values to a canonical form.
 * Pure + unit-testable.
 *
 * UNKNOWN (an unrecognized non-blank value) is deliberately DISTINCT from
 * BLANK: BLANK activates the union-default logic (which can swap a pay rule),
 * so folding a typo'd or novel election string into BLANK could mutate payroll
 * against the employee's actual election. UNKNOWN makes the caller skip loudly
 * instead (root CLAUDE.md "Fail loud").
 */
export function normalizeElection(raw: string): "CASH" | "CT" | "NONE" | "BLANK" | "UNKNOWN" {
  const trimmed = raw.trim();
  if (trimmed === "") return "BLANK";
  const lower = trimmed.toLowerCase();
  if (lower === "cash" || lower === "switch to cash") return "CASH";
  if (lower === "ct" || lower === "comp time") return "CT";
  if (lower === "none") return "NONE";
  log.warn(`[Kronos Pay Rule] Unrecognized election value: "${raw}" — skipping (fix the roster CSV)`);
  return "UNKNOWN";
}

/**
 * Derive the new pay rule by swapping the OT↔CT segment.
 * Pay rules contain exactly one `-CT-` or `-OT-` segment.
 * Pure + unit-testable.
 */
export function deriveNewPayRule(currentPayRule: string, targetElection: "OT" | "CT"): string {
  if (targetElection === "OT") {
    if (!currentPayRule.includes("-CT-")) {
      throw new Error(
        `[Kronos Pay Rule] Cannot swap to OT: pay rule "${currentPayRule}" does not contain "-CT-"`,
      );
    }
    return currentPayRule.replace("-CT-", "-OT-");
  }
  if (!currentPayRule.includes("-OT-")) {
    throw new Error(
      `[Kronos Pay Rule] Cannot swap to CT: pay rule "${currentPayRule}" does not contain "-OT-"`,
    );
  }
  return currentPayRule.replace("-OT-", "-CT-");
}

/**
 * Determine what pay rule action is needed for an employee based on their
 * union code, current pay rule, and election status.
 * Pure + unit-testable.
 */
export function determinePayRuleAction(employee: EmployeeElectionData): PayRuleAction {
  const { payRuleInUKG, unionCode, alreadyUpdated } = employee;

  // Gate 1: Not in UKG
  if (!payRuleInUKG || payRuleInUKG.startsWith("N/A")) {
    return { action: "skip", reason: "Not in UKG" };
  }

  // Gate 2: Already updated
  if (alreadyUpdated.toLowerCase() === "yes") {
    return { action: "skip", reason: "Already updated" };
  }

  // Gate 3: Pay rule format check
  const hasCT = payRuleInUKG.includes("-CT-");
  const hasOT = payRuleInUKG.includes("-OT-");
  if (!hasCT && !hasOT) {
    return { action: "skip", reason: `Pay rule format not recognized: ${payRuleInUKG}` };
  }
  const currentType: "CT" | "OT" = hasCT ? "CT" : "OT";

  // Determine target election type
  const normalized = normalizeElection(employee.newElection);
  let targetType: "OT" | "CT";

  switch (normalized) {
    case "CASH":
      targetType = "OT";
      break;
    case "CT":
      targetType = "CT";
      break;
    case "NONE":
      return { action: "skip", reason: "Employee elected NONE — no change" };
    case "UNKNOWN":
      // Never fall through to union-default logic on a value we couldn't
      // interpret — that branch can swap the pay rule. Skipping is safe (no
      // transaction); the operator fixes the roster and re-runs.
      return {
        action: "skip",
        reason: `Unrecognized election value "${employee.newElection}" — fix the roster CSV`,
      };
    case "BLANK": {
      if (DEFAULTS_TO_OT.has(unionCode)) {
        targetType = "OT";
      } else if (PREVIOUS_CONTINUES.has(unionCode)) {
        return {
          action: "skip",
          reason: `No new election — ${unionCode} previous election continues`,
        };
      } else {
        return { action: "skip", reason: `Unknown union code: ${unionCode}` };
      }
      break;
    }
  }

  // Compare current vs target
  if (currentType === targetType) {
    return { action: "skip", reason: `Already on ${targetType} — no change needed` };
  }

  const newPayRule = deriveNewPayRule(payRuleInUKG, targetType);
  const reason = normalized === "BLANK"
    ? `No new election — ${unionCode} defaults to OT`
    : `Employee elected ${normalized}`;

  return {
    action: "change",
    currentPayRule: payRuleInUKG,
    newPayRule,
    oldCode: currentType,
    newCode: targetType,
    reason,
  };
}
