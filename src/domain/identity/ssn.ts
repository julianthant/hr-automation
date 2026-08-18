/** Mask SSN for dashboard / log display: "***-**-1234". */
export function maskSsn(ssn: string | undefined | null): string {
  if (!ssn) return "";
  const digits = ssn.replace(/-/g, "");
  if (digits.length < 4) return "***";
  return `***-**-${digits.slice(-4)}`;
}

/**
 * UCPath REJECTS any National ID whose first three digits fall in 900-999:
 *
 *   "Social Security Number cannot begin with 9. (18180,64) — There are specific
 *    restrictions for formatting Social Security Number. Reenter the Social
 *    Security Number which is not having 900-999 in 1 to 3 Positions"
 *
 * That range is the ITIN space, and CRM also stores the all-9s placeholder
 * `999-99-9999` to mean "no SSN on file yet". Either way the value cannot be
 * entered into the Smart HR National ID field: the error opens a BLOCKING modal
 * that swallows every later click, so the transaction dies ~25s later at an
 * unrelated step (live 2026-08-18: the Job Data tab never rendered and the
 * Position Number fill timed out, with no hint of the real cause).
 *
 * Detecting it up front lets the caller treat the person as having no SSN,
 * which is a real and expected state for a new international student.
 */
export function isUcpathRejectedSsn(ssn: string | undefined | null): boolean {
  if (!ssn) return false;
  const digits = ssn.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  return area >= 900 && area <= 999;
}

/**
 * The SSN to actually enter into UCPath: the original when it is enterable, or
 * `undefined` when UCPath would reject it (see `isUcpathRejectedSsn`).
 *
 * Deliberately NOT a silent substitution — it never invents a different number.
 * It converts "a value UCPath refuses" into the honest, already-supported
 * "no SSN provided" state, which the caller must also reflect in the comments.
 */
export function ssnForUcpathEntry(ssn: string | undefined | null): string | undefined {
  if (!ssn) return undefined;
  return isUcpathRejectedSsn(ssn) ? undefined : ssn;
}
