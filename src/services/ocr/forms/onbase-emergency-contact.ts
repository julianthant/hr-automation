import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";
import type { OcrFormSpec } from "../../../workflows/ocr/types.js";
import type { OnbaseInput } from "../../../workflows/onbase/schema.js";
import {
  ONBASE_EC_DOCUMENT_TYPE,
  ONBASE_EC_DOCUMENT_NAME,
} from "../../../systems/onbase/index.js";
import {
  emergencyContactOcrFormSpec,
  type PermissiveRecord,
  type PreviewRecord,
} from "./emergency-contact.js";

/**
 * OnBase Emergency Contact form spec.
 *
 * The uploaded PDF is the SAME UCSD R&R Emergency Contact form the
 * `emergency-contact` workflow processes, so this spec REUSES that spec's
 * extraction wholesale (prompt, schemas, roster match, disambiguation,
 * person-lookup `needsLookup`, carry-forward, placeholder shape). The only
 * difference is the destination: instead of writing the contact into UCPath,
 * approve fans out one **onbase** import row per person.
 *
 * OnBase's Employee Lookup keyset autofills every keyword from the UCPath ID,
 * so the per-person input mainly needs the resolved EID + the combined PDF's
 * `pdfFileId` + `sourcePage` (to split that person's page out for the import).
 * Names are carried as fallback for the rare case the keyset comes up empty.
 */

/** Split an OCR "Last, First" (or "First Last") name into parts. */
function splitOcrName(full: string): { lastName?: string; firstName?: string } {
  const trimmed = (full ?? "").trim();
  if (!trimmed) return {};
  const comma = trimmed.indexOf(",");
  if (comma >= 0) {
    const last = trimmed.slice(0, comma).trim();
    const first = trimmed.slice(comma + 1).trim();
    return {
      ...(last ? { lastName: last } : {}),
      ...(first ? { firstName: first } : {}),
    };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export const onbaseEmergencyContactOcrFormSpec: OcrFormSpec<
  PermissiveRecord,
  PreviewRecord,
  OnbaseInput
> = {
  ...emergencyContactOcrFormSpec,
  formType: "onbase-emergency-contact",
  label: "OnBase Emergency Contact",
  description:
    "UCSD R&R Emergency Contact forms imported into OnBase (X_HR_Emergency Contact). Approves into the onbase daemon.",

  approveTo: {
    workflow: "onbase",
    deriveInput(record, ctx): OnbaseInput {
      const eid = normalizeUcpathEmployeeId(record.employee.employeeId);
      const fullName = record.employee.name ?? "";
      const { lastName, firstName } = splitOcrName(fullName);
      return {
        ucpathId: eid,
        sourcePage: record.sourcePage,
        pdfFileId: ctx.pdfFileId ?? "",
        ...(ctx.pdfOriginalName ? { pdfOriginalName: ctx.pdfOriginalName } : {}),
        documentType: ONBASE_EC_DOCUMENT_TYPE,
        documentName: ONBASE_EC_DOCUMENT_NAME,
        ...(fullName ? { employeeName: fullName } : {}),
        ...(lastName ? { lastName } : {}),
        ...(firstName ? { firstName } : {}),
      };
    },
    deriveItemId(_record, parentRunId, index): string {
      return `ocr-onbase-${parentRunId}-r${index}`;
    },
    // Same EID-completeness gate as emergency-contact: a per-person import is
    // keyed by UCPath ID, so skip records without a resolvable EID.
    canFanOut: emergencyContactOcrFormSpec.approveTo!.canFanOut,
  },

  // No `traceCode`: an onbase upload always runs as an operation (targetWorkflow
  // = "onbase"), so the root brands `ob-…` via operationTraceCode("onbase").
};
