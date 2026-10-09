import type { WorkflowActionDescriptor } from "../../domain/workflow-runtime/types.js";

export function findEnabledAction(
  actions: WorkflowActionDescriptor[] | undefined,
  kind: WorkflowActionDescriptor["kind"],
): WorkflowActionDescriptor | undefined {
  return actions?.find((action) => action.kind === kind && action.enabled);
}

export function hasEnabledAction(
  actions: WorkflowActionDescriptor[] | undefined,
  kind: WorkflowActionDescriptor["kind"],
): boolean {
  if (!actions) return true;
  return Boolean(findEnabledAction(actions, kind));
}

export function actionScopeBody(
  action: WorkflowActionDescriptor | undefined,
): { scope?: string } {
  return action && action.scope !== "row" ? { scope: action.scope } : {};
}
