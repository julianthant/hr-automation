import type { AnyOcrPreviewRecord } from "@/lib/ocr-downstream-registry";
import type { OathPreviewRecord, PreviewRecord, VerifyPreviewRecord } from "./types";

type AnyPreviewRecord = AnyOcrPreviewRecord;

/**
 * Continuation/server patches win over stale localStorage prep snapshots.
 * Operator edits keep mutable form fields only; verify rows are read-only, so
 * fresh server enrichment owns the whole record except local selection state.
 */
export function overlayServerOwnedPrepFields(
  baseRecord: AnyPreviewRecord | undefined,
  local: AnyPreviewRecord,
): AnyPreviewRecord {
  if (!baseRecord) return local;
  if (baseRecord.formKind !== local.formKind) {
    console.warn(
      "[OcrReviewPane] overlayServerOwnedPrepFields: variant mismatch",
      { baseKind: baseRecord.formKind, localKind: local.formKind },
    );
    return local;
  }
  if (isVerifyPreviewRecord(baseRecord) && isVerifyPreviewRecord(local)) {
    return {
      ...baseRecord,
      selected: local.selected,
    };
  }
  if (isOathPreviewRecord(local) && isOathPreviewRecord(baseRecord)) {
    return {
      ...local,
      verification: baseRecord.verification,
      matchState: baseRecord.matchState,
      matchSource: baseRecord.matchSource,
      warnings: baseRecord.warnings,
    };
  }
  if (isEmergencyContactPreviewRecord(local) && isEmergencyContactPreviewRecord(baseRecord)) {
    return {
      ...local,
      verification: baseRecord.verification,
      matchState: baseRecord.matchState,
      matchSource: baseRecord.matchSource,
      warnings: baseRecord.warnings,
    };
  }
  return local;
}

function isVerifyPreviewRecord(record: AnyPreviewRecord): record is VerifyPreviewRecord {
  return "checks" in record;
}

function isOathPreviewRecord(record: AnyPreviewRecord): record is OathPreviewRecord {
  return "rowIndex" in record && "printedName" in record && !("checks" in record);
}

function isEmergencyContactPreviewRecord(record: AnyPreviewRecord): record is PreviewRecord {
  return "employee" in record;
}
