import type { AnyOcrPreviewRecord } from "@/lib/ocr-downstream-registry";

type AnyPreviewRecord = AnyOcrPreviewRecord;

/**
 * Records the operator must never select for approval:
 * - `unknown` pages (wrong form / filler)
 * - `verification.state === "inactive"` (backend also deselects these on lookup)
 *
 * Distinct from {@link isApprovable}: a form-EID / still-verifying row is
 * selectable so the operator can include it once the EID lands, but it is not
 * yet counted on Approve until match + EID gates pass.
 */
export function isApprovalSelectionBlocked(record: AnyPreviewRecord): boolean {
  if (record.documentType === "unknown") return true;
  const v = "verification" in record ? record.verification?.state : undefined;
  return v === "inactive";
}

/**
 * Records that contribute to the Approve N count (and that a successful
 * approve will fan out, modulo the form-spec `canFanOut` EID gate).
 */
export function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  // Verification gate: only HARD-block inactive employees. Non-HDH is still
  // HR-active, so the operator can approve when the EID and form data are right.
  // `lookup-failed` (Person Org Summary returned nothing) and absent-yet
  // states fall through as approvable. An EID resolved by eid-lookup is enough
  // signal to dispatch — verification is auxiliary.
  if (isApprovalSelectionBlocked(record)) return false;
  // Tighten: when selected, require a non-empty 5+ digit EID. Blocks
  // approving a manually-added row before the operator types an EID.
  const eid = String(
    (record as { employeeId?: string; employee?: { employeeId?: string } }).employeeId
      ?? (record as { employee?: { employeeId?: string } }).employee?.employeeId
      ?? "",
  ).trim();
  const eidOk = !record.selected || /^\d{5,}$/.test(eid);
  return matchOk && eidOk;
}

/** Force-deselect hard-blocked rows so Select-all / stale localStorage can't stick. */
export function scrubHardBlockedSelection<T extends AnyPreviewRecord>(record: T): T {
  if (!record.selected || !isApprovalSelectionBlocked(record)) return record;
  return { ...record, selected: false };
}
