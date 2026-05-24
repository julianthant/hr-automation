/**
 * Central workflow action engine — `performWorkflowAction`.
 *
 * One dispatcher for every operator-triggered cancel / retry / delete / bump.
 * It does not reimplement queue mechanics: it validates the request, resolves
 * the blast radius (`resolve-targets.ts`), then routes each target to the
 * existing low-level ops handlers. Dashboard routes are thin wrappers that
 * translate their HTTP body into a {@link WorkflowActionRequest} and map the
 * {@link WorkflowActionResult} back to their legacy response shape.
 *
 * Scope discipline is the whole point: queue-panel actions cannot reach
 * batch-view-only rows, batch-view actions cannot escape the opened batch,
 * and daemon stop is rejected outright — it is operational control, not a
 * workflow tree cancel.
 */
import {
  buildCancelQueuedHandler,
  buildCancelRunningHandler,
  buildEntryReEnqueueHandler,
  buildDeleteEntryHandler,
  buildQueueBumpHandler,
} from "../ops/index.js";
import { buildOcrDiscardHandler } from "../ocr/discard.js";
import { resolveActionTargets, type ResolvedActionTarget } from "./resolve-targets.js";
import type {
  WorkflowActionRequest,
  WorkflowActionResult,
  WorkflowActionTargetResult,
} from "./types.js";

export interface PerformWorkflowActionDeps {
  dir: string;
  screenshotsDir?: string;
}

function okTarget(
  t: ResolvedActionTarget,
  detail?: Record<string, unknown>,
): WorkflowActionTargetResult {
  return {
    id: t.id,
    ...(t.runId ? { runId: t.runId } : {}),
    ok: true,
    ...(detail ? { detail } : {}),
  };
}

function failTarget(
  t: ResolvedActionTarget,
  error: string,
  status?: number,
): WorkflowActionTargetResult {
  return {
    id: t.id,
    ...(t.runId ? { runId: t.runId } : {}),
    ok: false,
    error,
    ...(status ? { status } : {}),
  };
}

/** Reject combinations that are structurally not workflow actions. */
function rejectionReason(req: WorkflowActionRequest): string | null {
  if (req.action === "stop-daemon") {
    return "stop-daemon is operational control, not a workflow action";
  }
  if (req.source === "daemon") {
    return "daemon is not a workflow action source — use daemon stop controls";
  }
  if (req.scope === "daemon") {
    return "daemon scope is operational control, not a workflow action";
  }
  if (req.action === "bump" && req.scope !== "row") {
    return "bump is only valid for scope: row";
  }
  return null;
}

async function cancelTarget(
  req: WorkflowActionRequest,
  t: ResolvedActionTarget,
  deps: PerformWorkflowActionDeps,
): Promise<WorkflowActionTargetResult> {
  // Contract 5: one cancel mechanism. The kernel's per-run AbortController
  // + Page proxy makes cancel propagate into in-flight Playwright work
  // within ms regardless of whether the operator clicked "Cancel" or the
  // (now-removed) "Force Stop" button. We still split queued vs running
  // because the SQLite path differs — queued tasks never reach a worker,
  // so there's no in-flight controller to abort; running tasks dispatch
  // a `cancel_task` worker command which both flips cancelTarget and
  // aborts the controller.
  void req;
  if (t.status === "running") {
    if (!t.runId) {
      return failTarget(t, "runId is required to cancel a running row", 400);
    }
    const r = await buildCancelRunningHandler(deps.dir)({
      workflow: t.workflow,
      id: t.id,
      runId: t.runId,
    });
    return r.ok ? okTarget(t) : failTarget(t, r.error, r.status);
  }
  const r = await buildCancelQueuedHandler(deps.dir)({
    workflow: t.workflow,
    id: t.id,
    ...(t.runId ? { runId: t.runId } : {}),
  });
  return r.ok ? okTarget(t) : failTarget(t, r.error, r.status);
}

/** OCR prep cancel is file-scope: route to the discard-prepare service path. */
async function discardOcrPrep(
  req: WorkflowActionRequest,
  deps: PerformWorkflowActionDeps,
): Promise<WorkflowActionTargetResult> {
  const sessionId = req.ocrSessionId!;
  const runId = req.targets[0]?.runId;
  const t: ResolvedActionTarget = { workflow: "ocr", id: sessionId, ...(runId ? { runId } : {}) };
  if (!runId) {
    return failTarget(t, "runId is required for OCR prep discard", 400);
  }
  const r = await buildOcrDiscardHandler({ trackerDir: deps.dir })({
    sessionId,
    runId,
    ...(req.reason ? { reason: req.reason } : {}),
    ...(req.parentWorkflow ? { parentWorkflow: req.parentWorkflow } : {}),
    ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
    ...(req.parentItemId ? { parentItemId: req.parentItemId } : {}),
    ...(req.formType ? { formType: req.formType } : {}),
  });
  return r.body.ok
    ? okTarget(t)
    : failTarget(t, r.body.error ?? "OCR discard failed", r.status);
}

/**
 * Run a cancel / retry / delete / bump across one normalized set of targets,
 * routing through the existing low-level ops handlers.
 */
export async function performWorkflowAction(
  req: WorkflowActionRequest,
  deps: PerformWorkflowActionDeps,
): Promise<WorkflowActionResult> {
  const empty = (error: string): WorkflowActionResult => ({
    ok: false,
    action: req.action,
    scope: req.scope,
    count: 0,
    results: [],
    errors: [],
    error,
  });

  const rejection = rejectionReason(req);
  if (rejection) return empty(rejection);

  const results: WorkflowActionTargetResult[] = [];

  if (req.action === "cancel" && req.ocrSessionId) {
    results.push(await discardOcrPrep(req, deps));
  } else if (req.action === "cancel") {
    const resolved = resolveActionTargets(req, deps.dir);
    if (!resolved.ok) return empty(resolved.error);
    for (const t of resolved.targets) {
      results.push(await cancelTarget(req, t, deps));
    }
  } else if (req.action === "retry") {
    const resolved = resolveActionTargets(req, deps.dir);
    if (!resolved.ok) return empty(resolved.error);
    const retry = buildEntryReEnqueueHandler(deps.dir);
    for (const t of resolved.targets) {
      const r = await retry({
        workflow: t.workflow,
        id: t.id,
        ...(t.runId ? { runId: t.runId } : {}),
        ...(t.date ? { date: t.date } : {}),
        ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
      });
      results.push(r.ok ? okTarget(t) : failTarget(t, r.error));
    }
  } else if (req.action === "delete") {
    const resolved = resolveActionTargets(req, deps.dir);
    if (!resolved.ok) return empty(resolved.error);
    const del = buildDeleteEntryHandler(
      deps.dir,
      deps.screenshotsDir ? { screenshotsDir: deps.screenshotsDir } : {},
    );
    for (const t of resolved.targets) {
      if (!t.date) {
        results.push(failTarget(t, "date is required to delete a row", 400));
        continue;
      }
      const r = del({
        workflow: t.workflow,
        id: t.id,
        date: t.date,
        ...(t.runId ? { runId: t.runId } : {}),
      });
      results.push(r.ok ? okTarget(t) : failTarget(t, r.error, r.status));
    }
  } else if (req.action === "bump") {
    const resolved = resolveActionTargets(req, deps.dir);
    if (!resolved.ok) return empty(resolved.error);
    const bump = buildQueueBumpHandler(deps.dir);
    for (const t of resolved.targets) {
      const r = await bump({
        workflow: t.workflow,
        id: t.id,
        ...(t.runId ? { runId: t.runId } : {}),
      });
      results.push(r.ok ? okTarget(t) : failTarget(t, r.error, r.status));
    }
  } else {
    return empty(`unsupported action: ${String(req.action)}`);
  }

  const errors = results
    .filter((r) => !r.ok)
    .map((r) => ({ id: r.id, error: r.error ?? "action failed" }));
  const count = results.filter((r) => r.ok).length;
  return {
    ok: results.length > 0 && errors.length === 0,
    action: req.action,
    scope: req.scope,
    count,
    results,
    errors,
  };
}
