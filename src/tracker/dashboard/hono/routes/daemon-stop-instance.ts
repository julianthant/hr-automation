import type { Hono } from "hono";

import { buildStopDaemonInstanceHandler } from "../../../../control/ops/index.js";
import { errorMessage } from "../../../../utils/errors.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

/**
 * Per-instance daemon stop — stops ONE daemon (the session card's), leaving the
 * workflow's other daemons running. The daemon reassigns its in-flight item to
 * a surviving peer when one exists, else fails it. Distinct from the
 * workflow-scoped `/api/daemon/stop` (StopAllButton), which tears down every
 * daemon for a workflow.
 */
export function registerDaemonStopInstanceRoute(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/daemon/stop-instance", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 4096);
      if (!parsed.ok) {
        return jsonResponse({ ok: false, error: parsed.error }, 400);
      }
      const input = parsed.body as { workflow?: string; instance?: string; force?: boolean };
      const result = await buildStopDaemonInstanceHandler(deps.dir)({
        workflow: input.workflow ?? "",
        instance: input.instance ?? "",
        ...(input.force !== undefined ? { force: input.force } : {}),
      });
      return jsonResponse(result, result.ok ? 200 : 400);
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}
