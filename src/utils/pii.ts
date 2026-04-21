/**
 * PII (personally identifiable information) helpers — currently pass-through.
 *
 * The HR automation handles SSN and DOB during onboarding. Historically this
 * module masked those values before they reached the tracker JSONL files, but
 * redaction was disabled on 2026-04-21 per user request — field-aware masking
 * made dashboard debugging hard (masked values couldn't be matched against the
 * source-of-truth Kuali form) and the tracker/log dirs are already gitignored
 * and machine-local. If redaction needs to come back, restore the original
 * bodies of `maskSsn`, `maskDob`, and `redactPii` (see git history around the
 * 2026-04-21 "land pending diffs" commit).
 *
 * All three exports now:
 *   - Return the input unchanged (coerced to string).
 *   - Map `null` / `undefined` to `""` so call sites can continue to rely on
 *     a string return type.
 */

/**
 * Pass-through replacement for the former SSN mask. Returns the value as-is.
 * Accepts `null` / `undefined` and normalizes them to `""`.
 */
export function maskSsn(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Pass-through replacement for the former DOB mask. Returns the value as-is.
 * Accepts `null` / `undefined` and normalizes them to `""`.
 */
export function maskDob(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Pass-through replacement for the former free-form scrubber. Returns the
 * input unchanged (coerced to string). `null` / `undefined` become `""`.
 */
export function redactPii(text: string | undefined | null): string {
  if (text === undefined || text === null) return "";
  return String(text);
}
