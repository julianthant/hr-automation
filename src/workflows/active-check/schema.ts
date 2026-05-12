import { z } from "zod/v4";
import { displayPersonName } from "../../domain/identity/person-name.js";
import {
  normalizeUcpathEmployeeId,
  isUcpathEmployeeId,
  normalizeEid,
} from "../../domain/identity/eid.js";

export const ActiveCheckNameInputSchema = z.object({
  name: z.string().min(1),
  keepNonHdh: z.boolean().optional(),
});

export const ActiveCheckEidInputSchema = z.object({
  emplId: z.string()
    .transform((value) => normalizeUcpathEmployeeId(value))
    .pipe(z.string().regex(/^10\d{6}$/, "Empl ID must be 8 digits starting with 10")),
  name: z.string().min(1).optional(),
  keepNonHdh: z.boolean().optional(),
});

export const ActiveCheckItemSchema = z.union([
  ActiveCheckNameInputSchema,
  ActiveCheckEidInputSchema,
]);

export type ActiveCheckNameInput = z.infer<typeof ActiveCheckNameInputSchema>;
export type ActiveCheckEidInput = z.infer<typeof ActiveCheckEidInputSchema>;
export type ActiveCheckItem = z.infer<typeof ActiveCheckItemSchema>;

export function buildActiveCheckCliInput(query: string): ActiveCheckNameInput | { emplId: string } {
  const trimmed = query.trim();
  if (trimmed.length > 0 && /^[\d\s-]+$/.test(trimmed) && isUcpathEmployeeId(normalizeEid(trimmed))) {
    return { emplId: query };
  }
  return { name: query };
}

export function isActiveCheckEidInput(input: ActiveCheckItem): input is ActiveCheckEidInput {
  return "emplId" in input;
}

export function displayActiveCheckInput(input: ActiveCheckItem): string {
  if (isActiveCheckEidInput(input)) return input.name ? `${input.name} (${input.emplId})` : input.emplId;
  return displayPersonName(input.name) || input.name.trim();
}

export function deriveActiveCheckItemId(input: ActiveCheckItem): string {
  if (isActiveCheckEidInput(input)) return input.emplId;
  return displayPersonName(input.name) || input.name.trim();
}
