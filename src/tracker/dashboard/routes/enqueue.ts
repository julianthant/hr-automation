import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { errorMessage } from "../../../utils/errors.js";
import { log } from "../../../utils/log.js";
import {
  enqueueFromHttp,
  validateEnqueueRequest,
} from "../../../core/enqueue-dispatch.js";

export function createEnqueueRoute(): DashboardRoute {
  return async (req, res, url, ctx) => {
    if (
      req.method !== "POST" ||
      url.pathname !== "/api/enqueue"
    ) {
      return false;
    }

    try {
      const parsed = await readJsonBody(req, 65_536);
      if (!parsed.ok) {
        if (parsed.error === "Invalid JSON body") {
          writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
        } else {
          writeJson(res, 500, { ok: false, error: parsed.error });
        }
        return true;
      }

      const input = parsed.body as { workflow?: string; inputs?: unknown[] };
      const workflow = input.workflow?.trim();
      if (!workflow) {
        writeJson(res, 400, { ok: false, error: "workflow is required" });
        return true;
      }
      if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
        writeJson(res, 400, { ok: false, error: "inputs must be a non-empty array" });
        return true;
      }

      const validation = await validateEnqueueRequest(workflow, input.inputs);
      if (!validation.ok) {
        writeJson(res, 400, { ok: false, workflow, enqueued: 0, error: validation.error });
        return true;
      }

      const enqueueInputs = input.inputs;
      void enqueueFromHttp(workflow, enqueueInputs, ctx.dir).catch((err) => {
        log.error(`[POST /api/enqueue] background task failed: ${errorMessage(err)}`);
      });
      writeJson(res, 202, {
        ok: true,
        workflow,
        enqueued: enqueueInputs.length,
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: errorMessage(e) });
    }
    return true;
  };
}
