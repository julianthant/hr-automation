import { z } from "zod/v4";
import { displayPersonName } from "../../domain/identity/person-name.js";

export const ActiveCheckNameInputSchema = z.object({
  name: z.string().min(1),
  keepNonHdh: z.boolean().optional(),
});

export const ActiveCheckEidInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Empl ID must be numeric (5+ digits)"),
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
