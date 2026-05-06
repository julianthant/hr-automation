import { listFormTypes, type FormTypeListing } from "../../../ocr/forms/registry.js";

// ─── GET /api/ocr/forms ──────────────────────────────────────

export function buildOcrFormsHandler(): () => FormTypeListing[] {
  return () => listFormTypes();
}
