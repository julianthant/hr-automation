import type { ComponentType } from "react";
import { OathRecordView } from "./OathRecordView";
import { EcRecordView } from "./EcRecordView";

/**
 * Maps `OcrFormSpec.recordRendererId` (from the backend) to a React
 * component. Add a new form type's renderer here when adding the form.
 */
export const RECORD_RENDERERS: Record<string, ComponentType<{ record: any; onChange?: (r: any) => void }>> = {
  OathRecordView,
  EcRecordView,
};

export function getRecordRenderer(rendererId: string): ComponentType<{ record: any; onChange?: (r: any) => void }> | null {
  return RECORD_RENDERERS[rendererId] ?? null;
}
