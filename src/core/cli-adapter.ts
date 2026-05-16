import type { RegisteredWorkflow } from "./kernel/types.js";
import type { DaemonFlags } from "./daemon/types.js";
import type { ensureDaemonsAndEnqueue as ensureDaemonsAndEnqueueFn } from "./daemon/client.js";
import { ensureDaemonsAndEnqueue } from "./daemon/client.js";
import { trackEvent, type TrackerEntry } from "../tracker/jsonl.js";
import { operatorSubjectData } from "../domain/operator-subject.js";
import { log } from "../utils/log.js";

type EnqueueFn<TInput> = (
  workflow: RegisteredWorkflow<TInput, readonly string[]>,
  inputs: TInput[],
  flags: DaemonFlags,
  opts: Parameters<typeof ensureDaemonsAndEnqueueFn<TInput, readonly string[]>>[3],
) => Promise<void>;

export function runCliEntry(ok: boolean, errorMessage: string): boolean {
  if (ok) return true;
  log.error(errorMessage);
  process.exitCode = 1;
  return false;
}

export interface BuildCliAdapterOpts<TArgs extends readonly unknown[], TInput> {
  workflow: RegisteredWorkflow<TInput, readonly string[]>;
  emptyMessage: string;
  buildInputs: (...args: TArgs) => TInput[];
  deriveItemId?: (input: TInput) => string;
  buildPendingData: (input: TInput, itemId: string) => Record<string, string>;
  pendingExtras?: (
    input: TInput,
    itemId: string,
    runId: string,
    parentRunId?: string,
  ) => Record<string, string>;
  onPreEmitFailed?: (input: TInput, runId: string, error: unknown, itemId: string) => void;
  getPendingId?: (input: TInput, itemId: string) => string;
  flags?: (options: { new?: boolean; parallel?: number }) => DaemonFlags;
  track?: (entry: TrackerEntry) => void;
  enqueue?: EnqueueFn<TInput>;
}

export function buildCliAdapter<TArgs extends readonly unknown[], TInput>(
  opts: BuildCliAdapterOpts<TArgs, TInput>,
): (...args: [...TArgs, { new?: boolean; parallel?: number }?]) => Promise<void> {
  return async (...argsWithMaybeOptions) => {
    const last = argsWithMaybeOptions.at(-1);
    const options =
      last && typeof last === "object" && !Array.isArray(last) && ("new" in last || "parallel" in last)
        ? (argsWithMaybeOptions.pop() as { new?: boolean; parallel?: number })
        : {};
    const inputs = opts.buildInputs(...(argsWithMaybeOptions as unknown as TArgs));
    if (!runCliEntry(inputs.length > 0, opts.emptyMessage)) return;

    const enqueue = opts.enqueue ?? (ensureDaemonsAndEnqueue as unknown as EnqueueFn<TInput>);
    const track = opts.track ?? trackEvent;
    const now = new Date().toISOString();
    await enqueue(
      opts.workflow,
      inputs,
      opts.flags?.(options) ?? { new: options.new, parallel: options.parallel },
      {
        ...(opts.deriveItemId ? { deriveItemId: opts.deriveItemId } : {}),
        onPreEmitPending: (item, runId, parentRunId, itemId) => {
          const subject = opts.workflow.config.operatorSubject?.(item);
          const id = opts.getPendingId?.(item, itemId) ?? itemId;
          track({
            workflow: opts.workflow.config.name,
            timestamp: now,
            id,
            runId,
            ...(parentRunId ? { parentRunId } : {}),
            status: "pending",
            data: {
              ...opts.buildPendingData(item, itemId),
              ...operatorSubjectData(subject),
              ...opts.pendingExtras?.(item, itemId, runId, parentRunId),
            },
          });
        },
        ...(opts.onPreEmitFailed
          ? {
              onPreEmitFailed: (item, runId, error, itemId) => {
                opts.onPreEmitFailed?.(item, runId, error, itemId);
              },
            }
          : {}),
      },
    );
  };
}
