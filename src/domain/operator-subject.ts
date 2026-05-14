import { displayEid } from "./identity/eid.js";
import { displayPersonName } from "./identity/person-name.js";

export type OperatorSubjectKind =
  | "person"
  | "eid"
  | "document"
  | "email"
  | "pdf"
  | "report"
  | "roster"
  | "workflow"
  | "unknown";

export interface OperatorSubject {
  kind: OperatorSubjectKind;
  label: string;
}

export function buildOperatorSubject(input: {
  kind: OperatorSubjectKind;
  value: string | number | null | undefined;
  prefix?: string;
}): OperatorSubject {
  const raw = input.value == null ? "" : String(input.value).trim();
  let label = raw;
  if (input.kind === "person") label = displayPersonName(raw);
  if (input.kind === "eid") label = displayEid(raw);
  if (input.prefix && label) label = `${input.prefix} ${label}`;
  return {
    kind: label ? input.kind : "unknown",
    label,
  };
}

export function operatorSubjectData(subject: OperatorSubject | null | undefined): Record<string, string> {
  if (!subject?.label) return {};
  return {
    __subject: subject.label,
    __subjectKind: subject.kind,
  };
}

export function resolveOperatorSubjectFromData(
  data: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  const subject = data?.__subject;
  return typeof subject === "string" && subject.trim() ? subject : fallback;
}

/**
 * Stamps the inherited group label that delegated rows display in the
 * dashboard. When a child workflow is enqueued by a parent (e.g. OCR
 * delegated by oath-signature), the parent's `data.__name` is passed
 * forward via this field so every row in the delegation chain renders
 * with the same `<Workflow> · #<runIdSuffix>` label.
 *
 * The receiving workflow's `onPreEmitPending` reads this value and copies
 * it into the row's `data.__name` so `resolveEntryName` returns the
 * batch label rather than the per-row identity.
 */
export function parentSubjectData(value: string | undefined): { parentSubject?: string } {
  if (!value) return {};
  return { parentSubject: value };
}

export function readParentSubject(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const v = data.parentSubject;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
