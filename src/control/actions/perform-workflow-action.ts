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
 * operation-view-only rows, operation-view actions cannot escape the opened batch,
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
import { findInheritedPriorEntry } from "../ops/emit-inherited.js";
import { openControlStores, emitDashboardCancelTrackerRow } from "../ops/shared.js";
import { buildOcrDiscardHandler } from "../ocr/discard.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";
import { readOcrPrepCancelContext, type OcrPrepCancelContext } from "../../domain/ocr-prep-cancel.js";
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
  _req: WorkflowActionRequest,
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
  //
  // The caller's `status` is advisory, not load-bearing: the row's rendered
  // status can lag the SQLite truth (a queued task claimed between render
  // and click, or vice versa). Each handler marks its REDIRECTABLE 409 with
  // `code: "wrong-state"`, so cancel falls through to the other handler
  // instead of surfacing the race to the operator (E2E-008) — while a
  // non-redirectable 409 ("cannot cancel item in state waiting_dependencies")
  // keeps its accurate error instead of bouncing into a circular one.
  const cancelRunning = async (runId: string) =>
    buildCancelRunningHandler(deps.dir)({ workflow: t.workflow, id: t.id, runId });
  const cancelQueued = async () =>
    buildCancelQueuedHandler(deps.dir)({
      workflow: t.workflow,
      id: t.id,
      ...(t.runId ? { runId: t.runId } : {}),
    });

  if (t.status === "running") {
    if (!t.runId) {
      return failTarget(t, "runId is required to cancel a running row", 400);
    }
    const r = await cancelRunning(t.runId);
    if (r.ok) return okTarget(t);
    if (!r.ok && r.code === "wrong-state") {
      const fallback = await cancelQueued();
      return fallback.ok ? okTarget(t) : failTarget(t, fallback.error, fallback.status);
    }
    return failTarget(t, r.error, r.status);
  }
  const r = await cancelQueued();
  if (r.ok) return okTarget(t);
  if (r.code === "wrong-state" && t.runId) {
    const fallback = await cancelRunning(t.runId);
    return fallback.ok ? okTarget(t) : failTarget(t, fallback.error, fallback.status);
  }
  return failTarget(t, r.error, r.status);
}

async function discardOcrPrepForTarget(
  t: ResolvedActionTarget,
  ctx: OcrPrepCancelContext,
  deps: PerformWorkflowActionDeps,
  reason?: string,
): Promise<WorkflowActionTargetResult> {
  const r = await buildOcrDiscardHandler({ trackerDir: deps.dir })({
    sessionId: ctx.ocrSessionId,
    runId: ctx.ocrRunId,
    reason: reason ?? `Cancelled from ${t.workflow} queue`,
    parentWorkflow: t.workflow,
    ...(t.runId ? { parentRunId: t.runId } : {}),
    parentItemId: t.id,
    ...(ctx.formType ? { formType: ctx.formType } : {}),
  });
  return r.body.ok
    ? okTarget(t)
    : failTarget(t, r.body.error ?? "OCR discard failed", r.status);
}

function readTrackerOcrPrepCancelContext(
  t: ResolvedActionTarget,
  deps: PerformWorkflowActionDeps,
): OcrPrepCancelContext | null {
  const stores = openControlStores(deps.dir);
  const prior = findInheritedPriorEntry({
    workflow: t.workflow,
    trackerDir: deps.dir,
    id: t.id,
    ...(t.runId ? { runId: t.runId } : {}),
    db: stores.taskStore.db,
  });
  return readOcrPrepCancelContext(prior?.data ?? undefined);
}

function isSqliteTaskNotFound(error: string | undefined): boolean {
  return error === "task not found in SQLite control store";
}

function isTerminalTrackerStatus(status: string | undefined): boolean {
  return status === "done" || status === "failed" || status === "skipped";
}

/**
 * Resolve a stranded display-only OPERATION coordinator whose cancel found no
 * SQLite task and no live descendants to cancel.
 *
 * An `operation` coordinator is a display row with no daemon task of its own
 * (by design — see `src/control/actions/types.ts` `treeExcludeRoots`). When its
 * fan-out members are already terminal, or were completed/never projected into
 * the `runs` table (e.g. a CLI / file-queue run), the descendant tree walk
 * finds nothing. Without this, cancel dead-ends with "task not found in SQLite
 * control store" and the coordinator is stranded in the queue forever — a
 * pending row offers no delete affordance, so there is no working way to clear
 * it. Terminalize the display row instead (the standard operator-cancel
 * terminal shape: `failed` + `step:"cancelled"`) so the projection drops it out
 * of the queue.
 *
 * Returns null — leaving the caller's original error to surface — when the
 * target is NOT a stranded operation coordinator:
 *   - no prior tracker row to inherit from (a genuinely missing item → keep the
 *     honest 404 rather than fabricate a phantom terminal row);
 *   - the prior row is not an `operation` coordinator (a normal single/preview
 *     row's task-not-found is a real error / enqueue race, not this case);
 *   - the prior row is already terminal (don't overwrite a real done/failed).
 *
 * Guarded so this protects every workflow that produces an operation
 * coordinator (oath-signature / emergency-contact / onbase + any multi-person
 * input-run anchor), not just the one that surfaced the bug.
 */
function terminalizeStrandedCoordinator(
  t: ResolvedActionTarget,
  deps: PerformWorkflowActionDeps,
): WorkflowActionTargetResult | null {
  // Pass the process-cached SQLite handle so the prior-row lookup uses the
  // indexed `runs`/`items` projection instead of a synchronous 30-day JSONL
  // scan — this runs per task-not-found target inside the cancel loop, on the
  // SSE backend event loop (see `emit-inherited.ts`: bulk-loop callers MUST
  // pass `db`).
  const stores = openControlStores(deps.dir);
  const prior = findInheritedPriorEntry({
    workflow: t.workflow,
    trackerDir: deps.dir,
    id: t.id,
    ...(t.runId ? { runId: t.runId } : {}),
    db: stores.taskStore.db,
  });
  if (!prior) return null;
  if (resolveRowArchetype(prior) !== "operation") return null;
  if (isTerminalTrackerStatus(prior.status)) return null;
  try {
    emitDashboardCancelTrackerRow(t.workflow, t.id, t.runId, deps.dir, stores.taskStore.db);
  } catch {
    // No prior row to inherit (PriorTrackerRowNotFoundError) or emit failure —
    // fall back to the caller's original error rather than claiming success.
    return null;
  }
  return okTarget(t, { terminalizedCoordinator: true });
}

async function cancelDescendantTargets(
  req: WorkflowActionRequest,
  root: ResolvedActionTarget,
  deps: PerformWorkflowActionDeps,
): Promise<WorkflowActionTargetResult[]> {
  if (!root.runId) return [];
  const childResolved = resolveActionTargets(
    {
      ...req,
      scope: "tree",
      treeExcludeRoots: true,
      targets: [{
        workflowId: root.workflow,
        id: root.id,
        runId: root.runId,
        ...(root.date ? { date: root.date } : {}),
        ...(root.status ? { status: root.status } : {}),
      }],
    },
    deps.dir,
  );
  if (!childResolved.ok || childResolved.targets.length === 0) return [];
  const results: WorkflowActionTargetResult[] = [];
  for (const child of childResolved.targets) {
    results.push(await cancelResolvedTarget(req, child, deps));
  }
  return results;
}

async function cancelResolvedTarget(
  req: WorkflowActionRequest,
  t: ResolvedActionTarget,
  deps: PerformWorkflowActionDeps,
): Promise<WorkflowActionTargetResult> {
  const prepContext = readTrackerOcrPrepCancelContext(t, deps);
  if (prepContext) {
    return discardOcrPrepForTarget(t, prepContext, deps, req.reason);
  }

  const direct = await cancelTarget(req, t, deps);
  if (direct.ok) return direct;
  if (!isSqliteTaskNotFound(direct.error) || !t.runId) return direct;

  const childResults = await cancelDescendantTargets(req, t, deps);

  const succeeded = childResults.filter((r) => r.ok);
  if (succeeded.length > 0) {
    return okTarget(t, { cancelledDescendants: succeeded.length });
  }
  if (childResults.length > 0) {
    return failTarget(t, childResults[0]?.error ?? direct.error ?? "cancel failed", childResults[0]?.status);
  }

  // No task and no live descendants. For a stranded display-only operation
  // coordinator this is the terminal case, not a failure — terminalize the
  // display row so it leaves the queue instead of dead-ending forever.
  return terminalizeStrandedCoordinator(t, deps) ?? direct;
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
      results.push(await cancelResolvedTarget(req, t, deps));
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
