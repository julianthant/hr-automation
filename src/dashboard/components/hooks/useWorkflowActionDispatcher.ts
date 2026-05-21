import { useCallback } from "react";
import type {
  WorkflowActionDescriptor,
  WorkflowActionKind,
  WorkflowActionScope,
  WorkflowActionSource,
} from "../../../domain/workflow-runtime/types.js";
import { compact } from "@/lib/utils";
import { actionScopeBody, findEnabledAction } from "@/lib/workflow-action-utils";

export type WorkflowActionTransport =
  | "retry"
  | "delete-entry"
  | "cancel-queued"
  | "force-stop";

export type BulkWorkflowActionTransport =
  | "retry-bulk"
  | "delete-bulk";

export interface WorkflowActionFallbackTarget {
  workflowId: string;
  id: string;
  runId?: string;
  date?: string;
  status?: string;
}

export interface BuildWorkflowActionRequestArgs {
  transport: WorkflowActionTransport;
  kind: WorkflowActionKind;
  action?: WorkflowActionDescriptor;
  actions?: WorkflowActionDescriptor[];
  fallbackTarget: WorkflowActionFallbackTarget;
  parentRunId?: string;
  ocrSessionId?: string;
  parentWorkflow?: string;
  parentItemId?: string;
  formType?: string;
  reason?: string;
}

export interface WorkflowActionBulkItem {
  workflowId: string;
  id: string;
  runId?: string;
  date?: string;
}

export interface BuildBulkWorkflowActionRequestArgs {
  transport: BulkWorkflowActionTransport;
  kind: Extract<WorkflowActionKind, "retry" | "delete">;
  workflow: string;
  items: WorkflowActionBulkItem[];
  action?: WorkflowActionDescriptor;
  actions?: WorkflowActionDescriptor[];
  date?: string;
  parentRunId?: string;
  source?: WorkflowActionSource;
  scope?: WorkflowActionScope;
}

export interface WorkflowActionHttpRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface WorkflowActionDispatchResult<TBody = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: TBody;
  error?: string;
  request: WorkflowActionHttpRequest;
}

function resolveAction(
  kind: WorkflowActionKind,
  action?: WorkflowActionDescriptor,
  actions?: WorkflowActionDescriptor[],
): WorkflowActionDescriptor | undefined {
  return action ?? findEnabledAction(actions, kind);
}

function resolveTarget(
  action: WorkflowActionDescriptor | undefined,
  fallbackTarget: WorkflowActionFallbackTarget,
): WorkflowActionFallbackTarget {
  return action?.targets[0] ?? fallbackTarget;
}

function readError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `HTTP ${status}`;
}

export function buildWorkflowActionRequest({
  transport,
  kind,
  action,
  actions,
  fallbackTarget,
  parentRunId,
  ocrSessionId,
  parentWorkflow,
  parentItemId,
  formType,
  reason,
}: BuildWorkflowActionRequestArgs): WorkflowActionHttpRequest {
  const resolvedAction = resolveAction(kind, action, actions);
  const target = resolveTarget(resolvedAction, fallbackTarget);
  const workflow = target.workflowId || fallbackTarget.workflowId;
  const id = target.id || fallbackTarget.id;
  const runId = target.runId ?? fallbackTarget.runId;
  const date = target.date ?? fallbackTarget.date;

  if (transport === "retry") {
    return {
      path: "/api/retry",
      body: compact({ workflow, id, runId, date, parentRunId }),
    };
  }

  if (transport === "delete-entry") {
    return {
      path: "/api/delete-entry",
      body: compact({ workflow, id, runId, date }),
    };
  }

  if (transport === "cancel-queued") {
    return {
      path: "/api/cancel-queued",
      body: compact({
        workflow,
        id,
        runId,
        ...actionScopeBody(resolvedAction),
        ocrSessionId,
        parentWorkflow,
        parentRunId,
        parentItemId,
        formType,
        reason,
      }),
    };
  }

  return {
    path: "/api/task/force-stop",
    body: compact({
      workflow,
      id,
      runId,
      ...actionScopeBody(resolvedAction),
      ocrSessionId,
      parentWorkflow,
      parentRunId,
      parentItemId,
      formType,
      reason,
    }),
  };
}

export function buildBulkWorkflowActionRequest({
  transport,
  kind,
  workflow,
  items,
  action,
  actions,
  date,
  parentRunId,
  source,
  scope,
}: BuildBulkWorkflowActionRequestArgs): WorkflowActionHttpRequest {
  const resolvedAction = resolveAction(kind, action, actions);
  const resolvedSource = source ?? resolvedAction?.source;
  const resolvedScope = scope ?? resolvedAction?.scope;
  const normalizedItems = items.map((item) =>
    compact({
      workflowId: item.workflowId,
      id: item.id,
      runId: item.runId,
      date: item.date,
    }),
  );

  return {
    path: transport === "retry-bulk" ? "/api/retry-bulk" : "/api/delete-bulk",
    body: compact({
      workflow,
      items: normalizedItems,
      date,
      ...(transport === "retry-bulk" ? { parentRunId } : {}),
      source: resolvedSource,
      scope: resolvedScope,
    }),
  };
}

export async function postWorkflowActionRequest<TBody = Record<string, unknown>>(
  request: WorkflowActionHttpRequest,
): Promise<WorkflowActionDispatchResult<TBody>> {
  try {
    const res = await fetch(request.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
    });
    const body = (await res.json().catch(() => ({}))) as TBody;
    const bodyOk = body && typeof body === "object" && "ok" in body
      ? Boolean((body as { ok?: unknown }).ok)
      : res.ok;
    const ok = res.ok && bodyOk;
    return {
      ok,
      status: res.status,
      body,
      ...(ok ? {} : { error: readError(body, res.status) }),
      request,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {} as TBody,
      error: err instanceof Error ? err.message : String(err),
      request,
    };
  }
}

export function useWorkflowActionDispatcher() {
  const dispatchWorkflowAction = useCallback(
    <TBody = Record<string, unknown>>(args: BuildWorkflowActionRequestArgs) => {
      return postWorkflowActionRequest<TBody>(buildWorkflowActionRequest(args));
    },
    [],
  );
  const dispatchBulkWorkflowAction = useCallback(
    <TBody = Record<string, unknown>>(args: BuildBulkWorkflowActionRequestArgs) => {
      return postWorkflowActionRequest<TBody>(buildBulkWorkflowActionRequest(args));
    },
    [],
  );

  return { dispatchWorkflowAction, dispatchBulkWorkflowAction };
}
