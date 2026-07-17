export type DashboardRunSurface = "input" | "upload";

export const DASHBOARD_INPUT_RUN_WORKFLOWS = [
  "separations",
  "person-lookup",
  "oath-signature",
  "crm-doc-download",
  "onboarding",
  "kronos-pay-rule",
] as const;

export const DASHBOARD_UPLOAD_RUN_WORKFLOWS = [
  "emergency-contact",
  "ocr",
  "oath-upload",
  "oath-signature",
  "onbase",
  // "Run I-9 Check": upload a scanned I-9 packet; OCR reads each person's
  // Section 1 + Section 2 pages, then one i9-check task per person searches
  // UCPath and fills the retention tracker. The upload lived on `separations`
  // before the 2026-07-17 i9-check workflow split.
  "i9-check",
] as const;

export const RETIRED_DASHBOARD_WORKFLOWS = [
  "active-check",
  "eid-lookup",
] as const;

const DASHBOARD_INPUT_RUN_WORKFLOW_SET = new Set<string>(DASHBOARD_INPUT_RUN_WORKFLOWS);
const DASHBOARD_UPLOAD_RUN_WORKFLOW_SET = new Set<string>(DASHBOARD_UPLOAD_RUN_WORKFLOWS);
const RETIRED_DASHBOARD_WORKFLOW_SET = new Set<string>(RETIRED_DASHBOARD_WORKFLOWS);

export function isDashboardInputRunWorkflow(workflow: string): boolean {
  return DASHBOARD_INPUT_RUN_WORKFLOW_SET.has(workflow);
}

export function isDashboardUploadRunWorkflow(workflow: string): boolean {
  return DASHBOARD_UPLOAD_RUN_WORKFLOW_SET.has(workflow);
}

export function isRetiredDashboardWorkflow(workflow: string): boolean {
  return RETIRED_DASHBOARD_WORKFLOW_SET.has(workflow);
}

export function filterRetiredDashboardWorkflows(workflows: string[]): string[] {
  return workflows.filter((workflow) => !isRetiredDashboardWorkflow(workflow));
}

export function filterRetiredDashboardWorkflowCounts(
  counts: Record<string, number>,
): Record<string, number> {
  const filtered: Record<string, number> = {};
  for (const [workflow, count] of Object.entries(counts)) {
    if (!isRetiredDashboardWorkflow(workflow)) filtered[workflow] = count;
  }
  return filtered;
}
