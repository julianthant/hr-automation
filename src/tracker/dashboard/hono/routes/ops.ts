import type { Hono } from "hono";

import { listWorkflows } from "../../../jsonl.js";
import {
  buildCancelActiveBulkHandler,
  buildCancelQueuedHandler,
  buildCancelRunningHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  buildDeleteBulkHandler,
  buildDeleteEntryHandler,
  buildDrainWorkerHandler,
  buildEntryReEnqueueHandler,
  buildFindPriorByKeyHandler,
  buildForceStopTaskHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildRetryBulkHandler,
  buildSaveDataHandler,
  buildStopWorkerHandler,
  readQueueDepth,
} from "../../ops/index.js";
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

function parseItemsFromBody<T>(
  raw: unknown,
  parseRow: (row: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => row && typeof row === "object" ? parseRow(row as Record<string, unknown>) : null)
    .filter((item): item is T => item !== null);
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
    }, buildEntryReEnqueueHandler(deps.dir), 202);
  });

  app.post("/api/retry-bulk", async (c) => {
    return postJson(c, (body) => {
      const parent = parseParentRunIdFromBody(body);
      if (!parent.ok) return parent;
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return {
        workflow: String(body.workflow ?? ""),
        ids,
        date: body.date ? String(body.date) : undefined,
        ...(parent.parentRunId ? { parentRunId: parent.parentRunId } : {}),
      };
    }, buildRetryBulkHandler(deps.dir), 202);
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
    }), buildCancelQueuedHandler(deps.dir));
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
    }, buildCancelActiveBulkHandler(deps.dir), (result) => bulkMutationHttpStatus(result.count, result.errors.length));
  });

  app.post("/api/task/force-stop", async (c) => {
    return postJson(c, (body) => ({
      workflow: String(body.workflow ?? ""),
      id: String(body.id ?? ""),
      runId: body.runId ? String(body.runId) : undefined,
    }), buildForceStopTaskHandler(deps.dir), 202);
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
      const items = parseItemsFromBody<{ id: string; runId?: string }>(body.items, (o) => {
        const id = typeof o.id === "string" ? o.id : "";
        if (!id) return null;
        const runId = typeof o.runId === "string" && o.runId.length > 0 ? o.runId : undefined;
        return runId ? { id, runId } : { id };
      });
      if (!workflow || !date) {
        return { ok: false, error: "workflow and date are required" };
      }
      if (items.length === 0 && ids.length === 0) {
        return { ok: false, error: "ids or items must be non-empty — provide at least one entry to delete" };
      }
      return { workflow, date, ids, items };
    }, (body) => {
      const result = buildDeleteBulkHandler(deps.dir, { screenshotsDir: deps.screenshotsDir })(body as {
        workflow: string;
        date: string;
        ids: string[];
        items: Array<{ id: string; runId?: string }>;
      });
      if (!result.ok) {
        return { ok: false, error: result.errors[0]?.error ?? "invalid request", count: 0, errors: result.errors };
      }
      return result;
    }, (result) => result.ok ? bulkMutationHttpStatus(result.count, result.errors.length) : 400);
  });
}
