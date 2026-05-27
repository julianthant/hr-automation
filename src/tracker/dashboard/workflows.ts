import { getAll as getAllRegisteredWorkflows } from "../../core/kernel/registry.js";
import type { WorkflowMetadata } from "../../core/kernel/types.js";

// Dashboard metadata is populated by defineWorkflow() side effects at module
// load. Daemon-capable workflows are otherwise lazy-loaded only when enqueued,
// so import their barrels here to make /api/workflow-definitions complete at
// dashboard startup.
import "../../workflows/active-check/index.js";
import "../../workflows/crm-doc-download/index.js";
import "../../workflows/eid-lookup/index.js";
import "../../workflows/emergency-contact/index.js";
import "../../workflows/oath-signature/index.js";
import "../../workflows/oath-upload/index.js";
import "../../workflows/onboarding/index.js";
import "../../workflows/ocr/index.js";
import "../../workflows/separations/index.js";
import "../../workflows/sharepoint-download/index.js";
import "../../workflows/work-study/index.js";

export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}
