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
