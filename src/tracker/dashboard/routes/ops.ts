import { createReadStream, statSync, watchFile, unwatchFile } from "node:fs";
import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson, writeSseHeaders } from "../http.js";
import { listWorkflows } from "../../jsonl.js";
import {
  buildCancelRunningHandler,
  buildRetryHandler,
  buildRetryBulkHandler,
  buildFindPriorByKeyHandler,
  buildRunWithDataHandler,
  buildSaveDataHandler,
  buildCancelQueuedHandler,
  buildDrainWorkerHandler,
  buildForceStopTaskHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  buildStopWorkerHandler,
  resolveDaemonLogPath,
  readQueueDepth,
} from "../../dashboard-ops.js";
import { errorMessage } from "../../../utils/errors.js";
import { log } from "../../../utils/log.js";

export function createOpsRoutes(): DashboardRoute {
  return async (req, res, url, ctx) => {
    const { dir } = ctx;

    if (req.method === "POST" && url.pathname === "/api/retry") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildRetryHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      });
      writeJson(res, result.ok ? 202 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/retry-bulk") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const ids = Array.isArray(parsed.body.ids)
        ? (parsed.body.ids as unknown[]).map(String)
        : [];
      const result = await buildRetryBulkHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        ids,
      });
      writeJson(res, 202, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/run-with-data") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const data =
        parsed.body.data && typeof parsed.body.data === "object"
          ? (parsed.body.data as Record<string, unknown>)
          : {};
      const result = await buildRunWithDataHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
        data,
      });
      writeJson(res, result.ok ? 202 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/save-data") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const data =
        parsed.body.data && typeof parsed.body.data === "object"
          ? (parsed.body.data as Record<string, unknown>)
          : {};
      const result = await buildSaveDataHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        data,
      });
      writeJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/find-prior-by-key") {
      const wf = url.searchParams.get("workflow") ?? "";
      const keyField = url.searchParams.get("keyField") ?? "";
      const keyValue = url.searchParams.get("keyValue") ?? "";
      const excludeId = url.searchParams.get("excludeId") ?? undefined;
      const days = Number.parseInt(url.searchParams.get("days") ?? "", 10);
      const result = buildFindPriorByKeyHandler(dir)({
        workflow: wf,
        keyField,
        keyValue,
        excludeId,
        days: Number.isFinite(days) ? days : undefined,
      });
      writeJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel-queued") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildCancelQueuedHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(res, status, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel-running") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const workflow = String(parsed.body.workflow ?? "");
      const itemId = String(parsed.body.id ?? "");
      const runId = String(parsed.body.runId ?? "");
      if (!workflow || !itemId || !runId) {
        writeJson(res, 400, {
          ok: false,
          error: "workflow, id, runId are required",
        });
        return true;
      }
      const result = await buildCancelRunningHandler(dir)({ workflow, id: itemId, runId });
      writeJson(res, result.ok ? 200 : (result.status ?? 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/task/force-stop") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildForceStopTaskHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      });
      writeJson(res, result.ok ? 202 : (result.status ?? 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/browser/kill") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const pid = typeof parsed.body.pid === "number" ? parsed.body.pid : undefined;
      const result = await buildKillBrowserHandler(dir)({
        browserProcessId: parsed.body.browserProcessId ? String(parsed.body.browserProcessId) : undefined,
        pid,
      });
      writeJson(res, result.ok ? 202 : (result.status ?? 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/worker/drain") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildDrainWorkerHandler(dir)({
        workerId: String(parsed.body.workerId ?? ""),
      });
      writeJson(res, result.ok ? 202 : (result.status ?? 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/worker/stop") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildStopWorkerHandler(dir)({
        workerId: String(parsed.body.workerId ?? ""),
      });
      writeJson(res, result.ok ? 202 : (result.status ?? 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/queue/bump") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildQueueBumpHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(res, status, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/daemons") {
      const workflow = url.searchParams.get("workflow") ?? undefined;
      const list = await buildDaemonsListHandler(dir)(workflow ?? undefined);
      writeJson(res, 200, list);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/spawn") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const count = typeof parsed.body.count === "number" ? parsed.body.count : 1;
      const handler = buildDaemonsSpawnHandler(dir);
      void handler({
        workflow: String(parsed.body.workflow ?? ""),
        count,
      }).catch((err) => {
        log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
      });
      writeJson(res, 202, { ok: true, queued: count });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/stop") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await buildDaemonsStopHandler(dir)({
        workflow: parsed.body.workflow ? String(parsed.body.workflow) : undefined,
        force: parsed.body.force === true,
      });
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/events/daemon-log") {
      const pidStr = url.searchParams.get("pid") ?? "";
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        writeJson(res, 400, { ok: false, error: "valid pid query param required" });
        return true;
      }
      const path = await resolveDaemonLogPath(pid, dir);
      if (!path) {
        writeJson(res, 404, { ok: false, error: "no log file for that pid" });
        return true;
      }
      writeSseHeaders(res);
      let bytesSent = 0;
      try {
        const stat = statSync(path);
        const tailBytes = Math.min(stat.size, 4096);
        const startAt = Math.max(0, stat.size - tailBytes);
        const stream = createReadStream(path, { start: startAt, end: stat.size });
        for await (const chunk of stream) {
          for (const line of String(chunk).split("\n")) {
            if (!line) continue;
            res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
          }
        }
        bytesSent = stat.size;
      } catch {
        /* ignore - file may be empty */
      }
      const onChange = (curr: { size: number }): void => {
        if (curr.size <= bytesSent) return;
        try {
          const stream = createReadStream(path, { start: bytesSent, end: curr.size });
          let buffered = "";
          stream.on("data", (chunk) => {
            buffered += String(chunk);
          });
          stream.on("end", () => {
            for (const line of buffered.split("\n")) {
              if (!line) continue;
              res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
            }
            bytesSent = curr.size;
          });
        } catch {
          /* ignore */
        }
      };
      watchFile(path, { interval: 500 }, onChange);
      req.on("close", () => {
        unwatchFile(path, onChange);
        res.end();
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/queue-depth") {
      const workflows = listWorkflows(dir);
      const result: Record<string, number> = {};
      for (const wf of workflows) {
        result[wf] = readQueueDepth(wf, dir);
      }
      writeJson(res, 200, result);
      return true;
    }

    return false;
  };
}
