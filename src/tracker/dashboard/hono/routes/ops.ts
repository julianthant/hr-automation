import type { Hono } from "hono";

import { listWorkflows } from "../../../jsonl.js";
import {
  buildCancelQueuedHandler,
  buildCancelRunningHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  buildDeleteEntryHandler,
  buildDrainWorkerHandler,
  buildFindPriorByKeyHandler,
  buildForceStopTaskHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildRetryBulkHandler,
  buildRetryHandler,
  buildRunWithDataHandler,
  buildSaveDataHandler,
  buildStopWorkerHandler,
  readQueueDepth,
} from "../../ops/index.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { PARENT_RUN_ID_VALIDATION_HINT, parseOptionalParentRunId } from "../parent-run-id.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerOpsRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/retry", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const body = parsed.body as { parentRunId?: unknown };
    const parentRunId = parseOptionalParentRunId(body.parentRunId);
    if (body.parentRunId !== undefined && body.parentRunId !== null && !parentRunId) {
      return jsonResponse({ ok: false, error: PARENT_RUN_ID_VALIDATION_HINT }, 400);
    }
    const result = await buildRetryHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      ...(parentRunId ? { parentRunId } : {}),
    });
    return jsonResponse(result, result.ok ? 202 : 400);
  });

  app.post("/api/retry-bulk", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const body = parsed.body as { parentRunId?: unknown };
    const parentRunId = parseOptionalParentRunId(body.parentRunId);
    if (body.parentRunId !== undefined && body.parentRunId !== null && !parentRunId) {
      return jsonResponse({ ok: false, error: PARENT_RUN_ID_VALIDATION_HINT }, 400);
    }
    const ids = Array.isArray(parsed.body.ids) ? (parsed.body.ids as unknown[]).map(String) : [];
    const result = await buildRetryBulkHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      ids,
      ...(parentRunId ? { parentRunId } : {}),
    });
    return jsonResponse(result, 202);
  });

  app.post("/api/run-with-data", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const body = parsed.body as { parentRunId?: unknown };
    const parentRunId = parseOptionalParentRunId(body.parentRunId);
    if (body.parentRunId !== undefined && body.parentRunId !== null && !parentRunId) {
      return jsonResponse({ ok: false, error: PARENT_RUN_ID_VALIDATION_HINT }, 400);
    }
    const data = parsed.body.data && typeof parsed.body.data === "object"
      ? parsed.body.data as Record<string, unknown>
      : {};
    const result = await buildRunWithDataHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      data,
      ...(parentRunId ? { parentRunId } : {}),
    });
    return jsonResponse(result, result.ok ? 202 : 400);
  });

  app.post("/api/save-data", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const data = parsed.body.data && typeof parsed.body.data === "object"
      ? parsed.body.data as Record<string, unknown>
      : {};
    const result = await buildSaveDataHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      data,
    });
    return jsonResponse(result, result.ok ? 200 : 400);
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
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildCancelQueuedHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
    });
    return jsonResponse(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/cancel-running", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const workflow = String(parsed.body.workflow ?? "");
    const id = String(parsed.body.id ?? "");
    const runId = String(parsed.body.runId ?? "");
    if (!workflow || !id || !runId) {
      return jsonResponse({ ok: false, error: "workflow, id, runId are required" }, 400);
    }
    const result = await buildCancelRunningHandler(deps.dir)({ workflow, id, runId });
    return jsonResponse(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/task/force-stop", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildForceStopTaskHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
    });
    return jsonResponse(result, result.ok ? 202 : (result.status ?? 400));
  });

  app.post("/api/browser/kill", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const pid = typeof parsed.body.pid === "number" ? parsed.body.pid : undefined;
    const result = await buildKillBrowserHandler(deps.dir)({
      browserProcessId: parsed.body.browserProcessId ? String(parsed.body.browserProcessId) : undefined,
      pid,
    });
    return jsonResponse(result, result.ok ? 202 : (result.status ?? 400));
  });

  app.post("/api/worker/drain", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildDrainWorkerHandler(deps.dir)({
      workerId: String(parsed.body.workerId ?? ""),
    });
    return jsonResponse(result, result.ok ? 202 : (result.status ?? 400));
  });

  app.post("/api/worker/stop", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildStopWorkerHandler(deps.dir)({
      workerId: String(parsed.body.workerId ?? ""),
    });
    return jsonResponse(result, result.ok ? 202 : (result.status ?? 400));
  });

  app.post("/api/queue/bump", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildQueueBumpHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
    });
    return jsonResponse(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.get("/api/daemons", async (c) => {
    const workflow = c.req.query("workflow") ?? undefined;
    return jsonResponse(await buildDaemonsListHandler(deps.dir)(workflow));
  });

  app.post("/api/daemons/spawn", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const count = typeof parsed.body.count === "number" ? parsed.body.count : 1;
    const handler = buildDaemonsSpawnHandler(deps.dir);
    void handler({
      workflow: String(parsed.body.workflow ?? ""),
      count,
    }).catch((err) => {
      log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
    });
    return jsonResponse({ ok: true, queued: count }, 202);
  });

  app.post("/api/daemons/stop", async (c) => {
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await buildDaemonsStopHandler(deps.dir)({
      workflow: parsed.body.workflow ? String(parsed.body.workflow) : undefined,
      force: parsed.body.force === true,
    });
    return jsonResponse(result);
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
    const parsed = await readJsonRequest(c.req.raw);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = buildDeleteEntryHandler(deps.dir)({
      workflow: String(parsed.body.workflow ?? ""),
      id: String(parsed.body.id ?? ""),
      date: String(parsed.body.date ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
    });
    return jsonResponse(result, result.ok ? 200 : (result.status ?? 400));
  });
}
