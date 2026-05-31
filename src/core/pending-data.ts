import type { RegisteredWorkflow } from "./kernel/types.js";
import { buildInitialTrackerData } from "./kernel/workflow.js";
import { deriveRowArchetype, resolveArchetype, type RowArchetype } from "../domain/row-archetype.js";
import { resolveQueueRowKindFromValue } from "../domain/queue-row-kind.js";
import { buildTraceId } from "../domain/queue-trace-id.js";
import { operatorSubjectData } from "../domain/operator-subject.js";
import { rootQueueTitleData } from "../domain/queue-title.js";
import type { StampedData } from "../tracker/jsonl.js";

export type NameIdStamp = "omit" | "if-truthy-on-merged" | "always-on-seed";

export interface BuildPendingTrackerDataOpts<TInput> {
  workflow: RegisteredWorkflow<TInput, readonly string[]>;
  input: TInput;
  parentRunId?: string;
  parentSubject?: string;
  /** Merged after the initial tracker seed (if any). */
  extraData?: Record<string, unknown>;
  /** Serialized raw input (HTTP enqueue). Merged before the initial tracker seed. */
  baseData?: Record<string, string>;
  /** Merge `initialData` + `operatorSubject` + `queueTitle` via `buildInitialTrackerData`. */
  useInitialTrackerSeed?: boolean;
  /** Bypass the internal `buildInitialTrackerData` call when the caller has already computed the seed. Only consulted when `useInitialTrackerSeed === true`. */
  precomputedSeed?: Record<string, string>;
  nameIdStamp?: NameIdStamp;
  rowArchetype?: RowArchetype;
  /** Run id for this row — stamps `data.__traceId` when provided. */
  runId?: string;
  /**
   * Provenance code for the trace-id prefix — the ROOT run's workflow code so
   * a delegated row traces back to where it came from. Defaults to this
   * workflow's own `code`.
   */
  rootCode?: string;
  /** Timestamp for the trace id; defaults to `new Date()`. Tests pass a fixed Date. */
  at?: Date;
  /**
   * Pre-frozen trace id to stamp verbatim. When set it wins over the
   * `runId`/`at` computation, so a re-emit (e.g. a daemon worker re-emitting
   * `pending` after the HTTP enqueue already stamped one) reuses the exact id
   * the first row showed instead of minting a fresh, time-drifted one.
   */
  traceId?: string;
}

function stringifyExtra(extra: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
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
 * Single merge point for tracker `data` on `pending` pre-emits and the
 * kernel's in-batch pending row. Field order matches the HTTP enqueue path
 * (`buildHttpPendingData`): workflow seed → extras → __name/__id → subject →
 * delegation queue title → archetype.
 */
export function buildPendingTrackerData<TInput>(
  opts: BuildPendingTrackerDataOpts<TInput>,
): StampedData {
  const wf = opts.workflow;
  const data: Record<string, string> = {};

  if (opts.baseData) {
    Object.assign(data, opts.baseData);
  }

  if (opts.useInitialTrackerSeed) {
    Object.assign(data, opts.precomputedSeed ?? buildInitialTrackerData(wf, opts.input));
  }

  if (opts.extraData) {
    Object.assign(data, stringifyExtra(opts.extraData));
  }

  const stamp = opts.nameIdStamp ?? (opts.useInitialTrackerSeed ? "if-truthy-on-merged" : "omit");
  if (stamp === "always-on-seed") {
    const seed = { ...data };
    data.__name = wf.config.getName?.(seed) ?? "";
    data.__id = wf.config.getId?.(seed) ?? "";
  } else if (stamp === "if-truthy-on-merged") {
    const name = wf.config.getName?.(data);
    if (name) data.__name = name;
    const id = wf.config.getId?.(data);
    if (id) data.__id = id;
  }

  if (!opts.useInitialTrackerSeed) {
    const subject = wf.config.operatorSubject?.(opts.input);
    Object.assign(data, operatorSubjectData(subject));
  }

  if (opts.parentSubject) {
    Object.assign(data, rootQueueTitleData(opts.parentSubject));
  }

  data.archetype = opts.rowArchetype ?? deriveRowArchetype(
    resolveArchetype(wf.config, opts.input),
    opts.parentRunId,
  );

  // Subject-semantics kind (drives queue title/subtitle). Static per row.
  data.queueRowKind = resolveQueueRowKindFromValue(wf.queueRowKind, opts.input, wf.config.name);

  // Human-readable, unique, log-greppable trace id — frozen once at pre-emit.
  // A re-emit passes the already-frozen `traceId` so every row for a run shows
  // the identical id; the `runId`/`at` compute path is the first-emit case.
  if (opts.traceId) {
    data.__traceId = opts.traceId;
  } else if (opts.runId) {
    data.__traceId = buildTraceId({
      code: opts.rootCode ?? wf.code,
      runId: opts.runId,
      at: opts.at ?? new Date(),
    });
  }

  return data as StampedData;
}
