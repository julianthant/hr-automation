import type { Hono } from "hono";

import { isDashboardInputRunWorkflow } from "../../../../domain/dashboard-run-surfaces.js";
import { normalizeRunOptions, type RunOptions } from "../../../../domain/run-options.js";
import {
  enqueueFromHttp,
  validateEnqueueRequest,
} from "../../../../core/daemon/enqueue-dispatch.js";
import { buildSupersedePriorRunsHandler } from "../../../../control/ops/supersede.js";
import { loadWorkflow } from "../../../../core/workflow-loaders.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { PARENT_RUN_ID_VALIDATION_HINT, parseOptionalParentRunId } from "../parent-run-id.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerEnqueueRoute(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/enqueue", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 65_536);
      if (!parsed.ok) {
        return jsonResponse({ ok: false, error: parsed.error }, 400);
      }

      const input = parsed.body as {
        workflow?: string;
        inputs?: unknown[];
        parentRunId?: unknown;
        skipSteps?: unknown;
        preset?: unknown;
        parallelWorkers?: unknown;
      };
      const workflow = input.workflow?.trim();
      if (!workflow) return jsonResponse({ ok: false, error: "workflow is required" }, 400);
      if (!isDashboardInputRunWorkflow(workflow)) {
        return jsonResponse({
          ok: false,
          workflow,
          enqueued: 0,
          error: `workflow is not enabled for dashboard input runs: ${workflow}`,
        }, 400);
      }
      if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
        return jsonResponse({ ok: false, error: "inputs must be a non-empty array" }, 400);
      }

      const parentRunId = parseOptionalParentRunId(input.parentRunId);
      if (input.parentRunId !== undefined && input.parentRunId !== null && parentRunId === undefined) {
        return jsonResponse({ ok: false, error: PARENT_RUN_ID_VALIDATION_HINT }, 400);
      }

      // Step-preset gear: validate `skipSteps` is a string[] subset of the
      // workflow's declared handler steps (NOT auth steps), and `preset` is
      // a string. The kernel re-validates skipSteps in run-one-item (defense
      // in depth) but a 400 here surfaces a precise error to the operator
      // instead of a generic background-task failure.
      let skipSteps: string[] | undefined;
      let preset: string | undefined;
      if (input.skipSteps !== undefined && input.skipSteps !== null) {
        if (!Array.isArray(input.skipSteps) || !input.skipSteps.every((s) => typeof s === "string")) {
          return jsonResponse({ ok: false, error: "skipSteps must be a string[]" }, 400);
        }
        if (input.skipSteps.length > 0) {
          const wf = await loadWorkflow(workflow);
          if (!wf) {
            return jsonResponse({ ok: false, error: `unknown workflow: ${workflow}` }, 400);
          }
          const declared = new Set<string>(wf.config.steps);
          const unknown = input.skipSteps.filter((s: string) => !declared.has(s));
          if (unknown.length > 0) {
            return jsonResponse({
              ok: false,
              error: `skipSteps contains unknown step name(s) for '${workflow}': ${unknown.join(", ")}`,
            }, 400);
          }
          skipSteps = [...input.skipSteps] as string[];
        }
      }
      if (input.preset !== undefined && input.preset !== null) {
        if (typeof input.preset !== "string" || input.preset.trim().length === 0) {
          return jsonResponse({ ok: false, error: "preset must be a non-empty string" }, 400);
        }
        preset = input.preset.trim();
      }

      // Automation-workers run setting: Auto (absent/"auto") → no daemon flags;
      // an explicit N → raise the alive-daemon target for this run. Invalid
      // explicit values fail loud here as a 400 (no silent clamp).
      let runOptions: RunOptions;
      try {
        runOptions = normalizeRunOptions({ parallelWorkers: input.parallelWorkers });
      } catch (err) {
        return jsonResponse({ ok: false, workflow, enqueued: 0, error: errorMessage(err) }, 400);
      }

      const validation = await validateEnqueueRequest(workflow, input.inputs);
      if (!validation.ok) {
        return jsonResponse({ ok: false, workflow, enqueued: 0, error: validation.error }, 400);
      }

      // Fold the runtime channel into each input so it rides on `input_json`
      // (same shape as the existing `prefilledData` channel). The kernel's
      // `splitPrefilled` strips it before schema validation and surfaces it
      // via `ctx.shouldSkipStep(name)` + `data.__preset` stamping.
      const enqueueInputs =
        skipSteps || preset
          ? input.inputs.map((item) => {
              const base =
                item && typeof item === "object" && !Array.isArray(item)
                  ? (item as Record<string, unknown>)
                  : { value: item };
              return {
                ...base,
                __runtimeOptions: {
                  ...(skipSteps ? { skipSteps } : {}),
                  ...(preset ? { preset } : {}),
                },
              };
            })
          : input.inputs;
      // One active run per queue row: a fresh input run cancels any prior
      // queued/in-flight run for the same item (the retry path already guards
      // this via ACTIVE_STATES_BLOCKING_RETRY; the enqueue path didn't). Lives
      // in src/control/; the route stays a thin adapter that injects it.
      const supersede = buildSupersedePriorRunsHandler(deps.dir);
      void enqueueFromHttp(workflow, enqueueInputs, {
        trackerDir: deps.dir,
        ...(parentRunId ? { parentRunId } : {}),
        ...(runOptions.parallelWorkers !== undefined ? { runOptions } : {}),
        supersedePriorRuns: async (items) => {
          await supersede({
            workflow,
            itemIds: items.map((i) => i.itemId),
            exceptRunIds: items.map((i) => i.runId),
          });
        },
      }).catch((err) => {
        log.error(`[POST /api/enqueue] background task failed: ${errorMessage(err)}`);
      });
      return jsonResponse({ ok: true, workflow, enqueued: enqueueInputs.length }, 202);
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}
