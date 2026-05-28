export type DashboardRunSurface = "input" | "upload";

export const DASHBOARD_INPUT_RUN_WORKFLOWS = [
  "separations",
  "person-lookup",
  "oath-signature",
  "crm-doc-download",
] as const;

export const DASHBOARD_UPLOAD_RUN_WORKFLOWS = [
  "emergency-contact",
  "oath-signature",
  "ocr",
  "oath-upload",
] as const;

const DASHBOARD_INPUT_RUN_WORKFLOW_SET = new Set<string>(DASHBOARD_INPUT_RUN_WORKFLOWS);
const DASHBOARD_UPLOAD_RUN_WORKFLOW_SET = new Set<string>(DASHBOARD_UPLOAD_RUN_WORKFLOWS);

export function isDashboardInputRunWorkflow(workflow: string): boolean {
  return DASHBOARD_INPUT_RUN_WORKFLOW_SET.has(workflow);
}

export function isDashboardUploadRunWorkflow(workflow: string): boolean {
  return DASHBOARD_UPLOAD_RUN_WORKFLOW_SET.has(workflow);
}

