import type { Hono } from "hono";

import { getAll, getByName } from "../../../../core/kernel/registry.js";
import { SCHEME_LIBRARY } from "../../../../domain/workflow-presentation/schemes.js";
import { resolveNaming } from "../../../../domain/workflow-presentation/resolve.js";
import { applyStepDisplay } from "../../../../domain/workflow-presentation/step-display.js";
import { applyOverride, effectiveMetadata } from "../../../workflow-presentation/effective.js";
import { deleteOverride, readOverride, writeOverride } from "../../../workflow-presentation/override-store.js";
import { WorkflowOverrideSchema } from "../../../workflow-presentation/schema.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

/** A representative person-kind row used to render a preview title/subtitle. */
const SAMPLE_DATA: Record<string, string> = {
  queueRowKind: "person",
  name: "Jane Doe",
  emplId: "10012345",
  email: "jdoe@ucsd.edu",
  pdfOriginalName: "oath-of-allegiance.pdf",
  label: "Onboarding Roster",
  __traceId: "ob-143012-a3f1",
  traceId: "ob-143012-a3f1",
  code: "ob",
  HHMMSS: "143012",
  runId4: "a3f1",
};

export function registerWorkflowPresentationRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const root = deps.repoRoot ?? process.cwd();

  app.get("/api/workflow-presentation", () => {
    const workflows = getAll().map((m) => ({
      name: m.name,
      label: effectiveMetadata(m, root).label,
      hasOverride: readOverride(root, m.name) !== null,
    }));
    return jsonResponse({ ok: true, workflows });
  });

  app.get("/api/workflow-presentation/:workflow", (c) => {
    const name = c.req.param("workflow");
    const meta = getByName(name);
    if (!meta) return jsonResponse({ ok: false, error: `unknown workflow '${name}'` }, 404);
    return jsonResponse({
      ok: true,
      base: meta,
      effective: effectiveMetadata(meta, root),
      override: readOverride(root, name),
      schemeLibrary: SCHEME_LIBRARY,
    });
  });

  app.post("/api/workflow-presentation/:workflow/preview", async (c) => {
    const name = c.req.param("workflow");
    const meta = getByName(name);
    if (!meta) return jsonResponse({ ok: false, error: `unknown workflow '${name}'` }, 404);
    const parsed = WorkflowOverrideSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonResponse({ ok: false, error: parsed.error.issues }, 400);
    const previewMeta = applyOverride(meta, parsed.data);
    const naming = previewMeta.presentation.naming ?? {}; // resolveNaming defaults missing parts
    const { title, subtitle } = resolveNaming(SAMPLE_DATA, naming);
    const steps = applyStepDisplay([...meta.steps], previewMeta.presentation.steps);
    return jsonResponse({ ok: true, effective: previewMeta, sample: { title, subtitle, steps } });
  });

  app.post("/api/workflow-presentation/:workflow", async (c) => {
    const name = c.req.param("workflow");
    if (!getByName(name)) return jsonResponse({ ok: false, error: `unknown workflow '${name}'` }, 404);
    const parsed = WorkflowOverrideSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonResponse({ ok: false, error: parsed.error.issues }, 400);
    try {
      writeOverride(root, name, parsed.data);
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  });

  app.delete("/api/workflow-presentation/:workflow", (c) => {
    const name = c.req.param("workflow");
    return jsonResponse({ ok: true, reverted: deleteOverride(root, name) });
  });
}
