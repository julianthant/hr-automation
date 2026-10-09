/** Shared validator for delegation/batch {@link TrackerEntry.parentRunId} in JSON bodies. */
export const PARENT_RUN_ID_VALIDATION_HINT =
  "parentRunId must be 8–128 characters (letters, digits, . _ - only)";

/**
 * Parses an optional parent run id from a JSON field. Returns `undefined`
 * when absent or invalid-shaped; callers should 400 when the field was
 * present but parses invalid.
 */
export function parseOptionalParentRunId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s.length < 8 || s.length > 128) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return undefined;
  return s;
}
