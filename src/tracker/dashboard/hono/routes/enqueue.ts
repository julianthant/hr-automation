import type { Hono } from "hono";

import {
  enqueueFromHttp,
  validateEnqueueRequest,
} from "../../../../core/enqueue-dispatch.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerEnqueueRoute(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/enqueue", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 65_536);
      if (!parsed.ok) {
        return parsed.error === "Invalid JSON body"
          ? jsonResponse({ ok: false, error: "Invalid JSON body" }, 400)
          : jsonResponse({ ok: false, error: parsed.error }, 500);
      }

      const input = parsed.body as { workflow?: string; inputs?: unknown[] };
      const workflow = input.workflow?.trim();
      if (!workflow) return jsonResponse({ ok: false, error: "workflow is required" }, 400);
      if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
        return jsonResponse({ ok: false, error: "inputs must be a non-empty array" }, 400);
      }

      const validation = await validateEnqueueRequest(workflow, input.inputs);
      if (!validation.ok) {
        return jsonResponse({ ok: false, workflow, enqueued: 0, error: validation.error }, 400);
      }

      const enqueueInputs = input.inputs;
      void enqueueFromHttp(workflow, enqueueInputs, deps.dir).catch((err) => {
        log.error(`[POST /api/enqueue] background task failed: ${errorMessage(err)}`);
      });
      return jsonResponse({ ok: true, workflow, enqueued: enqueueInputs.length }, 202);
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}
