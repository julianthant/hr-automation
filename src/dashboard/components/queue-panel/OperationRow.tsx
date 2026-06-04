import {
  OperationRowUnified,
  type OperationRowUnifiedProps,
} from "./operation-row-variants";

export type OperationRowProps = OperationRowUnifiedProps;

/**
 * Top-level coordinator row for an OCR-backed target workflow
 * (oath-signature, emergency-contact). One card: header (status + optional
 * OCR review jump) → work zone (active OCR prep or member summary) → footer.
 */
export function OperationRow(props: OperationRowProps) {
  return <OperationRowUnified {...props} />;
}
