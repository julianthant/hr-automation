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

/**
 * SHAPE test (not classification): does this record carry the oath-shape fields
 * (`printedName` / `employeeId` at top level)? An oath OCR run always produces
 * oath-shaped records regardless of how the model classified the page's
 * `formKind`; an EC run produces `employee`/`emergencyContact`-shaped records.
 * Shape decides which fields we can READ; `formKind` decides whether to show a
 * wrong-form hint — the two axes are orthogonal.
 */
export function isOathShapedRecord(
  record: OathPreviewRecord | PreviewRecord,
): record is OathPreviewRecord {
  return "printedName" in record || "employeeId" in record;
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
 * We branch on SHAPE (which fields the record carries — set by the OCR run that
 * produced it), then by `formKind` (the model's per-page classification). The
 * two are orthogonal:
 * - Oath-shaped + classified "oath": full oath card (name/EID/date + signatures).
 * - Oath-shaped + classified "emergency-contact"/"unknown" (oath-run
 *   mis-classification): the oath prompt did not extract EC fields, so we show
 *   only the oath-shape fields we have (printedName, employeeId, active status).
 * - EC-shaped + classified "emergency-contact": normal EC card.
 * - EC-shaped + classified "oath"/"unknown" (EC-run mis-classification): the EC
 *   prompt did not extract oath fields, so we show only the EC-shape fields.
 *   `toReadonlyVerifyRecord` adds the wrong-form hint for both mis-classified
 *   directions.
 */
export function buildReadonlyChecks(record: OathPreviewRecord | PreviewRecord): VerifyCheck[] {
  const activeStatus = activeStatusValue(record.verification);
  const activeCheck = valueCheck("activeStatus", "Active Status", activeStatus, "ucpath");

  if (isOathShapedRecord(record)) {
    // EID provenance: only a FORM-sourced EID is "(on paper)". `form-eid`
    // (extracted from the page) and `manual` (operator transcription) count as
    // paper; `eid-lookup`, `roster`, and `llm` all injected the EID from a
    // non-paper source — labeling those as paper miscounts the
    // "N on paper · N looked up" tally (E2E-005; the roster single-candidate
    // accept is the most common non-paper path). The EC branch below already
    // labels its lookup-backed EID "ucpath".
    const eidSource =
      record.matchSource === "eid-lookup" || record.matchSource === "roster" || record.matchSource === "llm"
        ? "ucpath"
        : "paper";
    // Oath-shaped: a re-classified page (formKind != "oath") has no oath
    // signature data worth showing, so drop the signature checks for it.
    if (record.formKind === "oath") {
      return [
        valueCheck("name", "Printed Name", nonEmpty(record.printedName), "paper"),
        valueCheck("eid", "Employee ID", nonEmpty(record.employeeId), eidSource),
        valueCheck("dateSigned", "Date Signed", nonEmpty(record.dateSigned), "paper"),
        boolCheck("employeeSigned", "Employee Signed", record.employeeSigned === true),
        boolCheck("officerSigned", "Officer Signed", record.officerSigned === true),
        activeCheck,
      ];
    }
    return [
      valueCheck("name", "Printed Name", nonEmpty(record.printedName), "paper"),
      valueCheck("eid", "Employee ID", nonEmpty(record.employeeId), eidSource),
      activeCheck,
    ];
  }

  // EC-shaped (a real EC run), whatever the model classified `formKind` as. The
  // EC prompt extracts `employee`/`emergencyContact`; a mis-classified page
  // simply has them blank — but they are still the only fields we have.
  return [
    valueCheck("name", "Name", nonEmpty(record.employee?.name), "paper"),
    valueCheck("eid", "Employee ID", nonEmpty(record.employee?.employeeId), "ucpath"),
    valueCheck("ecName", "Emergency Contact", nonEmpty(record.emergencyContact?.name), "paper"),
    valueCheck("ecRelationship", "Relationship", nonEmpty(record.emergencyContact?.relationship), "paper"),
    activeCheck,
  ];
}

/**
 * Produce the hint text shown when a page was classified as a form that does NOT
 * match the run that produced it (a wrong-form page). `formKind` is the model's
 * classification; the hint names the form it looks like and points the operator
 * at the right workflow. Covers BOTH mis-classification directions (an EC/unknown
 * page in an oath run, and an oath/unknown page in an EC run).
 */
function wrongFormKindHint(formKind: string): string {
  if (formKind === "emergency-contact") {
    return "This page looks like an Emergency Contact form, not an oath — re-run it through the Emergency Contact or Verify workflow to extract its fields.";
  }
  if (formKind === "oath") {
    return "This page looks like an oath form, not an Emergency Contact form — re-run it through the Oath Signature or Verify workflow to extract its fields.";
  }
  return "This page was not recognized as the expected form — re-run it through the Verify workflow to confirm its content.";
}

/**
 * Append the wrong-form hint to a record's warnings when its `formKind`
 * classification doesn't match the native form of the run that produced it
 * (`nativeForm`). Dedups so a re-render doesn't stack the hint.
 */
function withWrongFormHint(warnings: string[], formKind: string, nativeForm: "oath" | "emergency-contact"): string[] {
  if (formKind === nativeForm) return warnings;
  const hint = wrongFormKindHint(formKind);
  return warnings.includes(hint) ? warnings : [...warnings, hint];
}

/**
 * Project a standalone oath / EC record onto a read-only `VerifyPreviewRecord`.
 *
 * Branches on SHAPE (`isOathShapedRecord`), then attaches a wrong-form hint
 * whenever the model's `formKind` doesn't match the native form of the run —
 * symmetric across BOTH directions (an oath run that classified a page
 * EC/unknown, AND an EC run that classified a page oath/unknown). The `formKind`
 * carried onto the projected record drives the doc-kind chip.
 */
export function toReadonlyVerifyRecord(
  record: OathPreviewRecord | PreviewRecord,
): VerifyPreviewRecord {
  const checks = buildReadonlyChecks(record);

  if (isOathShapedRecord(record)) {
    const warnings = withWrongFormHint(record.warnings, record.formKind, "oath");
    return {
      formKind: record.formKind,
      sourcePage: record.sourcePage,
      printedName: record.printedName,
      employeeId: record.employeeId ?? "",
      name: nonEmpty(record.printedName) ?? "",
      // Signature checks are only meaningful for an actual oath page.
      ...(record.formKind === "oath"
        ? {
            employeeSigned: record.employeeSigned ?? null,
            officerSigned: record.officerSigned ?? null,
          }
        : {}),
      // OathMatchState shares the MatchState string union.
      matchState: record.matchState,
      selected: record.selected,
      warnings,
      checks,
    };
  }

  // EC-shaped record (a real EC run). A page the model classified oath/unknown
  // gets the same honest wrong-form hint as the oath-run direction.
  const warnings = withWrongFormHint(record.warnings, record.formKind, "emergency-contact");
  return {
    formKind: record.formKind,
    sourcePage: record.sourcePage,
    printedName: record.employee?.name ?? null,
    employeeId: record.employee?.employeeId ?? "",
    name: nonEmpty(record.employee?.name) ?? "",
    matchState: record.matchState,
    selected: record.selected,
    warnings,
    checks,
  };
}
