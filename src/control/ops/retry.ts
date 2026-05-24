/**
 * Low-level retry / re-enqueue operations.
 *
 * The primitive behind the central action engine — operator retries arrive
 * through `actions/perform-workflow-action.ts`, which decides scope and
 * routes here. `buildEntryReEnqueueHandler` stays exported so the
 * `/api/run-with-data` edit-and-resume route can reuse it directly.
 */
import { existsSync } from "fs";
import { listRosters, resolveRosterDirs } from "../../services/matching/roster-loader.js";
import { byTimestampAsc, emitTrackerRow, readEntries, readEntriesForDate, type TrackerEntry } from "../../tracker/jsonl.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";
import { enqueueFromHttp } from "../../core/daemon/enqueue-dispatch.js";
import {
  findRetryInputFromTaskStore,
  readEntriesForRetryItem,
  selectRetryInputFromEntries,
} from "../../core/find-input.js";
import {
  openControlStores,
  resolveControlTask,
  appendQueueEnqueueAudit,
} from "./shared.js";
import { log } from "../../utils/log.js";

/**
 * Contract 2 (Uniform Retry): the kernel retries every workflow the same
 * way — enqueue a new attempt with the SAME pristine input the prior run
 * saw (read from `tasks.original_input_json`, stamped at first enqueue),
 * and re-run the steps from the beginning. There is no per-workflow
 * `supportsRetry` gate, no structured "retry not supported" error, no
 * legacy JSONL-reconstruction fallback — historic tracker data was
 * deleted and the contract is mandatory for every row going forward.
 *
 * Idempotency is the workflow's responsibility (steps with irreversible
 * side effects must probe live state before re-creating).
 */

export interface RetryRequest {
  workflow: string;
  id: string;
  runId?: string;
  /** Tracker date selected in the dashboard. Used for retrying prior-day rows. */
  date?: string;
  /** When set, stamps the new run under this batch / delegation parent. */
  parentRunId?: string;
}

export interface RunWithDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
  runId?: string;
  date?: string;
  parentRunId?: string;
}

export interface RetryBulkRequest {
  workflow: string;
  ids?: string[];
  items?: Array<{ id: string; runId?: string }>;
  date?: string;
  parentRunId?: string;
}

type ReEnqueueResult = { ok: true } | { ok: false; error: string };
type EntryReEnqueueRequest = RetryRequest | RunWithDataRequest;

/** In-process workflows that don't run via the daemon queue — retry routes
 * through their existing in-process launchers instead of `enqueueFromHttp`.
 * See `src/workflows/CLAUDE.md` ("Existing Workflows" table) for the
 * non-daemon rationale. */
const IN_PROCESS_WORKFLOWS = new Set(["ocr", "sharepoint-download"]);

export function resolveRetryRosterPath(dir: string, storedRosterPath: string | undefined): string | undefined {
  if (storedRosterPath && existsSync(storedRosterPath)) return storedRosterPath;
  return findLatestDownloadedRosterPath(dir);
}

function findLatestDownloadedRosterPath(dir: string): string | undefined {
  const latest = resolveRosterDirs(dir)
    .flatMap((rosterDir) => listRosters(rosterDir))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return latest?.path;
}

export type FindEntryInputResult =
  | {
      input: Record<string, unknown>;
      /** Latest non-empty delegation parent seen on any row for this item id */
      latestParentRunId?: string;
      /** Merged accumulated `data` strings for edit-and-resume (same rules as {@link findLatestEntryData}). */
      mergedEntryStrings: Record<string, string>;
    }
  | { error: string };

/** Merge accumulated `data` for an item from pre-filtered tracker rows */
function mergeAccumulatedTrackerStrings(rows: TrackerEntry[]): Record<string, string> {
  const entries = rows.filter((e) => e.data);
  if (entries.length === 0) return {};
  entries.sort(byTimestampAsc);
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

/** Latest non-empty `parentRunId` among `rows` (sorted by tracker `timestamp`). */
function extractLatestParentRunId(rows: TrackerEntry[]): string | undefined {
  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort(byTimestampAsc);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!.parentRunId;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

/**
 * Lookup an entry's input by (workflow, id, runId?). SQLite tier-1 runs first
 * when `runId` is set; one JSONL pass supplies input fallback, latest parent
 * run id, and accumulated data for merge.
 *
 * **Edit-and-resume only.** Contract 2 retries read the pristine original
 * input from `tasks.original_input_json` directly. This function's
 * `mergedEntryStrings` exists so edit-and-resume can seed the `prefilledData`
 * channel with previously-extracted non-editable fields (e.g. separations'
 * `rawTerminationType` carried forward into the prefill). Do NOT call this
 * from a pure retry path — folding accumulated `data.*` fields leaks state
 * from prior runs into the input.
 */
export function findEntryInput(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
  date?: string,
): FindEntryInputResult {
  let input: Record<string, unknown> | undefined;
  if (runId) {
    const fromTask = findRetryInputFromTaskStore(runId, dir);
    if (fromTask) input = fromTask;
  }
  const { allForId, scoped } = readEntriesForRetryItem(workflow, id, runId, dir, date);
  if (!input) {
    input = selectRetryInputFromEntries(scoped);
  }
  if (!input) {
    if (scoped.length === 0) {
      return { error: `no tracker entry found for id=${id}` };
    }
    return { error: "no input or data found to reconstruct retry payload" };
  }
  return {
    input,
    latestParentRunId: extractLatestParentRunId(runId ? scoped : allForId),
    mergedEntryStrings: mergeAccumulatedTrackerStrings(allForId),
  };
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
  const rows = readEntries(workflow, dir).filter((e) => e.id === id && e.data);
  return mergeAccumulatedTrackerStrings(rows);
}

/**
 * Latest non-empty `parentRunId` on any tracker row for this item id (by
 * timestamp). Used so retries stay inside a dashboard batch when the HTTP
 * client did not send an explicit `parentRunId`.
 */
export function findLatestParentRunId(
  workflow: string,
  id: string,
  dir: string,
): string | undefined {
  const { allForId } = readEntriesForRetryItem(workflow, id, undefined, dir);
  return extractLatestParentRunId(allForId);
}

interface ReEnqueueOptions {
  prefilledData?: Record<string, unknown>;
  parentRunId?: string;
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
  dir: string,
  options?: ReEnqueueOptions,
  date?: string,
): Promise<ReEnqueueResult> {
  const prefilledData = options?.prefilledData;
  const requestedParent = options?.parentRunId;

  // Tolerate trailing slash from URL-shaped workflow values that occasionally
  // leak in from clients that build paths instead of identifiers.
  const wf = workflow.trim().replace(/\/+$/, "");
  if (!wf || !id) return { ok: false, error: "workflow and id are required" };

  if (runId && !prefilledData) {
    const stores = openControlStores(dir);
    const task = resolveControlTask(stores.taskStore, wf, id, runId);
    if (task) {
      // Contract 2: read the pristine original input from the task record.
      // Stamped at first enqueue (migration 11). Historic rows that predate
      // the column were purged — a null here is a bug, not a legacy state.
      const originalInput = stores.taskStore.findOriginalInputForRunId(runId);
      const input = asRecordInput(originalInput);
      if (!input) {
        return {
          ok: false,
          error: `retry: tasks.original_input_json missing for runId=${runId} — every row must be stamped at enqueue (Contract 2). This is a bug, not a legacy state.`,
        };
      }
      // Log the input fields being used so retries are debuggable from
      // operator logs (Contract 2, Step C). Just key names — values can
      // contain PII / huge prefilledData payloads.
      log.step(
        `[retry] enqueueing ${wf}/${id} from runId=${runId} with pristine original input keys=[${Object.keys(input).sort().join(", ")}]`,
      );
      const resolvedParent =
        requestedParent ??
        task.parentRunId ??
        extractLatestParentRunId(readEntriesForRetryItem(wf, id, runId, dir, date).scoped);
      const retried = stores.taskStore.retryTaskFromAttempt({ runId });
      resetRetriedOcrDependencies(stores.taskStore.db, retried.taskId);
      if (resolvedParent) {
        stores.taskStore.db
          .prepare(`UPDATE tasks SET parent_run_id = @p WHERE id = @tid`)
          .run({ p: resolvedParent, tid: retried.taskId });
      }
      stores.workerStore.enqueueWorkerCommand({
        commandType: "retry_task",
        workflow: wf,
        targetTaskId: retried.taskId,
        targetAttemptId: retried.attemptId,
        state: "completed",
        payload: { fromRunId: runId, runId: retried.runId },
      });
      appendQueueEnqueueAudit(wf, retried.itemId, input, retried.runId, dir);
      // Inherit archetype from the failed run's latest row so the retry's
      // pending row surfaces with the same row type (batch-member, single,
      // delegate-child, etc.). Without the inheritance the new pending row
      // would default to deriveRowArchetype("single", parentRunId) — wrong
      // for any batch-member retry, which is one of the bugs this contract
      // is designed to prevent.
      //
      // Also preserve display metadata (__name, __id, __subject,
      // __queueTitle, parentSubject, etc.) by merging the prior row's
      // `data` fields onto the new pending row. Without the merge the
      // retry's pending row shows up nameless in the dashboard until the
      // daemon claims it and rewrites — the same pattern emitDashboardCancelTrackerRow
      // would have used but applied to retry.
      const priorRunRows = readEntriesForRetryItem(wf, id, runId, dir, date).scoped;
      const priorEntry = priorRunRows.length > 0 ? priorRunRows[priorRunRows.length - 1] : undefined;
      const priorArchetype = priorEntry ? resolveRowArchetype(priorEntry) : "single";
      const priorData = priorEntry?.data ?? {};
      emitTrackerRow(
        {
          workflow: wf,
          timestamp: new Date().toISOString(),
          id: retried.itemId,
          runId: retried.runId,
          status: "pending",
          input,
          // Carry prior display fields forward, then overlay computed
          // archetype + provenance stamp. archetype takes priority over
          // anything stored in priorData so the inheritance wins
          // unconditionally.
          data: {
            ...priorData,
            archetype: priorArchetype,
            __retriedFrom: runId,
          },
          ...(resolvedParent ? { parentRunId: resolvedParent } : {}),
        },
        dir,
      );
      return { ok: true };
    }
  }

  if (IN_PROCESS_WORKFLOWS.has(wf)) {
    return reEnqueueInProcessEntry(wf, id, runId, dir, date);
  }

  // Edit-and-resume only: prefilledData carries user edits that need to be
  // merged with previously-extracted (non-editable) fields like separations'
  // rawTerminationType. findEntryInput's mergedEntryStrings seeds that prefill
  // channel — this is NOT a retry fallback, it's the legitimate edit-and-
  // resume path. A pure retry should never reach here (the SQLite task lookup
  // above handles all retries); if it does, the prior task row is missing,
  // which is a bug.
  if (!prefilledData) {
    return {
      ok: false,
      error: `retry: no SQLite task record found for workflow=${wf} id=${id}${runId ? ` runId=${runId}` : ""} — pure retries require the task store row (Contract 2).`,
    };
  }
  const lookup = findEntryInput(wf, id, runId, dir, date);
  if ("error" in lookup) return { ok: false, error: lookup.error };

  const input: Record<string, unknown> = {
    ...lookup.input,
    prefilledData: {
      ...lookup.mergedEntryStrings,
      ...prefilledData,
    },
  };

  const resolvedParent = requestedParent ?? lookup.latestParentRunId;
  const result = await enqueueFromHttp(wf, [input], {
    trackerDir: dir,
    ...(resolvedParent ? { parentRunId: resolvedParent } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
  return { ok: true };
}

function resetRetriedOcrDependencies(db: { prepare: (sql: string) => { run: (params: Record<string, unknown>) => unknown } }, taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE task_dependencies
    SET status = 'pending',
        result_json = '{}',
        updated_at = @now,
        terminal_at = NULL
    WHERE child_task_id = @taskId
      AND kind IN ('ocr-eid-lookup', 'ocr-active-check')
      AND status IN ('failed', 'cancelled')
  `).run({ taskId, now });
  db.prepare(`
    UPDATE tasks
    SET control_state = 'waiting_dependencies',
        terminal_at = NULL,
        terminal_error = NULL,
        updated_at = @now
    WHERE id IN (
      SELECT parent_task_id
      FROM task_dependencies
      WHERE child_task_id = @taskId
        AND kind IN ('ocr-eid-lookup', 'ocr-active-check')
    )
  `).run({ taskId, now });
}

/** Retry for in-process workflows — dispatches to the same launcher their
 * original HTTP entry point uses. */
async function reEnqueueInProcessEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
  date?: string,
): Promise<ReEnqueueResult> {
  // Workflow-name dispatch here is intentional: these are routing decisions to
  // different HTTP re-entry implementations, not archetype discrimination.
  if (workflow === "ocr") return reEnqueueOcrEntry(id, runId, dir, date);
  if (workflow === "sharepoint-download") return reEnqueueSharePointEntry(id, runId, dir, date);
  return { ok: false, error: `in-process retry not implemented for "${workflow}"` };
}

async function reEnqueueOcrEntry(
  id: string,
  runId: string | undefined,
  dir: string,
  date?: string,
): Promise<ReEnqueueResult> {
  // The OCR orchestrator only writes pdfPath/pdfOriginalName on the pending
  // row — later rows (loading-roster, ocr, awaiting-approval, failed) drop
  // them. findEntryInput's latest-row fallback would miss them, so merge
  // across every row for this id and keep the latest non-empty value per key.
  const source = date ? readEntriesForDate("ocr", date, dir) : readEntries("ocr", dir);
  const entries = source.filter((e) => e.id === id);
  if (entries.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id}` };
  }
  const matching = runId ? entries.filter((e) => e.runId === runId) : entries;
  if (matching.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id} runId=${runId}` };
  }
  const merged: Record<string, string> = {};
  [...matching].sort(byTimestampAsc).forEach((e) => {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      merged[k] = String(v);
    }
  });

  const pdfPath = merged.pdfPath ?? "";
  const pdfOriginalName = merged.pdfOriginalName ?? "";
  const formType = merged.formType ?? "";
  const sessionId = merged.sessionId || id;
  const retryRosterPath = resolveRetryRosterPath(dir, merged.rosterPath || undefined);
  const rosterMode: "existing" | "download" = retryRosterPath ? "existing" : "download";

  if (!pdfPath || !pdfOriginalName || !formType) {
    return {
      ok: false,
      error: "OCR retry: entry data missing pdfPath/pdfOriginalName/formType",
    };
  }
  if (!existsSync(pdfPath)) {
    return { ok: false, error: `OCR retry: PDF no longer exists at ${pdfPath}` };
  }

  const { buildOcrPrepareHandler } = await import("../../tracker/dashboard/ocr/prepare.js");
  const handler = buildOcrPrepareHandler({ trackerDir: dir });
  const result = await handler({
    pdfPath,
    pdfOriginalName,
    formType,
    sessionId,
    rosterMode,
    ...(retryRosterPath ? { rosterPath: retryRosterPath } : {}),
  });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

async function reEnqueueSharePointEntry(
  id: string,
  runId: string | undefined,
  dir: string,
  date?: string,
): Promise<ReEnqueueResult> {
  const lookup = findEntryInput("sharepoint-download", id, runId, dir, date);
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
    "../../workflows/sharepoint-download/handler.js"
  );
  const handler = buildSharePointRosterDownloadHandler();
  const result = await handler({ id: specId });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

export function buildEntryReEnqueueHandler(dir: string, opts: { withData?: boolean } = {}) {
  return (req: EntryReEnqueueRequest): Promise<ReEnqueueResult> => {
    const prefilledData = opts.withData && "data" in req ? req.data : undefined;
    if (opts.withData && (!prefilledData || typeof prefilledData !== "object")) {
      return Promise.resolve({ ok: false, error: "data is required" });
    }
    return reEnqueueEntry(req.workflow, req.id, req.runId, dir, {
      ...(prefilledData ? { prefilledData } : {}),
      parentRunId: req.parentRunId,
    }, req.date);
  };
}

export function buildRetryHandler(dir: string) {
  return buildEntryReEnqueueHandler(dir);
}

export function buildRunWithDataHandler(dir: string) {
  return buildEntryReEnqueueHandler(dir, { withData: true });
}

/** Bulk retry helper. HTTP `/api/retry-bulk` routes through `performWorkflowAction`. */
export function buildRetryBulkHandler(dir: string) {
  const retry = buildRetryHandler(dir);
  return async (
    req: RetryBulkRequest,
  ): Promise<{ ok: true; count: number; errors: Array<{ id: string; error: string }> }> => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    const items: Array<{ id: string; runId?: string }> = req.items && req.items.length > 0
      ? req.items
      : (req.ids ?? []).map((id) => ({ id }));
    for (const item of items) {
      const r = await retry({
        workflow: req.workflow,
        id: item.id,
        runId: item.runId,
        date: req.date,
        parentRunId: req.parentRunId,
      });
      if (r.ok) count++;
      else errors.push({ id: item.id, error: r.error });
    }
    return { ok: true, count, errors };
  };
}
