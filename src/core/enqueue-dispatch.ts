/**
 * Generic enqueue dispatcher for the dashboard's `POST /api/enqueue`
 * endpoint. Resolves a workflow name, validates each input through the
 * workflow's Zod schema, then delegates to `ensureDaemonsAndEnqueue` with
 * a generic `onPreEmitPending` that writes a `pending` tracker row per
 * item so the dashboard queue populates instantly (before the daemon's
 * Duo completes).
 *
 * Per-workflow CLI adapters (`runSeparationCli`, etc.) have their own
 * hand-rolled `onPreEmitPending` bodies — they predate this dispatcher
 * and are kept as-is. This dispatcher is the "scalable" path: adding a
 * new workflow to the dashboard's Run panel requires only registering
 * it in `workflow-loaders.ts` plus a frontend registry entry; no
 * workflow-specific backend wiring.
 */
import { loadWorkflow } from "./workflow-loaders.js";
import { deriveItemId, splitPrefilled } from "./workflow.js";
import { trackEvent } from "../tracker/jsonl.js";
import { log } from "../utils/log.js";

export interface EnqueueHttpResult {
  ok: boolean;
  workflow: string;
  enqueued: number;
  error?: string;
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
 * JSON form, which matches how legacy CLI adapters serialize identifiers
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
 * Validate + enqueue HTTP-sourced inputs. Thin wrapper over
 * `ensureDaemonsAndEnqueue` — returns `{ok:false, error}` on any failure
 * so the HTTP handler can map to an appropriate status code.
 */
export async function enqueueFromHttp(
  workflowName: string,
  inputs: unknown[],
  trackerDir?: string,
): Promise<EnqueueHttpResult> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, workflow: workflowName, enqueued: 0, error: "inputs must be a non-empty array" };
  }

  const wf = await loadWorkflow(workflowName);
  if (!wf) {
    return { ok: false, workflow: workflowName, enqueued: 0, error: `unknown workflow: ${workflowName}` };
  }

  // Fail-fast schema validation here (ensureDaemonsAndEnqueue also does this,
  // but surfacing it early lets us return 400 with a precise message instead
  // of a generic 500 for schema mismatches).
  for (const input of inputs) {
    // Strip the kernel-level prefilledData channel before validating so
    // strict()-mode workflow schemas don't reject it as unknown. The
    // channel rides through to the daemon via the queue file (input is
    // serialized verbatim) and the kernel re-strips at handler-invocation
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

  const { ensureDaemonsAndEnqueue } = await import("./daemon-client.js");
  const now = new Date().toISOString();

  try {
    await ensureDaemonsAndEnqueue(
      wf,
      inputs,
      {},
      {
        trackerDir,
        onPreEmitPending: (item, runId) => {
          const data = serializeInputForTracker(item);
          const id = deriveItemId(item, runId);
          // Persist the original input verbatim on the pending row so the
          // dashboard's retry / edit-and-resume features can reconstruct
          // the call without per-workflow input-shaping logic. See the
          // `input` field on `TrackerEntry` in src/tracker/jsonl.ts.
          const input =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : undefined;
          trackEvent(
            {
              workflow: wf.config.name,
              timestamp: now,
              id,
              runId,
              status: "pending",
              data,
              ...(input ? { input } : {}),
            },
            trackerDir,
          );
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`enqueueFromHttp(${workflowName}): ${message}`);
    return { ok: false, workflow: workflowName, enqueued: 0, error: message };
  }

  return { ok: true, workflow: workflowName, enqueued: inputs.length };
}
