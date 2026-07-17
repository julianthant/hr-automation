import { getAll as getAllRegisteredWorkflows } from "../../core/kernel/registry.js";
import type { WorkflowMetadata } from "../../core/kernel/types.js";

// Dashboard metadata is populated by defineWorkflow() side effects at module
// load. Daemon-capable workflows are otherwise lazy-loaded only when enqueued,
// so import their barrels here to make /api/workflow-definitions complete at
// dashboard startup.
import "../../workflows/crm-doc-download/index.js";
import "../../workflows/emergency-contact/index.js";
import "../../workflows/oath-signature/index.js";
import "../../workflows/oath-upload/index.js";
import "../../workflows/onbase/index.js";
import "../../workflows/onboarding/index.js";
import "../../workflows/ocr/index.js";
import "../../workflows/person-lookup/index.js";
import "../../workflows/separations/index.js";
import "../../workflows/i9-check/index.js";
import "../../workflows/sharepoint-download/index.js";
import "../../workflows/work-study/index.js";
import "../../workflows/kronos-pay-rule/index.js";
import "../../workflows/i9-lookup/index.js";
import "../../workflows/person-match/index.js";

export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}
