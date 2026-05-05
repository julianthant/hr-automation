import { getAll as getAllRegisteredWorkflows } from "../../core/registry.js";
import type { WorkflowMetadata } from "../../core/types.js";

export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}
