/**
 * Shared MM/DD/YYYY date formatting (the Kuali / UCPath / PeopleSoft wire
 * format). Promoted from `workflows/separations/schema.ts` once a second
 * workflow (oath-signature) needed the same helper.
 */

/**
 * Format a Date as zero-padded MM/DD/YYYY (matching the Kuali / UCPath wire format).
 */
export function formatMmDdYyyy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Today's date as zero-padded MM/DD/YYYY (local time). `now` is injectable so
 * tests can pin a fixed date — handlers call it argument-less.
 */
export function todayMmDdYyyy(now: Date = new Date()): string {
  return formatMmDdYyyy(now);
}
