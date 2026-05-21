import type { Hono } from "hono";

import { listWorkflows } from "../../../jsonl.js";
import {
  buildCancelRunningHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  buildDeleteEntryHandler,
  buildDrainWorkerHandler,
  buildEntryReEnqueueHandler,
  buildFindPriorByKeyHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildSaveDataHandler,
  buildStopWorkerHandler,
  readQueueDepth,
} from "../../ops/index.js";
import { performWorkflowAction } from "../../actions/perform-workflow-action.js";
import type { WorkflowActionRequest, WorkflowActionResult, WorkflowActionScope } from "../../actions/types.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { PARENT_RUN_ID_VALIDATION_HINT, parseOptionalParentRunId } from "../parent-run-id.js";
import { postJson } from "../post-helper.js";
import { jsonResponse } from "../responses.js";
import type { CancelActiveBulkItem } from "../../ops/cancel.js";

/** Full success vs partial (207) vs all rows failed (422). Caller validates non-empty workload before invoke. */
function bulkMutationHttpStatus(succeededCount: number, errorCount: number): number {
  if (errorCount === 0) return 200;
  if (succeededCount === 0) return 422;
  return 207;
}

function parseParentRunIdFromBody(body: Record<string, unknown>):
  | { ok: true; parentRunId?: string }
  | { ok: false; error: string } {
  const parentRunId = parseOptionalParentRunId(body.parentRunId);
  if (body.parentRunId !== undefined && body.parentRunId !== null && !parentRunId) {
    return { ok: false, error: PARENT_RUN_ID_VALIDATION_HINT };
  }
  return parentRunId ? { ok: true, parentRunId } : { ok: true };
}

function parseRowCancelScope(value: unknown): WorkflowActionScope {
  return value === "tree" ? "tree" : "row";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOcrCancelContext(
  body: Record<string, unknown>,
): Pick<WorkflowActionRequest, "ocrSessionId" | "parentWorkflow" | "parentRunId" | "parentItemId" | "formType" | "reason"> {
  return {
    ...(optionalString(body.ocrSessionId) ? { ocrSessionId: optionalString(body.ocrSessionId) } : {}),
    ...(optionalString(body.parentWorkflow) ? { parentWorkflow: optionalString(body.parentWorkflow) } : {}),
    ...(optionalString(body.parentRunId) ? { parentRunId: optionalString(body.parentRunId) } : {}),
    ...(optionalString(body.parentItemId) ? { parentItemId: optionalString(body.parentItemId) } : {}),
    ...(optionalString(body.formType) ? { formType: optionalString(body.formType) } : {}),
    ...(optionalString(body.reason) ? { reason: optionalString(body.reason) } : {}),
  };
}

function parseItemsFromBody<T>(
  raw: unknown,
  parseRow: (row: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => row && typeof row === "object" ? parseRow(row as Record<string, unknown>) : null)
    .filter((item): item is T => item !== null);
}

/**
 * Map a {@link WorkflowActionResult} back to a per-row route's legacy
 * `{ ok }` / `{ ok, error, status }` shape. Used by routes that act on a
 * single target (`/api/cancel-queued`, `/api/retry`).
 */
function toSingleActionResult(
  result: WorkflowActionResult,
): { ok: boolean; error?: string; status?: number } {
  if (result.error && result.results.length === 0) {
    return { ok: false, error: result.error, status: 400 };
  }
  const first = result.results[0];
  if (!first) return { ok: false, error: "no action target", status: 400 };
  if (first.ok) return { ok: true };
  return {
    ok: false,
    error: first.error ?? "action failed",
    ...(first.status ? { status: first.status } : {}),
  };
}

/** Single-target variant that preserves force-stop's `commandId` payload. */
function toForceStopActionResult(
  result: WorkflowActionResult,
): { ok: boolean; commandId?: string; error?: string; status?: number } {
  if (result.error && result.results.length === 0) {
    return { ok: false, error: result.error, status: 400 };
  }
  const first = result.results[0];
  if (!first) return { ok: false, error: "no action target", status: 400 };
  if (first.ok) return { ok: true, commandId: String(first.detail?.commandId ?? "") };
  return {
    ok: false,
    error: first.error ?? "force stop failed",
    ...(first.status ? { status: first.status } : {}),
  };
}

/** Map a {@link WorkflowActionResult} to a bulk route's `{ ok, count, errors }` shape. */
function toBulkActionResult(
  result: WorkflowActionResult,
): { ok: true; count: number; errors: Array<{ id: string; error: string }> } {
  return { ok: true, count: result.count, errors: result.errors };
}

export function registerOpsRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/retry", async (c) => {
    return postJson(c, (body) => {
      const parent = parseParentRunIdFromBody(body);
      if (!parent.ok) return parent;
      return {
        workflow: String(body.workflow ?? ""),
        id: String(body.id ?? ""),
        runId: body.runId ? String(body.runId) : undefined,
        date: body.date ? String(body.date) : undefined,
        ...(parent.parentRunId ? { parentRunId: parent.parentRunId } : {}),
      };
    }, async (req: {
      workflow: string;
      id: string;
      runId?: string;
      date?: string;
      parentRunId?: string;
    }) => {
      const result = await performWorkflowAction({
        action: "retry",
        scope: "row",
        source: "queue-panel",
        workflowId: req.workflow,
        targets: [{
          workflowId: req.workflow,
          id: req.id,
          ...(req.runId ? { runId: req.runId } : {}),
          ...(req.date ? { date: req.date } : {}),
        }],
        ...(req.date ? { date: req.date } : {}),
        ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
      }, { dir: deps.dir });
      return toSingleActionResult(result);
    }, 202);
  });

  app.post("/api/retry-bulk", async (c) => {
    return postJson(c, (body) => {
      const parent = parseParentRunIdFromBody(body);
      if (!parent.ok) return parent;
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const items = Array.isArray(body.items)
        ? body.items
            .filter((item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
            )
            .map((item) => ({
              workflowId: item.workflowId ? String(item.workflowId) : undefined,
              id: String(item.id ?? ""),
              ...(item.runId ? { runId: String(item.runId) } : {}),
            }))
            .filter((item) => item.id)
        : undefined;
      return {
        workflow: String(body.workflow ?? ""),
        ids,
        ...(items ? { items } : {}),
        date: body.date ? String(body.date) : undefined,
        ...(parent.parentRunId ? { parentRunId: parent.parentRunId } : {}),
      };
    }, async (req: {
      workflow: string;
      ids: string[];
      items?: Array<{ workflowId?: string; id: string; runId?: string }>;
      date?: string;
      parentRunId?: string;
    }) => {
      const items: Array<{ workflowId?: string; id: string; runId?: string }> = req.items && req.items.length > 0
        ? req.items
        : req.ids.map((id) => ({ id }));
      const result = await performWorkflowAction({
        action: "retry",
        scope: "group",
        source: "queue-panel",
        workflowId: req.workflow,
        targets: items.map((it) => ({
          workflowId: it.workflowId ?? req.workflow,
          id: it.id,
          ...(it.runId ? { runId: it.runId } : {}),
          ...(req.date ? { date: req.date } : {}),
        })),
        ...(req.date ? { date: req.date } : {}),
        ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
      }, { dir: deps.dir });
      return toBulkActionResult(result);
    }, 202);
  });

  app.post("/api/run-with-data", async (c) => {
    return postJson(c, (body) => {
      const parent = parseParentRunIdFromBody(body);
      if (!parent.ok) return parent;
      const data = body.data && typeof body.data === "object"
        ? body.data as Record<string, unknown>
        : {};
      return {
        workflow: String(body.workflow ?? ""),
        id: String(body.id ?? ""),
        runId: body.runId ? String(body.runId) : undefined,
        date: body.date ? String(body.date) : undefined,
        data,
        ...(parent.parentRunId ? { parentRunId: parent.parentRunId } : {}),
      };
    }, buildEntryReEnqueueHandler(deps.dir, { withData: true }), 202);
  });

  app.post("/api/save-data", async (c) => {
    return postJson(c, (body) => {
      const data = body.data && typeof body.data === "object"
        ? body.data as Record<string, unknown>
        : {};
      return {
        workflow: String(body.workflow ?? ""),
        id: String(body.id ?? ""),
        date: body.date ? String(body.date) : undefined,
        data,
      };
    }, buildSaveDataHandler(deps.dir));
  });

  app.get("/api/find-prior-by-key", (c) => {
    const days = Number.parseInt(c.req.query("days") ?? "", 10);
    const result = buildFindPriorByKeyHandler(deps.dir)({
      workflow: c.req.query("workflow") ?? "",
      keyField: c.req.query("keyField") ?? "",
      keyValue: c.req.query("keyValue") ?? "",
      excludeId: c.req.query("excludeId") ?? undefined,
      days: Number.isFinite(days) ? days : undefined,
    });
    return jsonResponse(result, result.ok ? 200 : 400);
  });

  app.post("/api/cancel-queued", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      id: String(body.id ?? ""),
      runId: body.runId ? String(body.runId) : undefined,
      scope: parseRowCancelScope(body.scope),
      ...parseOcrCancelContext(body),
    }), async (req: {
      workflow: string;
      id: string;
      runId?: string;
      scope: WorkflowActionScope;
      ocrSessionId?: string;
      parentWorkflow?: string;
      parentRunId?: string;
      parentItemId?: string;
      formType?: string;
      reason?: string;
    }) => {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: req.scope,
        source: "queue-panel",
        workflowId: req.workflow,
        cancelMode: "cooperative",
        ...(req.ocrSessionId ? { ocrSessionId: req.ocrSessionId } : {}),
        ...(req.parentWorkflow ? { parentWorkflow: req.parentWorkflow } : {}),
        ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
        ...(req.parentItemId ? { parentItemId: req.parentItemId } : {}),
        ...(req.formType ? { formType: req.formType } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
        targets: [{
          workflowId: req.workflow,
          id: req.id,
          status: "pending",
          ...(req.runId ? { runId: req.runId } : {}),
        }],
      }, { dir: deps.dir });
      return toSingleActionResult(result);
    });
  });

  app.post("/api/cancel-running", async (c) => {
    return postJson(c, (body) => {
      const workflow = String(body.workflow ?? "");
      const id = String(body.id ?? "");
      const runId = String(body.runId ?? "");
      if (!workflow || !id || !runId) {
        return { ok: false, error: "workflow, id, runId are required" };
      }
      return { workflow, id, runId };
    }, buildCancelRunningHandler(deps.dir));
  });

  app.post("/api/cancel-active-bulk", async (c) => {
    return postJson(c, (body) => {
      const workflow = String(body.workflow ?? "").trim();
      if (!workflow) return { ok: false, error: "workflow is required" };
      const items = parseItemsFromBody<CancelActiveBulkItem>(body.items, (o) => {
        const id = typeof o.id === "string" ? o.id : "";
        const status = o.status === "pending" || o.status === "running" ? o.status : null;
        if (!id || !status) return null;
        const runId = typeof o.runId === "string" && o.runId.length > 0 ? o.runId : undefined;
        return runId ? { id, status, runId } : { id, status };
      });
      if (items.length === 0) {
        return { ok: false, error: "items must be a non-empty array of { id, status }" };
      }
      return { workflow, items };
    }, async (req: { workflow: string; items: CancelActiveBulkItem[] }) => {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "visible-view",
        source: "queue-panel",
        workflowId: req.workflow,
        cancelMode: "cooperative",
        targets: req.items.map((it) => ({
          workflowId: req.workflow,
          id: it.id,
          status: it.status,
          ...(it.runId ? { runId: it.runId } : {}),
        })),
      }, { dir: deps.dir });
      return toBulkActionResult(result);
    }, (result) => bulkMutationHttpStatus(result.count, result.errors.length));
  });

  app.post("/api/task/force-stop", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      id: String(body.id ?? ""),
      runId: body.runId ? String(body.runId) : undefined,
      scope: parseRowCancelScope(body.scope),
      ...parseOcrCancelContext(body),
    }), async (req: {
      workflow: string;
      id: string;
      runId?: string;
      scope: WorkflowActionScope;
      ocrSessionId?: string;
      parentWorkflow?: string;
      parentRunId?: string;
      parentItemId?: string;
      formType?: string;
      reason?: string;
    }) => {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: req.scope,
        source: "queue-panel",
        workflowId: req.workflow,
        cancelMode: "force",
        ...(req.ocrSessionId ? { ocrSessionId: req.ocrSessionId } : {}),
        ...(req.parentWorkflow ? { parentWorkflow: req.parentWorkflow } : {}),
        ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
        ...(req.parentItemId ? { parentItemId: req.parentItemId } : {}),
        ...(req.formType ? { formType: req.formType } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
        targets: [{
          workflowId: req.workflow,
          id: req.id,
          ...(req.runId ? { runId: req.runId } : {}),
        }],
      }, { dir: deps.dir });
      return toForceStopActionResult(result);
    }, 202);
  });

  app.post("/api/browser/kill", async (c) => {
    return postJson(c, (body) => ({
      browserProcessId: body.browserProcessId ? String(body.browserProcessId) : undefined,
      pid: typeof body.pid === "number" ? body.pid : undefined,
    }), buildKillBrowserHandler(deps.dir), 202);
  });

  app.post("/api/worker/drain", async (c) => {
    return postJson(c, (body) => ({
      workerId: String(body.workerId ?? ""),
    }), buildDrainWorkerHandler(deps.dir), 202);
  });

  app.post("/api/worker/stop", async (c) => {
    return postJson(c, (body) => ({
      workerId: String(body.workerId ?? ""),
    }), buildStopWorkerHandler(deps.dir), 202);
  });

  app.post("/api/queue/bump", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      id: String(body.id ?? ""),
      runId: body.runId ? String(body.runId) : undefined,
    }), buildQueueBumpHandler(deps.dir));
  });

  app.get("/api/daemons", async (c) => {
    const workflow = c.req.query("workflow") ?? undefined;
    return jsonResponse(await buildDaemonsListHandler(deps.dir)(workflow));
  });

  app.post("/api/daemons/spawn", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      count: typeof body.count === "number" ? body.count : 1,
    }), (body) => {
      const handler = buildDaemonsSpawnHandler(deps.dir);
      void handler(body).catch((err) => {
        log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
      });
      return { ok: true, queued: body.count };
    }, 202);
  });

  app.post("/api/daemons/stop", async (c) => {
    return postJson(c, (body) => ({
      workflow: body.workflow ? String(body.workflow) : undefined,
      force: body.force === true,
    }), buildDaemonsStopHandler(deps.dir));
  });

  app.get("/api/queue-depth", () => {
    const workflows = listWorkflows(deps.dir);
    const result: Record<string, number> = {};
    for (const workflow of workflows) {
      result[workflow] = readQueueDepth(workflow, deps.dir);
    }
    return jsonResponse(result);
  });

  app.post("/api/delete-entry", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      id: String(body.id ?? ""),
      date: String(body.date ?? ""),
      runId: body.runId ? String(body.runId) : undefined,
    }), buildDeleteEntryHandler(deps.dir, { screenshotsDir: deps.screenshotsDir }));
  });

  app.post("/api/delete-bulk", async (c) => {
    return postJson(c, (body) => {
      const workflow = String(body.workflow ?? "").trim();
      const date = String(body.date ?? "").trim();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const items = parseItemsFromBody<{ workflowId?: string; id: string; runId?: string }>(body.items, (o) => {
        const id = typeof o.id === "string" ? o.id : "";
        if (!id) return null;
        const runId = typeof o.runId === "string" && o.runId.length > 0 ? o.runId : undefined;
        const workflowId = typeof o.workflowId === "string" && o.workflowId.length > 0 ? o.workflowId : undefined;
        return {
          ...(workflowId ? { workflowId } : {}),
          id,
          ...(runId ? { runId } : {}),
        };
      });
      if (!workflow || !date) {
        return { ok: false, error: "workflow and date are required" };
      }
      if (items.length === 0 && ids.length === 0) {
        return { ok: false, error: "ids or items must be non-empty — provide at least one entry to delete" };
      }
      return { workflow, date, ids, items };
    }, async (req: {
      workflow: string;
      date: string;
      ids: string[];
      items: Array<{ workflowId?: string; id: string; runId?: string }>;
    }) => {
      const items: Array<{ workflowId?: string; id: string; runId?: string }> = req.items.length > 0
        ? req.items
        : req.ids.map((id) => ({ id }));
      const result = await performWorkflowAction({
        action: "delete",
        scope: "group",
        source: "queue-panel",
        workflowId: req.workflow,
        date: req.date,
        targets: items.map((it) => ({
          workflowId: it.workflowId ?? req.workflow,
          id: it.id,
          date: req.date,
          ...(it.runId ? { runId: it.runId } : {}),
        })),
      }, { dir: deps.dir, screenshotsDir: deps.screenshotsDir });
      return toBulkActionResult(result);
    }, (result) => bulkMutationHttpStatus(result.count, result.errors.length));
  });
}
