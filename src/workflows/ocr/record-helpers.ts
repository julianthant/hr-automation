import { normalizeUcpathEmployeeId } from "../../domain/identity/eid.js";
import type { AnyOcrFormSpec } from "./types.js";

/**
 * Extract the UCPath employee ID from an OCR record.
 * Checks top-level `employeeId` and nested `employee.employeeId`.
 */
export function extractOcrRecordEid(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return normalizeUcpathEmployeeId(r.employeeId);
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return normalizeUcpathEmployeeId(employee.employeeId);
  return "";
}

/**
 * Extract the carry-forward name from an OCR record using the form spec.
 */
export function extractOcrRecordName(record: unknown, spec: AnyOcrFormSpec): string {
  return spec.carryForwardKey(record as never);
}
