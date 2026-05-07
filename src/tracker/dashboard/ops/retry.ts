import { existsSync } from "fs";
import { readEntries, trackEvent } from "../../jsonl.js";
import { enqueueFromHttp } from "../../../core/daemon/enqueue-dispatch.js";
import { findInputForRetry } from "../../../core/find-input.js";
import {
  openControlStores,
  resolveControlTask,
  appendQueueEnqueueAudit,
} from "./shared.js";

export interface RetryRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export interface RunWithDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
  runId?: string;
}

export interface RetryBulkRequest {
  workflow: string;
  ids: string[];
}

type ReEnqueueResult = { ok: true } | { ok: false; error: string };

/** In-process workflows that don't run via the daemon queue — retry routes
 * through their existing in-process launchers instead of `enqueueFromHttp`.
 * See `src/workflows/CLAUDE.md` ("Existing Workflows" table) for the
 * non-daemon rationale. */
const IN_PROCESS_WORKFLOWS = new Set(["ocr", "sharepoint-download"]);

/**
 * Lookup an entry's input by (workflow, id, runId?). Delegates to the
 * canonical three-tier lookup in `src/core/find-input.ts` and reshapes
 * the result into the `{input} | {error}` shape consumed by `reEnqueueEntry`.
 */
export function findEntryInput(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): { input: Record<string, unknown> } | { error: string } {
  const input = findInputForRetry(workflow, id, runId, dir);
  if (input) return { input };

  const entries = readEntries(workflow, dir).filter((e) => {
    if (e.id !== id) return false;
    if (runId && e.runId !== runId) return false;
    return true;
  });
  if (entries.length === 0) {
    return { error: `no tracker entry found for id=${id}` };
  }
  return { error: "no input or data found to reconstruct retry payload" };
}

function asRecordInput(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

/**
 * Merged accumulated `data` for an id across every tracker row (any status).
 * Used by edit-and-resume to seed prefilledData with non-editable fields
 * carried over from prior runs (e.g. separations' rawTerminationType,
 * deptId, departmentDescription).
 *
 * Implementation: oldest → newest fold, latest non-empty value wins per
 * key. Replaces the prior "latest row's data only" lookup, which broke
 * lineage when the latest row was a cancel-queued synthetic failed entry
 * or a /api/save-data persist that only carried the editable subset of
 * fields. With the merge, even if a later row drops a key, the most
 * recent non-empty value from any earlier row is preserved.
 *
 * Excludes kernel-internal keys (`__name`, `__id`, `instance`) so those
 * don't leak into a fresh run's prefilledData channel.
 */
export function findLatestEntryData(
  workflow: string,
  id: string,
  dir: string,
): Record<string, string> {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id && e.data);
  if (entries.length === 0) return {};
  // Ascending sort so later non-empty values overwrite earlier ones per key.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const merged: Record<string, string> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (k === "__name" || k === "__id" || k === "instance") continue;
      if (v === undefined || v === null || v === "") continue;
      merged[k] = String(v);
    }
  }
  return merged;
}

/**
 * Re-enqueue a tracker entry — the shared core of `/api/retry` and
 * `/api/run-with-data`. Looks up the original input, optionally attaches a
 * `prefilledData` channel (edit-and-resume), and dispatches via the same
 * daemon path the CLI uses. The kernel auto-increments runId so the new run
 * shows up as a fresh row in the dashboard's RunSelector. Reuses an alive
 * daemon when one exists; spawns a fresh one when none do.
 *
 * `prefilledData` is the only difference between retry (omit) and edit-and-
 * resume (provide user edits). When provided, it's merged with the previous
 * run's accumulated data so non-editable fields (e.g. separations'
 * `rawTerminationType` — used by downstream `mapReasonCode` but not surfaced
 * as an editable detail field) carry over and the handler's gating check
 * sees the full set of required fields. The user's edits win on collision.
 *
 * In-process workflows (`ocr`, `sharepoint-download`) bypass the daemon path
 * — they aren't registered in `WORKFLOW_LOADERS` because they run inside the
 * dashboard's Node process via fire-and-forget `runWorkflow`. Retry for them
 * fires their existing HTTP-shaped launchers directly. `prefilledData` is
 * ignored for these workflows since neither has user-editable inputs.
 */
async function reEnqueueEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  prefilledData: Record<string, unknown> | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  // Tolerate trailing slash from URL-shaped workflow values that occasionally
  // leak in from clients that build paths instead of identifiers.
  const wf = workflow.trim().replace(/\/+$/, "");
  if (!wf || !id) return { ok: false, error: "workflow and id are required" };

  if (runId && !prefilledData) {
    const stores = openControlStores(dir);
    try {
      const task = resolveControlTask(stores.taskStore, wf, id, runId);
      if (task) {
        const input = asRecordInput(task.input);
        if (!input) {
          return { ok: false, error: "stored task input is unavailable for retry" };
        }
        const retried = stores.taskStore.retryTaskFromAttempt({ runId });
        stores.workerStore.enqueueWorkerCommand({
          commandType: "retry_task",
          workflow: wf,
          targetTaskId: retried.taskId,
          targetAttemptId: retried.attemptId,
          state: "completed",
          payload: { fromRunId: runId, runId: retried.runId },
        });
        appendQueueEnqueueAudit(wf, retried.itemId, input, retried.runId, dir);
        trackEvent(
          {
            workflow: wf,
            timestamp: new Date().toISOString(),
            id: retried.itemId,
            runId: retried.runId,
            status: "pending",
            input,
          },
          dir,
        );
        return { ok: true };
      }
    } finally {
      stores.close();
    }
  }

  if (IN_PROCESS_WORKFLOWS.has(wf)) {
    return reEnqueueInProcessEntry(wf, id, runId, dir);
  }

  const lookup = findEntryInput(wf, id, runId, dir);
  if ("error" in lookup) return { ok: false, error: lookup.error };

  let input: Record<string, unknown> = lookup.input;
  if (prefilledData) {
    const previousData = findLatestEntryData(wf, id, dir);
    input = { ...input, prefilledData: { ...previousData, ...prefilledData } };
  }

  const result = await enqueueFromHttp(wf, [input], dir);
  if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
  return { ok: true };
}

/** Retry for in-process workflows — dispatches to the same launcher their
 * original HTTP entry point uses. */
async function reEnqueueInProcessEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  if (workflow === "ocr") return reEnqueueOcrEntry(id, runId, dir);
  if (workflow === "sharepoint-download") return reEnqueueSharePointEntry(id, runId, dir);
  return { ok: false, error: `in-process retry not implemented for "${workflow}"` };
}

async function reEnqueueOcrEntry(
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  // The OCR orchestrator only writes pdfPath/pdfOriginalName on the pending
  // row — later rows (loading-roster, ocr, awaiting-approval, failed) drop
  // them. findEntryInput's latest-row fallback would miss them, so merge
  // across every row for this id and keep the latest non-empty value per key.
  const entries = readEntries("ocr", dir).filter((e) => e.id === id);
  if (entries.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id}` };
  }
  const matching = runId ? entries.filter((e) => e.runId === runId) : entries;
  if (matching.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id} runId=${runId}` };
  }
  const merged: Record<string, string> = {};
  [...matching].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).forEach((e) => {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      merged[k] = String(v);
    }
  });

  const pdfPath = merged.pdfPath ?? "";
  const pdfOriginalName = merged.pdfOriginalName ?? "";
  const formType = merged.formType ?? "";
  const sessionId = merged.sessionId || id;
  const rosterModeRaw = merged.rosterMode ?? "existing";
  const rosterMode: "existing" | "download" =
    rosterModeRaw === "download" ? "download" : "existing";
  const rosterPath = merged.rosterPath || undefined;

  if (!pdfPath || !pdfOriginalName || !formType) {
    return {
      ok: false,
      error: "OCR retry: entry data missing pdfPath/pdfOriginalName/formType",
    };
  }
  if (!existsSync(pdfPath)) {
    return { ok: false, error: `OCR retry: PDF no longer exists at ${pdfPath}` };
  }

  const { buildOcrPrepareHandler } = await import("../ocr/index.js");
  const handler = buildOcrPrepareHandler({ trackerDir: dir });
  const result = await handler({
    pdfPath,
    pdfOriginalName,
    formType,
    sessionId,
    rosterMode,
    ...(rosterPath ? { rosterPath } : {}),
  });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

async function reEnqueueSharePointEntry(
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  const lookup = findEntryInput("sharepoint-download", id, runId, dir);
  // Fall back to the entry id when input lookup fails — sharepoint-download
  // uses the spec id as the tracker id, so we can launch a retry from id alone.
  const specId =
    "input" in lookup && typeof lookup.input.id === "string" && lookup.input.id
      ? lookup.input.id
      : id;
  if (!specId) {
    return { ok: false, error: "sharepoint-download retry: missing spec id" };
  }

  const { buildSharePointRosterDownloadHandler } = await import(
    "../../../workflows/sharepoint-download/handler.js"
  );
  const handler = buildSharePointRosterDownloadHandler();
  const result = await handler({ id: specId });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

export function buildRetryHandler(dir: string) {
  return (req: RetryRequest): Promise<ReEnqueueResult> =>
    reEnqueueEntry(req.workflow, req.id, req.runId, undefined, dir);
}

export function buildRunWithDataHandler(dir: string) {
  return (req: RunWithDataRequest): Promise<ReEnqueueResult> => {
    if (!req.data || typeof req.data !== "object") {
      return Promise.resolve({ ok: false, error: "data is required" });
    }
    return reEnqueueEntry(req.workflow, req.id, req.runId, req.data, dir);
  };
}

export function buildRetryBulkHandler(dir: string) {
  const retry = buildRetryHandler(dir);
  return async (
    req: RetryBulkRequest,
  ): Promise<{ ok: true; count: number; errors: Array<{ id: string; error: string }> }> => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    for (const id of req.ids ?? []) {
      const r = await retry({ workflow: req.workflow, id });
      if (r.ok) count++;
      else errors.push({ id, error: r.error });
    }
    return { ok: true, count, errors };
  };
}
