import { oathOcrFormSpec } from "../oath-signature/ocr-form.js";
import { emergencyContactOcrFormSpec } from "../emergency-contact/ocr-form.js";
import type { AnyOcrFormSpec } from "./types.js";

export const FORM_SPECS = {
  oath:                oathOcrFormSpec as unknown as AnyOcrFormSpec,
  "emergency-contact": emergencyContactOcrFormSpec as unknown as AnyOcrFormSpec,
} as const;

export type FormType = keyof typeof FORM_SPECS;

export function getFormSpec(formType: string): AnyOcrFormSpec | null {
  return (FORM_SPECS as Record<string, AnyOcrFormSpec>)[formType] ?? null;
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
