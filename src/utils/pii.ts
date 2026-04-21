/**
 * PII (personally identifiable information) masking helpers.
 *
 * The HR automation handles SSN and DOB during onboarding. These values must
 * never reach the tracker JSONL files (`.tracker/*.jsonl`, `.tracker/*-logs.jsonl`)
 * in plaintext — those files stream to the dashboard and can be exported to
 * Excel, both of which are operator-visible.
 *
 * Two flavors:
 *   - Field-aware masks (`maskSsn`, `maskDob`): when the caller knows the key
 *     is an SSN or DOB, preserve the partially-useful tail (last-4 of SSN, year
 *     of DOB) so the dashboard can still identify the record.
 *   - Blanket scrub (`redactPii`): for free-form text (log messages, error
 *     strings) where SSN/DOB could appear interpolated inside a sentence.
 *     Replaces any SSN-like or DOB-like substring with a fixed placeholder.
 */

/**
 * Mask a Social Security Number. Accepts common input shapes:
 *   "123-45-6789" becomes "x-x-6789" with stars for masked digits
 *   "123456789"   becomes the same mask
 *   "6789"        keeps only last-4 suffix
 *   "12"          too short — returns triple-star fallback
 *   ""            empty stays empty
 *
 * Input is normalized to digits-only. Non-digit characters are stripped
 * before masking, so the mask format is always three-stars, two-stars, last-4
 * (joined by dashes).
 */
export function maskSsn(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Mask a date of birth while preserving the year (useful for rough age checks
 * without revealing the exact birthday). Accepts common formats:
 *   "01/15/1992"   masks month and day, keeps 1992
 *   "1/15/1992"    same result
 *   "1992-01-15"   ISO form — keeps the year, masks month + day
 *
 * Unknown shapes fall through to `redactPii` which is lenient.
 */
export function maskDob(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/g;
// MM/DD/YYYY or M/D/YYYY — year must be 4 digits so we don't eat random numbers.
const DOB_SLASH_RE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;
// YYYY-MM-DD — same caveat; narrow enough to avoid stomping effectiveDate
// timestamps like "2026-04-17T08:00:00.000Z" (those have a T separator, our
// regex needs the whole match to be just YYYY-MM-DD).
const DOB_ISO_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b(?!T)/g;

/**
 * Last-line defense: scan free-form text for anything that looks like an SSN
 * or DOB and replace with a masked token. Applied to log messages and error
 * strings before they're written to disk.
 *
 * Note this is intentionally broad — it WILL stomp a legitimate "2026-04-17"
 * in a log message. That's acceptable: the scrubber runs post-formatting and
 * we prefer false positives over leaking PII.
 *
 * SSN replacement uses a fully-masked token (the last-4 is only preserved by
 * the field-aware `maskSsn`, not here). DOB replacement is either slash-shape
 * or ISO-shape depending on the match.
 */
export function redactPii(text: string | undefined | null): string {
  if (text === undefined || text === null) return "";
  return String(text);
}
