import type { Context, Hono } from "hono";

import { listWorkflows } from "../../../jsonl.js";
import {
  buildCancelRunningHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  buildDeleteEntryHandler,
  buildApproveEidHandler,
  buildDismissEidHandler,
  buildDrainWorkerHandler,
  buildEntryReEnqueueHandler,
  buildFindPriorByKeyHandler,
  buildFocusBrowserHandler,
  buildHealthCheckBrowserHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildRefreshBrowserHandler,
  buildReopenBrowserHandler,
  buildSaveDataHandler,
  buildSetAutoRecoveryHandler,
  buildStopWorkerHandler,
  readQueueDepth,
  resolveBrowserDaemonPort,
} from "../../../../control/ops/index.js";
import { performWorkflowAction } from "../../../../control/actions/perform-workflow-action.js";
import type {
  WorkflowActionResult,
} from "../../../../control/actions/types.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { postJson } from "../post-helper.js";
import {
  autoRecoveryBody,
  browserKillBody,
  browserTargetBody,
  cancelActiveBulkBody,
  cancelRunningBody,
  daemonsSpawnBody,
  daemonsStopBody,
  deleteBulkBody,
  deleteEntryBody,
  eidApproveBody,
  eidDismissBody,
  queueBumpBody,
  retryBody,
  retryBulkBody,
  rowCancelBody,
  runWithDataBody,
  saveDataBody,
  workerBody,
  zodParse,
} from "../request-schemas.js";
import { jsonResponse } from "../responses.js";

type Compact<T extends Record<string, unknown>> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function compact<T extends Record<string, unknown>>(obj: T): Compact<T> {
  const out: Partial<Record<keyof T, unknown>> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Compact<T>;
}

/** Full success vs partial (207) vs all rows failed (422). Caller validates non-empty workload before invoke. */
function bulkMutationHttpStatus(succeededCount: number, errorCount: number): number {
  if (errorCount === 0) return 200;
  if (succeededCount === 0) return 422;
  return 207;
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
    ...compact({ status: first.status || undefined }),
  };
}

/** Map a {@link WorkflowActionResult} to a bulk route's `{ ok, count, errors }` shape. */
function toBulkActionResult(
  result: WorkflowActionResult,
): { ok: true; count: number; errors: Array<{ id: string; error: string }> } {
  return { ok: true, count: result.count, errors: result.errors };
}

function buildCancelRoute(deps: DashboardHonoDeps): (c: Context) => Promise<Response> {
  return async (c) => postJson(c, zodParse(rowCancelBody), async (req) => {
    // Contract 5 — one cancel mechanism. The single `/api/cancel-queued`
    // route handles both queued AND running rows: the caller forwards the
    // row's current `status` so `cancelTarget` routes to the right
    // low-level handler (queued vs running). When `status` is absent we
    // default to `"pending"` for backwards compatibility with older
    // dashboard builds that only ever fired this route for queued rows.
    const status: "pending" | "running" = req.status ?? "pending";
    const result = await performWorkflowAction({
      action: "cancel",
      scope: req.scope,
      source: "queue-panel",
      workflowId: req.workflow,
      ...compact({
        treeExcludeRoots: req.treeExcludeRoots,
        ocrSessionId: req.ocrSessionId,
        parentWorkflow: req.parentWorkflow,
        parentRunId: req.parentRunId,
        parentItemId: req.parentItemId,
        formType: req.formType,
        reason: req.reason,
      }),
      targets: [{
        workflowId: req.workflow,
        id: req.id,
        ...compact({ runId: req.runId }),
        status,
      }],
    }, { dir: deps.dir });
    return toSingleActionResult(result);
  });
}

export function registerOpsRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/retry", async (c) => {
    return postJson(c, zodParse(retryBody), async (req) => {
      const result = await performWorkflowAction({
        action: "retry",
        scope: "row",
        source: "queue-panel",
        workflowId: req.workflow,
        targets: [{
          workflowId: req.workflow,
          id: req.id,
          ...compact({ runId: req.runId, date: req.date }),
        }],
        ...compact({ date: req.date, parentRunId: req.parentRunId }),
      }, { dir: deps.dir });
      return toSingleActionResult(result);
    }, 202);
  });

  app.post("/api/retry-bulk", async (c) => {
    return postJson(c, zodParse(retryBulkBody), async (req) => {
      const items: Array<{ workflowId?: string; id: string; runId?: string; date?: string }> = req.items && req.items.length > 0
        ? req.items
        : req.ids.map((id) => ({ id }));
      const result = await performWorkflowAction({
        action: "retry",
        scope: req.scope,
        source: req.source,
        workflowId: req.workflow,
        targets: items.map((it) => ({
          workflowId: it.workflowId ?? req.workflow,
          id: it.id,
          ...compact({ runId: it.runId, date: it.date ?? req.date }),
        })),
        ...compact({ date: req.date, parentRunId: req.parentRunId }),
      }, { dir: deps.dir });
      return toBulkActionResult(result);
    }, 202);
  });

  app.post("/api/run-with-data", async (c) => {
    return postJson(c, zodParse(runWithDataBody), buildEntryReEnqueueHandler(deps.dir, { withData: true }), 202);
  });

  // Identity-approval review (workflow-agnostic) — approve a chosen EID (re-queue
  // the item as a fresh, gate-skipping run) or dismiss the review (stamp the row,
  // no re-queue). The `workflow` rides the body (the banner already sends it); the
  // handler rejects any workflow not in EID_APPROVAL_WORKFLOWS. Adopted by
  // separations + onboarding.
  app.post("/api/eid-approval/approve", async (c) => {
    return postJson(c, zodParse(eidApproveBody), buildApproveEidHandler(deps.dir), 202);
  });

  app.post("/api/eid-approval/dismiss", async (c) => {
    return postJson(c, zodParse(eidDismissBody), buildDismissEidHandler(deps.dir));
  });

  app.post("/api/save-data", async (c) => {
    return postJson(c, zodParse(saveDataBody), buildSaveDataHandler(deps.dir));
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

  app.post("/api/cancel-queued", buildCancelRoute(deps));

  app.post("/api/cancel-running", async (c) => {
    return postJson(c, zodParse(cancelRunningBody), buildCancelRunningHandler(deps.dir));
  });

  app.post("/api/cancel-active-bulk", async (c) => {
    return postJson(c, zodParse(cancelActiveBulkBody), async (req) => {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "visible-view",
        source: "queue-panel",
        workflowId: req.workflow,
        targets: req.items.map((it) => ({
          workflowId: req.workflow,
          id: it.id,
          status: it.status,
          ...compact({ runId: it.runId }),
        })),
      }, { dir: deps.dir });
      return toBulkActionResult(result);
    }, (result) => bulkMutationHttpStatus(result.count, result.errors.length));
  });

  app.post("/api/browser/kill", async (c) => {
    return postJson(c, zodParse(browserKillBody), buildKillBrowserHandler(deps.dir), 202);
  });

  // Per-browser session-panel controls: reload one system's page on a running
  // daemon (the "refresh-only" recovery, operator-triggered) and bring its
  // Chromium window to front ("which browser is this?"). Both target the live
  // browser by (workflow, instance, systemId).
  app.post("/api/browser/refresh", async (c) => {
    return postJson(c, zodParse(browserTargetBody), buildRefreshBrowserHandler(deps.dir), 202);
  });

  app.post("/api/browser/focus", async (c) => {
    return postJson(c, zodParse(browserTargetBody), buildFocusBrowserHandler(deps.dir), 202);
  });

  // Reopen escalation (fresh tab, same auth) + on-demand health check.
  app.post("/api/browser/reopen", async (c) => {
    return postJson(c, zodParse(browserTargetBody), buildReopenBrowserHandler(deps.dir), 202);
  });

  app.post("/api/browser/check", async (c) => {
    return postJson(c, zodParse(browserTargetBody), buildHealthCheckBrowserHandler(deps.dir), 202);
  });

  // Live "peek" — proxy a synchronous viewport screenshot from the owning
  // daemon's /screenshot endpoint so the operator sees the browser inline.
  app.get("/api/browser/screenshot", async (c) => {
    const workflow = c.req.query("workflow") ?? "";
    const instance = c.req.query("instance") ?? "";
    const systemId = c.req.query("systemId") ?? "";
    if (!workflow || !instance || !systemId) {
      return jsonResponse({ ok: false, error: "workflow, instance, systemId are required" }, 400);
    }
    const port = await resolveBrowserDaemonPort(deps.dir, workflow, instance);
    if (port == null) {
      return jsonResponse({ ok: false, error: `no live daemon for instance '${instance}'` }, 404);
    }
    try {
      const upstream = await fetch(`http://127.0.0.1:${port}/screenshot?system=${encodeURIComponent(systemId)}`);
      if (!upstream.ok) {
        return jsonResponse({ ok: false, error: `daemon returned ${upstream.status}` }, 502);
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 502);
    }
  });

  // Pause/resume auto-recovery for one browser (so the operator can inspect it).
  app.post("/api/browser/auto-recovery", async (c) => {
    return postJson(c, zodParse(autoRecoveryBody), buildSetAutoRecoveryHandler(deps.dir), 202);
  });

  app.post("/api/worker/drain", async (c) => {
    return postJson(c, zodParse(workerBody), buildDrainWorkerHandler(deps.dir), 202);
  });

  app.post("/api/worker/stop", async (c) => {
    return postJson(c, zodParse(workerBody), buildStopWorkerHandler(deps.dir), 202);
  });

  app.post("/api/queue/bump", async (c) => {
    return postJson(c, zodParse(queueBumpBody), buildQueueBumpHandler(deps.dir));
  });

  app.get("/api/daemons", async (c) => {
    const workflow = c.req.query("workflow") ?? undefined;
    return jsonResponse(await buildDaemonsListHandler(deps.dir)(workflow));
  });

  app.post("/api/daemons/spawn", async (c) => {
    return postJson(c, zodParse(daemonsSpawnBody), (body) => {
      const handler = buildDaemonsSpawnHandler(deps.dir);
      void handler(body).catch((err) => {
        log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
      });
      return { ok: true, queued: body.count };
    }, 202);
  });

  app.post("/api/daemons/stop", async (c) => {
    return postJson(c, zodParse(daemonsStopBody), buildDaemonsStopHandler(deps.dir));
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
    return postJson(c, zodParse(deleteEntryBody), buildDeleteEntryHandler(deps.dir, { screenshotsDir: deps.screenshotsDir }));
  });

  app.post("/api/delete-bulk", async (c) => {
    return postJson(c, zodParse(deleteBulkBody), async (req) => {
      const items: Array<{ workflowId?: string; id: string; runId?: string; date?: string }> = req.items.length > 0
        ? req.items
        : req.ids.map((id) => ({ id }));
      const result = await performWorkflowAction({
        action: "delete",
        scope: req.scope,
        source: req.source,
        workflowId: req.workflow,
        date: req.date,
        targets: items.map((it) => ({
          workflowId: it.workflowId ?? req.workflow,
          id: it.id,
          date: it.date ?? req.date,
          ...compact({ runId: it.runId }),
        })),
      }, { dir: deps.dir, screenshotsDir: deps.screenshotsDir });
      return toBulkActionResult(result);
    }, (result) => bulkMutationHttpStatus(result.count, result.errors.length));
  });
}
