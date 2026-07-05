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
