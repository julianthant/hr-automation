import type { AnyOcrPreviewRecord } from "@/lib/ocr-downstream-registry";

type AnyPreviewRecord = AnyOcrPreviewRecord;

/**
 * Records the operator must never select for approval:
 * - `unknown` pages (wrong form / filler)
 *
 * `verification.state === "inactive"` is NOT blocked (operator decision
 * 2026-07-27): inactive employees are submittable across all OCR approval
 * workflows — the inactive badge stays visible on the card as a signal, not
 * a gate.
 *
 * Distinct from {@link isApprovable}: a form-EID / still-verifying row is
 * selectable so the operator can include it once the EID lands, but it is not
 * yet counted on Approve until match + EID gates pass.
 */
export function isApprovalSelectionBlocked(record: AnyPreviewRecord): boolean {
  return record.documentType === "unknown";
}

/**
 * Records that contribute to the Approve N count (and that a successful
 * approve will fan out, modulo the form-spec `canFanOut` EID gate).
 */
/**
 * The record's employee id, whichever shape it is in: oath rows carry it
 * top-level, EC rows under `employee`. Trimmed, never undefined.
 */
export function readRecordEid(record: AnyPreviewRecord | undefined): string {
  if (!record) return "";
  return String(
    (record as { employeeId?: string }).employeeId
      ?? (record as { employee?: { employeeId?: string } }).employee?.employeeId
      ?? "",
  ).trim();
}

/** Provenance note stamped on a record whose EID the operator typed by hand. */
export const MANUAL_EID_WARNING =
  "Employee ID entered by the operator — not confirmed by a UCPath lookup.";

/**
 * An operator typing an employee id IS an identity assertion, so it must move
 * the record's match state — otherwise a row the lookup left `unresolved`
 * (ambiguous name, no EID on the paper) can never be approved no matter what
 * is typed, because {@link isApprovable} gates on `matchState`.
 *
 * Only a CHANGE from the server-supplied value promotes: re-rendering the same
 * OCR-read EID is not an operator assertion. Because the asserted identity may
 * differ from the one the lookup checked, the stale `matchConfidence` and
 * `verification` (both describe the OLD id) are dropped rather than inherited,
 * and the provenance is recorded as `manual` + a visible warning.
 */
export function promoteManualEidMatch<T extends AnyPreviewRecord>(
  base: AnyPreviewRecord | undefined,
  next: T,
): T {
  const nextEid = readRecordEid(next);
  if (!/^\d{5,}$/.test(nextEid)) return next;
  if (nextEid === readRecordEid(base)) return next;

  const warnings = next.warnings ?? [];
  return {
    ...next,
    matchState: "resolved",
    matchSource: "manual",
    matchConfidence: undefined,
    verification: undefined,
    warnings: warnings.includes(MANUAL_EID_WARNING)
      ? warnings
      : [...warnings, MANUAL_EID_WARNING],
  };
}

export function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  // Verification is a signal, not a gate: inactive / non-HDH / `lookup-failed`
  // (Person Org Summary returned nothing) and absent-yet states all fall
  // through as approvable. An EID resolved by eid-lookup is enough signal to
  // dispatch. Only `unknown` pages (wrong form / filler) are blocked.
  if (isApprovalSelectionBlocked(record)) return false;
  // Tighten: when selected, require a non-empty 5+ digit EID. Blocks
  // approving a manually-added row before the operator types an EID.
  const eidOk = !record.selected || /^\d{5,}$/.test(readRecordEid(record));
  return matchOk && eidOk;
}

/** Force-deselect hard-blocked rows so Select-all / stale localStorage can't stick. */
export function scrubHardBlockedSelection<T extends AnyPreviewRecord>(record: T): T {
  if (!record.selected || !isApprovalSelectionBlocked(record)) return record;
  return { ...record, selected: false };
}
