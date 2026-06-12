import { isAcceptedHdhDepartment } from "../../domain/hdh/departments.js";
import type { ChildOutcome } from "../../tracker/delegation/watch-child-runs.js";

export type OcrLookupKind = "name" | "verify" | "verify-only";

export function patchOcrRecordUnresolved(
  records: unknown[],
  idx: number,
  warning: string,
): void {
  const rec = records[idx] as Record<string, unknown> | undefined;
  if (!rec) return;
  if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") {
    rec.matchState = "unresolved";
    const warnings = Array.isArray(rec.warnings) ? rec.warnings as string[] : [];
    warnings.push(warning);
    rec.warnings = warnings;
  }
}

export function patchOcrRecordFromEidLookupOutcome(
  records: unknown[],
  idx: number,
  outcome: ChildOutcome,
  kind: OcrLookupKind,
): void {
  const rec = records[idx] as Record<string, unknown> | undefined;
  if (!rec) return;
  const eid = (outcome.data?.emplId ?? "").trim();
  const looksLikeEid = /^\d{5,}$/.test(eid);
  const existingEid = getRecordEmployeeId(rec);
  const existingVerification = rec.verification as { state?: string } | undefined;
  const alreadyResolved =
    rec.matchState === "resolved" &&
    existingEid &&
    existingVerification?.state !== "inactive";

  if (kind === "name") {
    if (outcome.status === "done" && looksLikeEid) {
      if ("employee" in rec) {
        (rec.employee as Record<string, unknown>).employeeId = eid;
      } else {
        rec.employeeId = eid;
      }
      rec.matchState = "resolved";
      rec.matchSource = "eid-lookup";
      rec.selected = true;
    } else {
      if (alreadyResolved) return;
      rec.matchState = "unresolved";
      const warnings = Array.isArray(rec.warnings) ? rec.warnings as string[] : [];
      warnings.push(`eid-lookup ${outcome.status === "done" ? `returned "${eid || "no result"}"` : "failed"}`);
      rec.warnings = warnings;
    }
  } else {
    if (outcome.status === "done" && looksLikeEid) {
      // verify/verify-only lookups are EID-KEYED — the record's identity is
      // already established (paper EID / match pipeline). Never let the
      // lookup's echo replace a present EID: a divergent result would
      // silently clobber the on-paper identity (E2E-014 — the e2e stub's
      // constant EID overwrote three distinct paper EIDs). Only fill a
      // genuinely blank employeeId.
      if (!existingEid) {
        if ("employee" in rec) {
          (rec.employee as Record<string, unknown>).employeeId = eid;
        } else {
          rec.employeeId = eid;
        }
      }
      rec.matchState = "resolved";
      rec.matchSource = "eid-lookup";
    }
  }

  const verification = computeOcrVerification({
    activeStatus: outcome.data?.activeStatus,
    isActive: outcome.data?.isActive,
    isHdhAccepted: outcome.data?.isHdhAccepted,
    hrStatus: outcome.data?.hrStatus,
    department: outcome.data?.department,
    personOrgScreenshot: outcome.data?.personOrgScreenshot,
    terminationDate: outcome.data?.terminationDate,
  });
  rec.verification = verification;

  if (kind === "name") {
    if (verification.state === "inactive") {
      rec.selected = false;
    }
    return;
  }

  if (verification.state === "inactive" || verification.state === "lookup-failed") {
    rec.selected = false;
  } else if (verification.state === "verified" || verification.state === "non-hdh") {
    rec.selected = true;
  }
}

export function patchOcrRecordFromActiveCheckOutcome(
  records: unknown[],
  idx: number,
  outcome: ChildOutcome,
): void {
  const rec = records[idx] as Record<string, unknown> | undefined;
  if (!rec) return;
  const eid = (outcome.data?.emplId ?? "").trim();
  if (/^\d{5,}$/.test(eid)) {
    if ("employee" in rec) {
      (rec.employee as Record<string, unknown>).employeeId = eid;
    } else {
      rec.employeeId = eid;
    }
  }
  const verification = computeOcrVerification({
    activeStatus: outcome.data?.activeStatus,
    isActive: outcome.data?.isActive,
    isHdhAccepted: outcome.data?.isHdhAccepted,
    hrStatus: outcome.data?.hrStatus,
    department: outcome.data?.department,
    personOrgScreenshot: outcome.data?.personOrgScreenshot,
    terminationDate: outcome.data?.terminationDate,
  });
  rec.verification = verification;
  if (verification.state === "inactive" || verification.state === "lookup-failed") {
    rec.selected = false;
  } else if (verification.state === "verified" || verification.state === "non-hdh") {
    rec.selected = true;
  }
}

function getRecordEmployeeId(record: Record<string, unknown>): string {
  if (typeof record.employeeId === "string") return record.employeeId.trim();
  const employee = record.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId.trim();
  return "";
}

function looksInactiveHrLabel(hr: string): boolean {
  return /inactive|terminated|separated/i.test(hr);
}

function parseBoolish(v: unknown): boolean | undefined {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}

function looksActiveHrCell(hrRaw: string | undefined): boolean {
  const hr = hrRaw?.trim() ?? "";
  if (!hr || looksInactiveHrLabel(hr)) return false;
  if (/^active\b/i.test(hr)) return true;
  return /\bactive\b/i.test(hr);
}

export function computeOcrVerification(d: {
  activeStatus?: string;
  isActive?: string | boolean;
  isHdhAccepted?: string | boolean;
  hrStatus?: string;
  department?: string;
  personOrgScreenshot?: string;
  terminationDate?: string;
}): {
  state: "verified" | "inactive" | "non-hdh" | "lookup-failed";
  hrStatus?: string;
  department?: string;
  screenshotFilename: string;
  checkedAt: string;
  error?: string;
} {
  const checkedAt = new Date().toISOString();
  const screenshotFilename = d.personOrgScreenshot ?? "";
  const activeSummary = d.activeStatus?.trim().toLowerCase() ?? "";
  if (activeSummary) {
    if (activeSummary === "active") {
      return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
    }
    if (activeSummary === "non-hdh") {
      return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
    }
    if (activeSummary === "inactive") {
      return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
    }
    return {
      state: "lookup-failed",
      error: d.activeStatus?.trim() || activeSummary,
      checkedAt,
      screenshotFilename,
    };
  }

  const iso = parseBoolish(d.isActive);
  const hdhOk = parseBoolish(d.isHdhAccepted);
  if (iso === true && hdhOk === true) {
    return {
      state: "verified",
      hrStatus: d.hrStatus,
      department: d.department ?? "",
      screenshotFilename,
      checkedAt,
    };
  }
  if (iso === false) {
    return {
      state: "inactive",
      hrStatus: d.hrStatus,
      department: d.department,
      screenshotFilename,
      checkedAt,
    };
  }
  if (iso === true && hdhOk === false) {
    return {
      state: "non-hdh",
      hrStatus: d.hrStatus,
      department: d.department ?? "",
      screenshotFilename,
      checkedAt,
    };
  }

  const hr = (d.hrStatus ?? "").trim();
  if (!hr) return { state: "lookup-failed", error: "no result", checkedAt, screenshotFilename };
  const active = looksActiveHrCell(hr);
  const hdh = isAcceptedHdhDepartment(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
