// src/domain/workflow-presentation/schemes.ts
import { renderTemplate } from "./template.js";
import { formatTraceIdRunLabel } from "../queue-trace-id.js";
import type { NamingPartSubtitle, NamingPartTitle, NamingPartTrace } from "./types.js";
import { readQueueTitle } from "../queue-title.js";

export interface SchemeMeta {
  id: string;
  label: string;
  description: string;
}

const firstNonBlank = (...vals: Array<string | undefined>): string => {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return "";
};

/** EID guard: numeric only (mirrors queue-row-presentation's resolveEid). */
const eid = (vars: Record<string, string>): string => {
  const c = firstNonBlank(vars.emplId, vars.eid, vars.employeeId);
  return /^\d+$/.test(c) ? c : "";
};

const personName = (vars: Record<string, string>): string =>
  firstNonBlank(vars.name, vars.employeeName, vars.searchName, vars.__name, vars.__subject);

function parseRunOrdinal(vars: Record<string, string>): number | undefined {
  const raw = vars.runOrdinal;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function displayTrace(vars: Record<string, string>): string {
  return formatTraceIdRunLabel(firstNonBlank(vars.traceId, vars.__traceId), parseRunOrdinal(vars));
}

export function resolveTitle(vars: Record<string, string>, part: NamingPartTitle): string {
  switch (part.scheme) {
    case "person-name":
      return personName(vars);
    case "pdf-filename":
      return firstNonBlank(vars.pdfOriginalName, vars.__name, readQueueTitle(vars) ?? "");
    case "catalog-label":
      return firstNonBlank(readQueueTitle(vars) ?? "", vars.__name, vars.label);
    case "operation-anchor":
      return "";
    case "custom-template":
      return part.template ? renderTemplate(part.template, vars) : "";
  }
}

export function resolveSubtitle(vars: Record<string, string>, part: NamingPartSubtitle): string {
  const trace = displayTrace(vars);
  switch (part.scheme) {
    case "eid-else-trace":
      return eid(vars) || trace;
    case "trace-only":
      return trace;
    case "eid-only":
      return eid(vars);
    case "email":
      return firstNonBlank(vars.email);
    case "custom-template":
      return part.template ? renderTemplate(part.template, vars) : "";
  }
}

// Not wired into pre-emit trace stamping — display/preview only in v1 (see src/core/CLAUDE.md "Trace-scheme override caveat").
export function resolveTrace(vars: Record<string, string>, part: NamingPartTrace): string {
  switch (part.scheme) {
    case "code-time-runid":
      return renderTemplate("{code}-{HHMMSS}-{runId4}", vars);
    case "custom-template":
      return part.template ? renderTemplate(part.template, vars) : "";
  }
}

/** What the modifier page's dropdowns render. Order = display order. */
export const SCHEME_LIBRARY: { title: SchemeMeta[]; subtitle: SchemeMeta[]; trace: SchemeMeta[] } = {
  title: [
    { id: "person-name", label: "Person name", description: "Resolved employee name (in use: onboarding, separations, work-study, person-lookup)" },
    { id: "pdf-filename", label: "PDF filename", description: "Uploaded document name (in use: OCR, oath-upload, oath-signature)" },
    { id: "catalog-label", label: "Catalog / spec label", description: "Registry or spec label (in use: sharepoint-download)" },
    { id: "operation-anchor", label: "Operation anchor (no title)", description: "Count badge + member preview identify the row" },
    { id: "custom-template", label: "Custom template…", description: "Token template, e.g. {name} ({emplId})" },
  ],
  subtitle: [
    { id: "eid-else-trace", label: "EID, else trace id", description: "Current default across most workflows" },
    { id: "trace-only", label: "Trace id only", description: "In use: batch anchors, delegated members, file/catalog rows" },
    { id: "eid-only", label: "EID only", description: "Employee id, blank if absent" },
    { id: "email", label: "Email", description: "data.email" },
    { id: "custom-template", label: "Custom template…", description: "Token template, e.g. Oath · {runId4}" },
  ],
  trace: [
    { id: "code-time-runid", label: "{code}-{HHMMSS}-{runId4} (default)", description: "Universal scheme — keep unless you have a strong reason" },
    { id: "custom-template", label: "Custom template… (advanced)", description: "Only affects NEW runs; never rewrites a frozen trace id" },
  ],
};
