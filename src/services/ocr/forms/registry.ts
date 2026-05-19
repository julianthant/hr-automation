import { oathOcrFormSpec } from "./oath.js";
import { emergencyContactOcrFormSpec } from "./emergency-contact.js";
import type { AnyOcrFormSpec } from "../../../workflows/ocr/types.js";

export const FORM_SPECS = {
  oath: oathOcrFormSpec,
  "emergency-contact": emergencyContactOcrFormSpec,
} as const;

export type FormType = keyof typeof FORM_SPECS;

export function getFormSpec(formType: "oath"): typeof oathOcrFormSpec | null;
export function getFormSpec(formType: "emergency-contact"): typeof emergencyContactOcrFormSpec | null;
export function getFormSpec(formType: string): AnyOcrFormSpec | null;
export function getFormSpec(
  formType: string,
): typeof oathOcrFormSpec | typeof emergencyContactOcrFormSpec | AnyOcrFormSpec | null {
  const map = FORM_SPECS as unknown as Record<string, AnyOcrFormSpec>;
  return map[formType] ?? null;
}

export interface FormTypeListing {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
}

export function listFormTypes(): FormTypeListing[] {
  return Object.values(FORM_SPECS).map((spec) => ({
    formType: spec.formType,
    label: spec.label,
    description: spec.description,
    rosterMode: spec.rosterMode,
  }));
}
