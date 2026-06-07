/**
 * Adapt a standalone (non-delegated) oath / emergency-contact OCR record into a
 * read-only `VerifyPreviewRecord` so it renders through `VerifyRecordView` as a
 * ✓/✗ completeness checklist — the same look as a `verify` card.
 *
 * A standalone OCR run has no downstream consumer (approval ≡ delegation), so
 * the operator only READS the extracted data; they never edit it. Rather than
 * keep a separate editable form, we project the record's fields onto the verify
 * check model: each field becomes a check that is `present` (on paper),
 * `found` (looked up), or `missing` (blank). Paper booleans whose blank state
 * carries meaning ("Employee Signed?") render their literal "No" via
 * `VerifyCheck.missingLabel`. No lookup-backed retry is wired — these are a
 * read-only snapshot (delegated runs keep the editable form + Approve).
 */
import type {
  OathPreviewRecord,
  PreviewRecord,
  Verification,
  VerifyCheck,
  VerifyPreviewRecord,
} from "./types";

function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** The active-status value from a cross-verification, or null when unknown. */
function activeStatusValue(verification: Verification | undefined): string | null {
  if (!verification) return null;
  switch (verification.state) {
    case "verified":
      return nonEmpty(verification.hrStatus) ?? "Active";
    case "inactive":
      return nonEmpty(verification.hrStatus) ?? "Inactive";
    case "non-hdh":
      return nonEmpty(verification.hrStatus) ?? "Non-HDH";
    default:
      return null; // lookup-failed / not yet looked up
  }
}

/** A field that is either on the form / looked up (✓/🔍) or blank (✗). */
function valueCheck(
  key: string,
  label: string,
  value: string | null,
  source: "paper" | "ucpath",
): VerifyCheck {
  if (value === null) {
    return { key, label, onPaper: false, paperValue: null, foundValue: null, source, status: "missing" };
  }
  return source === "paper"
    ? { key, label, onPaper: true, paperValue: value, foundValue: null, source, status: "present" }
    : { key, label, onPaper: false, paperValue: null, foundValue: value, source, status: "found" };
}

/** A paper yes/no field: ✓ "Yes" when signed, else ✗ "No". */
function boolCheck(key: string, label: string, yes: boolean): VerifyCheck {
  return yes
    ? { key, label, onPaper: true, paperValue: "Yes", foundValue: null, source: "paper", status: "present" }
    : { key, label, onPaper: false, paperValue: null, foundValue: null, source: "paper", status: "missing", missingLabel: "No" };
}

/**
 * Build the read-only completeness checklist for a standalone oath / EC record.
 *
 * Special case: an oath-run record whose `formKind` was classified as
 * "emergency-contact" or "unknown" by the model. The oath prompt does not
 * extract EC-specific fields (`employee`, `emergencyContact`), so we can only
 * show the fields that ARE present in the oath shape: `printedName`, `employeeId`,
 * and the active-status lookup result. Oath signature checks are skipped (the
 * `formKind === "oath"` guard handles that). An EC-shape record in an EC run is
 * unaffected — it goes through the `else` branch as before.
 */
export function buildReadonlyChecks(record: OathPreviewRecord | PreviewRecord): VerifyCheck[] {
  const activeStatus = activeStatusValue(record.verification);
  const activeCheck = valueCheck("activeStatus", "Active Status", activeStatus, "ucpath");

  if (record.formKind === "oath") {
    return [
      valueCheck("name", "Printed Name", nonEmpty(record.printedName), "paper"),
      valueCheck("eid", "Employee ID", nonEmpty(record.employeeId), "paper"),
      valueCheck("dateSigned", "Date Signed", nonEmpty(record.dateSigned), "paper"),
      boolCheck("employeeSigned", "Employee Signed", record.employeeSigned === true),
      boolCheck("officerSigned", "Officer Signed", record.officerSigned === true),
      activeCheck,
    ];
  }

  // An oath-SHAPED record re-classified as "emergency-contact" or "unknown"
  // (i.e. from an oath OCR run, not a real EC run). The oath prompt does not
  // extract EC-specific fields — show only what we have from the oath shape.
  if ("printedName" in record || "employeeId" in record) {
    const oathShaped = record as OathPreviewRecord;
    return [
      valueCheck("name", "Printed Name", nonEmpty(oathShaped.printedName), "paper"),
      valueCheck("eid", "Employee ID", nonEmpty(oathShaped.employeeId), "paper"),
      activeCheck,
    ];
  }

  // emergency-contact record from a real EC run
  return [
    valueCheck("name", "Name", nonEmpty(record.employee?.name), "paper"),
    valueCheck("eid", "Employee ID", nonEmpty(record.employee?.employeeId), "ucpath"),
    valueCheck("ecName", "Emergency Contact", nonEmpty(record.emergencyContact?.name), "paper"),
    valueCheck("ecRelationship", "Relationship", nonEmpty(record.emergencyContact?.relationship), "paper"),
    activeCheck,
  ];
}

/**
 * Produce the hint text shown when a page inside an oath run was recognized as
 * a non-oath form. The hint tells the operator to re-run through the correct workflow.
 */
function wrongFormKindHint(formKind: string): string {
  if (formKind === "emergency-contact") {
    return "This page looks like an Emergency Contact form, not an oath — re-run it through the Emergency Contact or Verify workflow to extract its fields.";
  }
  return "This page was not recognized as an oath form — re-run it through the Verify workflow to confirm its content.";
}

/** Project a standalone oath / EC record onto a read-only `VerifyPreviewRecord`. */
export function toReadonlyVerifyRecord(
  record: OathPreviewRecord | PreviewRecord,
): VerifyPreviewRecord {
  const checks = buildReadonlyChecks(record);
  if (record.formKind === "oath") {
    return {
      formKind: "oath",
      sourcePage: record.sourcePage,
      printedName: record.printedName,
      employeeId: record.employeeId ?? "",
      name: nonEmpty(record.printedName) ?? "",
      employeeSigned: record.employeeSigned ?? null,
      officerSigned: record.officerSigned ?? null,
      // OathMatchState shares the MatchState string union.
      matchState: record.matchState as VerifyPreviewRecord["matchState"],
      selected: record.selected,
      warnings: record.warnings,
      checks,
    };
  }

  // Oath-SHAPED record re-classified as "emergency-contact" or "unknown" by the
  // model (i.e. from an oath OCR run). Render with the correct doc-kind chip and
  // an honest hint so the operator knows to use the right workflow. The oath prompt
  // does not extract EC fields, so we can only surface what the oath shape carries.
  if ("printedName" in record || "employeeId" in record) {
    const oathShaped = record as OathPreviewRecord;
    const hint = wrongFormKindHint(record.formKind as string);
    const warnings = record.warnings.includes(hint) ? record.warnings : [...record.warnings, hint];
    return {
      formKind: record.formKind as VerifyPreviewRecord["formKind"],
      sourcePage: record.sourcePage,
      printedName: oathShaped.printedName,
      employeeId: oathShaped.employeeId ?? "",
      name: nonEmpty(oathShaped.printedName) ?? "",
      matchState: record.matchState as VerifyPreviewRecord["matchState"],
      selected: record.selected,
      warnings,
      checks,
    };
  }

  return {
    formKind: "emergency-contact",
    sourcePage: record.sourcePage,
    printedName: record.employee?.name ?? null,
    employeeId: record.employee?.employeeId ?? "",
    name: nonEmpty(record.employee?.name) ?? "",
    matchState: record.matchState,
    selected: record.selected,
    warnings: record.warnings,
    checks,
  };
}
