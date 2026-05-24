import type { RegisteredWorkflow } from "./kernel/types.js";
import { buildInitialTrackerData } from "./kernel/workflow.js";
import { deriveRowArchetype } from "../domain/row-archetype.js";
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

  data.archetype = deriveRowArchetype(wf.archetype, opts.parentRunId);

  return data as StampedData;
}
