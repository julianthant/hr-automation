import { getAll as getAllRegisteredWorkflows } from "../../core/kernel/registry.js";
import type { WorkflowMetadata } from "../../core/kernel/types.js";

export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}
