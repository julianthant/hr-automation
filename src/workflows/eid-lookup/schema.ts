import { z } from "zod";

/** Common input shape for both no-CRM and CRM-on lookups. */
export const EidLookupInputSchema = z.object({
  names: z.array(z.string().min(1)).min(1),
  workers: z.number().int().positive(),
});

export type EidLookupInput = z.infer<typeof EidLookupInputSchema>;

/** CRM-on input is the same shape — separate alias for clarity at call sites. */
export const EidLookupCrmInputSchema = EidLookupInputSchema;

export type EidLookupCrmInput = EidLookupInput;

/** Per-item shape for the shared-context-pool batch mode (one name per kernel item). */
export const EidLookupItemSchema = z.object({
  name: z.string().min(1),
});

export type EidLookupItem = z.infer<typeof EidLookupItemSchema>;

/**
 * Normalize a raw "Last, First Middle" input string to a consistent display
 * format: title-cased parts separated by a single `", "`.
 *
 * Intended to be applied at the CLI boundary so every downstream consumer
 * (search form fields, tracker `searchName`, dashboard detail cell) sees the
 * same casing regardless of how the user typed it. UCPath and CRM forms are
 * case-insensitive so title-casing doesn't affect matching.
 *
 * Behavior:
 *   - "zaw, hein thant"    → "Zaw, Hein Thant"
 *   - "SMITH, JOHN"        → "Smith, John"
 *   - "  smith , john  "   → "Smith, John"   (trim + single-space collapse)
 *   - "plain string"       → "plain string"  (no comma → unchanged; search.ts
 *                            will throw its own format error downstream)
 *   - "smith,"             → "smith,"        (empty first → unchanged)
 */
export function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx === -1) return raw;
  const lastRaw = trimmed.slice(0, commaIdx).trim();
  const restRaw = trimmed.slice(commaIdx + 1).trim();
  if (!lastRaw || !restRaw) return raw;
  const restParts = restRaw.split(/\s+/).filter(Boolean).map(titleCase);
  return `${titleCase(lastRaw)}, ${restParts.join(" ")}`;
}

/** Capitalize first char, lowercase the rest. Single word only. */
function titleCase(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}
