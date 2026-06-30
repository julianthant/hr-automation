/**
 * Generic enqueue dispatcher for the dashboard's `POST /api/enqueue`
 * endpoint. Resolves a workflow name, validates each input through the
 * workflow's Zod schema, then delegates to `ensureDaemonsAndEnqueue` with
 * a generic `onPreEmitPending` that writes a `pending` tracker row per
 * item so the dashboard queue populates instantly (before the daemon's
 * Duo completes).
 *
 * Older per-workflow adapters (`runSeparationCli`, etc.) have their own
 * hand-rolled `onPreEmitPending` bodies and are kept for internal callers.
 * This dispatcher is the public dashboard path: adding a new input-run
 * workflow requires registering it in `workflow-loaders.ts`, the shared
 * dashboard run-surface allowlist, and the frontend input-run registry; no
 * workflow-specific backend wiring.
 */
import { randomUUID } from "node:crypto";
import { loadWorkflow } from "../workflow-loaders.js";
import { runOptionsToDaemonFlags, type RunOptions } from "../../domain/run-options.js";
import type { RegisteredWorkflow } from "../kernel/types.js";
import { splitPrefilled } from "../kernel/workflow.js";
import { buildPendingTrackerData } from "../pending-data.js";
import { deriveRowArchetype, resolveArchetype } from "../../domain/row-archetype.js";
import { buildTraceId } from "../../domain/queue-trace-id.js";
import { allocateLowestBatchDisplayOrdinal } from "../../tracker/batch-display-ordinal.js";
import { DEFAULT_DIR, emitTrackerRow, type StampedData } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";

export interface EnqueueHttpResult {
  ok: boolean;
  workflow: string;
  enqueued: number;
  error?: string;
}

/** Options for {@link enqueueFromHttp} (queue dir + optional batch / delegation id). */
export interface EnqueueFromHttpOptions {
  trackerDir?: string;
  /** Stamps every queued item + pre-emitted tracker rows with this parent run id. */
  parentRunId?: string;
  /**
   * Operator-chosen run options (Automation-workers setting). Mapped to daemon
   * spawn flags via `runOptionsToDaemonFlags` — Auto/`1` → no flags (reuse or
   * spawn one); `N > 1` → `{ parallel: N }` (ensure ≥N daemons alive). See
   * `src/domain/run-options.ts`.
   */
  runOptions?: RunOptions;
  /**
   * Control-plane callback that enforces "one active run per queue row":
   * cancel any prior non-terminal run for the items about to be enqueued. Fired
   * from the kernel's `onPreparedItems` hook — after stable itemIds/runIds are
   * assigned but BEFORE the new pending row and task are written, so it sees
   * only prior runs (`exceptRunIds` carries the new runIds as belt-and-braces).
   *
   * Injected (not implemented here) because the cancellation reaches into the
   * control layer (`src/control/ops/supersede.ts`), which `src/core/` must not
   * import. The dashboard `/api/enqueue` route supplies it; delegated /
   * batch-fan-out enqueue paths that call `ensureDaemonsAndEnqueue` directly do
   * NOT, so an operation's members are never superseded. Best-effort: a throw
   * here is logged and the new run proceeds regardless.
   */
  supersedePriorRuns?: (
    items: Array<{ itemId: string; runId: string }>,
  ) => Promise<void> | void;
}

export interface EnqueueValidateResult {
  ok: boolean;
  error?: string;
}

/**
 * Synchronous pre-validation: resolves the workflow name + runs every
 * input through the workflow's Zod schema. Used by the HTTP handler to
 * return 400 before fire-and-forgetting the spawn phase. Kept separate
 * from `enqueueFromHttp` so the handler can surface validation errors
 * synchronously instead of swallowing them in a background task.
 */
export async function validateEnqueueRequest(
  workflowName: string,
  inputs: unknown[],
): Promise<EnqueueValidateResult> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, error: "inputs must be a non-empty array" };
  }
  const wf = await loadWorkflow(workflowName);
  if (!wf) {
    return { ok: false, error: `unknown workflow: ${workflowName}` };
  }
  for (const input of inputs) {
    const result = wf.config.schema.safeParse(input);
    if (!result.success) {
      return { ok: false, error: `validation failed: ${result.error.message}` };
    }
  }
  return { ok: true };
}

/**
 * Shape tracker row `data` from an arbitrary input object. Only primitive
 * top-level fields are carried over — nested objects collapse to their
 * JSON form, which matches how legacy adapters serialize identifiers
 * (e.g. separations stores `{docId}` as a string). Skips undefined/null.
 */
function serializeInputForTracker(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      try {
        out[key] = JSON.stringify(value);
      } catch {
        out[key] = String(value);
      }
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Tracker-row `data` for an enqueued input, hoisting any `prefilledData`
 * channel onto the top level so edit-and-resume values surface in the
 * dashboard's detail grid + EditDataTab. Mirrors the shape written by
 * `onPreEmitPending` so downstream "failed" rows (e.g. orphan-queue cleanup
 * paths) don't overwrite the richer pending-row `data` with a stripped-down
 * blob that hides the user's edits behind an opaque `prefilledData` JSON.
 *
 * Base input keys (e.g. `docId`) win on collision since they're the
 * canonical identifiers. Strips `prefilledData` from the output — it's a
 * kernel channel, not a user-facing field.
 */
export function buildTrackerDataForInput(input: unknown): Record<string, string> {
  const baseData = serializeInputForTracker(input);
  const prefilled =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { prefilledData?: unknown }).prefilledData
      : undefined;
  const data: Record<string, string> =
    prefilled && typeof prefilled === "object" && !Array.isArray(prefilled)
      ? { ...serializeInputForTracker(prefilled), ...baseData }
      : baseData;
  delete data.prefilledData;
  delete data.__runtimeOptions;
  return data;
}

function mergeRuntimeOptions(input: unknown, runtimeOptions: Record<string, unknown>): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const current = (input as { __runtimeOptions?: unknown }).__runtimeOptions;
  const currentRuntimeOptions =
    current && typeof current === "object" && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...currentRuntimeOptions,
      ...runtimeOptions,
    },
  };
}

/**
 * Full pending-row data for dashboard-sourced enqueue requests. This layers
 * the generic serialized input with the same workflow hooks the kernel uses
 * for in-process/batch pending rows (`initialData`, `operatorSubject`,
 * `getName`, and `getId`), so the UI path does not lose stable labels while
 * auth is still waiting.
 */
export function buildHttpPendingData<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: unknown,
  parentRunId?: string,
  runId?: string,
): StampedData {
  const baseData = buildTrackerDataForInput(input);
  const { cleaned, runtimeOptions } = splitPrefilled(input);
  const handlerInput = wf.config.schema.parse(cleaned) as TData;
  const rowArchetype = runtimeOptions?.rowShape
    ? deriveRowArchetype(resolveArchetype(wf.config, handlerInput), parentRunId, {
        memberShape: runtimeOptions.rowShape,
      })
    : undefined;
  return buildPendingTrackerData({
    workflow: wf,
    input: handlerInput,
    baseData,
    useInitialTrackerSeed: true,
    nameIdStamp: "if-truthy-on-merged",
    parentRunId,
    ...(runId ? { runId } : {}),
    ...(rowArchetype ? { rowArchetype } : {}),
  });
}

/**
 * Validate + enqueue HTTP-sourced inputs. Thin wrapper over
 * `ensureDaemonsAndEnqueue` — returns `{ok:false, error}` on any failure
 * so the HTTP handler can map to an appropriate status code.
 */
export async function enqueueFromHttp(
  workflowName: string,
  inputs: unknown[],
  trackerDirOrOptions?: string | EnqueueFromHttpOptions,
): Promise<EnqueueHttpResult> {
  const trackerDir =
    typeof trackerDirOrOptions === "string"
      ? trackerDirOrOptions
      : trackerDirOrOptions?.trackerDir;
  const parentRunId =
    typeof trackerDirOrOptions === "object" && trackerDirOrOptions
      ? trackerDirOrOptions.parentRunId
      : undefined;
  const runOptions =
    typeof trackerDirOrOptions === "object" && trackerDirOrOptions
      ? trackerDirOrOptions.runOptions
      : undefined;
  const supersedePriorRuns =
    typeof trackerDirOrOptions === "object" && trackerDirOrOptions
      ? trackerDirOrOptions.supersedePriorRuns
      : undefined;
  const daemonFlags = runOptionsToDaemonFlags(runOptions);

  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, workflow: workflowName, enqueued: 0, error: "inputs must be a non-empty array" };
  }

  const wf = await loadWorkflow(workflowName);
  if (!wf) {
    return { ok: false, workflow: workflowName, enqueued: 0, error: `unknown workflow: ${workflowName}` };
  }

  const resolvedTrackerDir = trackerDir ?? DEFAULT_DIR;
  let effectiveParentRunId = parentRunId;
  let operationCoordinatorRunId: string | undefined;
  let batchDisplayOrdinal: number | undefined;
  // A multi-item input run is always an operation coordinator. Some workflows
  // (oath-signature) opt to wrap a SINGLE-item input run too via
  // `delegation.alwaysOperationInputRun`, so they never produce a standalone single
  // row. Only applies to direct input runs (no parentRunId) — delegated
  // fan-out rows already carry one.
  const forcesInputRunOperation =
    wf.config.runtimePolicy?.delegation?.alwaysOperationInputRun === true;
  const isDirectInputRunOperation =
    (inputs.length > 1 || forcesInputRunOperation) && !effectiveParentRunId;
  if (isDirectInputRunOperation) {
    operationCoordinatorRunId = randomUUID();
    effectiveParentRunId = operationCoordinatorRunId;
    batchDisplayOrdinal = allocateLowestBatchDisplayOrdinal(workflowName, resolvedTrackerDir);
  }
  const queuedInputs = isDirectInputRunOperation
    ? inputs.map((input) => mergeRuntimeOptions(input, { rowShape: "operation-member" }))
    : inputs;

  // Fail-fast schema validation here (ensureDaemonsAndEnqueue also does this,
  // but surfacing it early lets us return 400 with a precise message instead
  // of a generic 500 for schema mismatches).
  for (const input of queuedInputs) {
    // Strip the kernel-level prefilledData channel before validating so
    // strict()-mode workflow schemas don't reject it as unknown. The
    // channel rides through to the daemon via the SQLite task input (also
    // mirrored in JSONL audit) and the kernel re-strips at handler-invocation
    // time — see splitPrefilled in src/core/workflow.ts.
    const { cleaned } = splitPrefilled(input);
    const result = wf.config.schema.safeParse(cleaned);
    if (!result.success) {
      return {
        ok: false,
        workflow: workflowName,
        enqueued: 0,
        error: `validation failed: ${result.error.message}`,
      };
    }
  }

  const { ensureDaemonsAndEnqueue } = await import("./client.js");
  const now = new Date().toISOString();
  const deriveItemId = wf.config.deriveItemId
    ? (item: unknown) => {
        const { cleaned } = splitPrefilled(item);
        return wf.config.deriveItemId?.(cleaned) ?? "";
      }
    : undefined;

  try {
    if (operationCoordinatorRunId) {
      const coordinatorItemId = `input-run-${operationCoordinatorRunId.slice(0, 8)}`;
      const coordinatorTraceId = buildTraceId({
        code: wf.code,
        runId: operationCoordinatorRunId,
        at: new Date(now),
      });
      const coordinatorData: StampedData = {
        archetype: "operation",
        queueRowKind: "person",
        __id: coordinatorItemId,
        __traceId: coordinatorTraceId,
        ...(batchDisplayOrdinal !== undefined
          ? { batchDisplayOrdinal: String(batchDisplayOrdinal) }
          : {}),
      };
      emitTrackerRow(
        {
          workflow: wf.config.name,
          timestamp: now,
          id: coordinatorItemId,
          runId: operationCoordinatorRunId,
          status: "pending",
          data: coordinatorData,
        },
        resolvedTrackerDir,
      );
    }

    await ensureDaemonsAndEnqueue(
      wf,
      queuedInputs,
      daemonFlags,
      {
        trackerDir,
        ...(effectiveParentRunId ? { parentRunId: effectiveParentRunId } : {}),
        ...(deriveItemId ? { deriveItemId } : {}),
        // Enforce "one active run per queue row": cancel prior non-terminal
        // runs for these items before the new pending row / task are written.
        // Fires here (after stable itemIds/runIds, before pre-emit + enqueue)
        // so the supersede query sees only prior runs. Best-effort — a failure
        // must not block the new run, so swallow + log and continue.
        ...(supersedePriorRuns
          ? {
              onPreparedItems: async (prepared) => {
                try {
                  await supersedePriorRuns(
                    prepared.map((p) => ({ itemId: p.itemId, runId: p.runId })),
                  );
                } catch (err) {
                  log.warn(
                    `enqueueFromHttp(${workflowName}): supersedePriorRuns failed (continuing): ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
              },
            }
          : {}),
        onPreEmitPending: (item, runId, passedParentRunId, itemId) => {
          /** Pending + spawn-failure rows share stamp; `??` tolerates enqueue-client vs HTTP-option drift. */
          const stampedParentRunId = passedParentRunId ?? effectiveParentRunId;
          const data = buildHttpPendingData(wf, item, stampedParentRunId, runId);
          if (batchDisplayOrdinal !== undefined) {
            data.batchDisplayOrdinal = String(batchDisplayOrdinal);
          }
          const id = itemId;
          // Persist the original input verbatim on the pending row so the
          // dashboard's retry / edit-and-resume features can reconstruct
          // the call without per-workflow input-shaping logic. See the
          // `input` field on `TrackerEntry` in src/tracker/jsonl.ts.
          const input =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : undefined;
          emitTrackerRow(
            {
              workflow: wf.config.name,
              timestamp: now,
              id,
              runId,
              status: "pending",
              data,
              ...(stampedParentRunId ? { parentRunId: stampedParentRunId } : {}),
              ...(input ? { input } : {}),
            },
            resolvedTrackerDir,
          );
        },
        onPreEmitFailed: (item, runId, error, itemId) => {
          // Pre-emit succeeded but spawn-or-enqueue failed; the dashboard
          // already shows a `pending` row for this runId and there's no
          // queue-file entry for the orphan sweep to clean up. Write a
          // matching `failed` row so the row terminates instead of
          // becoming a ghost. Use the same data-shape helper as the
          // pending emit so prefilledData (edit-and-resume) values stay
          // visible on the failed row.
          const data = buildHttpPendingData(wf, item, effectiveParentRunId, runId);
          if (batchDisplayOrdinal !== undefined) {
            data.batchDisplayOrdinal = String(batchDisplayOrdinal);
          }
          const id = itemId;
          emitTrackerRow(
            {
              workflow: wf.config.name,
              timestamp: new Date().toISOString(),
              id,
              runId,
              status: "failed",
              data,
              ...(effectiveParentRunId ? { parentRunId: effectiveParentRunId } : {}),
              error: `Spawn failed before enqueue: ${error}`,
            },
            resolvedTrackerDir,
          );
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`enqueueFromHttp(${workflowName}): ${message}`);
    return { ok: false, workflow: workflowName, enqueued: 0, error: message };
  }

  return { ok: true, workflow: workflowName, enqueued: queuedInputs.length };
}
