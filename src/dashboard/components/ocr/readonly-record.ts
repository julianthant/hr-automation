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

/** Build the read-only completeness checklist for a standalone oath / EC record. */
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

  // emergency-contact
  return [
    valueCheck("name", "Name", nonEmpty(record.employee?.name), "paper"),
    valueCheck("eid", "Employee ID", nonEmpty(record.employee?.employeeId), "ucpath"),
    valueCheck("ecName", "Emergency Contact", nonEmpty(record.emergencyContact?.name), "paper"),
    valueCheck("ecRelationship", "Relationship", nonEmpty(record.emergencyContact?.relationship), "paper"),
    activeCheck,
  ];
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
