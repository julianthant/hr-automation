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
      rec.matchState = "unresolved";
      const warnings = Array.isArray(rec.warnings) ? rec.warnings as string[] : [];
      warnings.push(`eid-lookup ${outcome.status === "done" ? `returned "${eid || "no result"}"` : "failed"}`);
      rec.warnings = warnings;
    }
  } else {
    if (outcome.status === "done" && looksLikeEid) {
      if ("employee" in rec) {
        (rec.employee as Record<string, unknown>).employeeId = eid;
      } else {
        rec.employeeId = eid;
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
    if (verification.state === "inactive" || verification.state === "non-hdh") {
      rec.selected = false;
    }
    return;
  }

  if (verification.state === "inactive" || verification.state === "non-hdh" || verification.state === "lookup-failed") {
    rec.selected = false;
  } else if (verification.state === "verified") {
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
  if (verification.state === "inactive" || verification.state === "non-hdh" || verification.state === "lookup-failed") {
    rec.selected = false;
  } else if (verification.state === "verified") {
    rec.selected = true;
  }
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
  const activeStatus = d.activeStatus?.trim();
  if (activeStatus) {
    if (activeStatus === "active") {
      return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
    }
    if (activeStatus === "non-hdh") {
      return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
    }
    if (activeStatus === "inactive") {
      return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
    }
    return { state: "lookup-failed", error: activeStatus, checkedAt, screenshotFilename };
  }
  if (!d.hrStatus) return { state: "lookup-failed", error: "no result", checkedAt, screenshotFilename };
  const active = d.hrStatus === "Active";
  const hdh = isAcceptedHdhDepartment(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
