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
  return FORM_SPECS[formType as keyof typeof FORM_SPECS] ?? null;
}

export interface FormTypeListing {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
  /**
   * Whether approving this form fans out downstream daemon rows from the
   * approve route (`approveTo` per-record and/or `approveDocumentTo`
   * once-per-document). The OCR review pane shows the Approve button when this
   * is true (even on a standalone OCR run with no `parentRunId`) — a form that
   * fans out on approve always needs the Approve action available.
   */
  hasApproveFanOut: boolean;
}

export function listFormTypes(): FormTypeListing[] {
  return Object.values(FORM_SPECS).map((spec) => ({
    formType: spec.formType,
    label: spec.label,
    description: spec.description,
    rosterMode: spec.rosterMode,
    hasApproveFanOut: Boolean(spec.approveTo || spec.approveDocumentTo),
  }));
}
