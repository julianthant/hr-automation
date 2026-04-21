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
