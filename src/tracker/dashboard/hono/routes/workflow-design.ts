import type { Hono } from "hono";

import { getByName } from "../../../../core/kernel/registry.js";
import { readDesign, writeDesign, deleteDesign } from "../../../workflow-design/store.js";
import { readDataBank } from "../../../workflow-design/data-bank-store.js";
import { WorkflowDesignSchema } from "../../../workflow-design/schema.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

/**
 * The design-intent scaffold routes — parallel to workflow-presentation. Editing
 * the graph produces a live config override (existing routes) AND this scaffold:
 * a structured spec the operator drew, persisted as
 * `config/workflow-design/<workflow>.json` plus a generated `<workflow>.md` brief
 * a future session reads. `generatedAt` is stamped server-side; the body is
 * validated hard (fail loud — no silent fallback).
 */
export function registerWorkflowDesignRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const root = deps.repoRoot ?? process.cwd();

  // The assembled Data Bank — the palette + per-workflow automation the graph
  // editor loads (built by `npm run data-bank:build`). Workflow-agnostic.
  app.get("/api/data-bank", () => jsonResponse({ ok: true, bank: readDataBank(root) }));

  app.get("/api/workflow-design/:workflow", (c) => {
    const name = c.req.param("workflow");
    if (!getByName(name)) return jsonResponse({ ok: false, error: `unknown workflow '${name}'` }, 404);
    return jsonResponse({ ok: true, spec: readDesign(root, name) });
  });

  app.post("/api/workflow-design/:workflow", async (c) => {
    const name = c.req.param("workflow");
    if (!getByName(name)) return jsonResponse({ ok: false, error: `unknown workflow '${name}'` }, 404);
    const body = (await c.req.json());
    // Stamp authoritatively server-side; the workflow always matches the route param.
    const stamped = { ...body, workflow: name, generatedAt: new Date().toISOString() };
    const parsed = WorkflowDesignSchema.safeParse(stamped);
    if (!parsed.success) return jsonResponse({ ok: false, error: parsed.error.issues }, 400);
    try {
      const { jsonPath, mdPath } = writeDesign(root, name, parsed.data);
      return jsonResponse({ ok: true, jsonPath, mdPath });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  });

  app.delete("/api/workflow-design/:workflow", (c) => {
    const name = c.req.param("workflow");
    return jsonResponse({ ok: true, removed: deleteDesign(root, name) });
  });
}
