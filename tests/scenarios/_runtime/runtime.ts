import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Session } from "../../../src/core/kernel/session.js";
import { runOneItem } from "../../../src/core/kernel/workflow.js";
import type { RegisteredWorkflow } from "../../../src/core/kernel/types.js";

import {
  cloneWithScript,
  type CustomScenarioHandler,
  type ScenarioBeat,
} from "./scenario-handler.js";

export interface ScenarioRunHandle {
  runId: string;
  itemId: string;
  /** Resolves with the `runOneItem` result when the run terminates. */
  result: Promise<{ ok: boolean; kind?: string; error?: string }>;
}

export interface ScenarioRuntime<TData, TSteps extends readonly string[] = readonly string[]> {
  /** Temp tracker dir for this scenario — removed by `cleanup()`. */
  trackerDir: string;
  /** Workflow name (matches `workflow.config.name`). */
  workflow: string;

  /** Enqueue an item — kicks off `runOneItem` in the background. */
  enqueue: (input: TData, opts?: EnqueueOpts<TData, TSteps>) => ScenarioRunHandle;

  /** Resolves once the named step is in flight (kernel `running` row already written). */
  waitForStepStart: (stepName: string, timeoutMs?: number) => Promise<void>;

  /** Resolves once the named run reaches a terminal status (done / failed). */
  waitForTerminal: (runId: string, timeoutMs?: number) => Promise<void>;

  /**
   * Inject an operator cancel — flips the kernel's `isCancelRequested` probe
   * to true and releases any currently-held step so the kernel's
   * mapEscapedHandlerError remaps the failure to a CancelledError and stamps
   * `step: "cancelled"` on the terminal row.
   */
  cancelRow: (runId: string) => Promise<void>;

  /** Release a specific held step without cancelling. */
  releaseHold: (stepName: string) => void;

  /** Tear down the temp tracker dir. Idempotent. */
  cleanup: () => void;
}

export interface EnqueueOpts<TData = unknown, TSteps extends readonly string[] = readonly string[]> {
  itemId?: string;
  runId?: string;
  /**
   * Override the runtime-level default beats for this enqueue. Useful for
   * retry scenarios (one input, two runs with different scripted behavior)
   * and any test where each run needs its own throw / hold script.
   */
  beats?: ScenarioBeat[];
  /**
   * Test escape hatch — replace the entire scripted-beats handler body
   * with arbitrary code that gets the real kernel `ctx`. Use for scenarios
   * exercising `ctx.delegateTo` / `ctx.delegateToAll` (PDF-branch tests).
   */
  customHandler?: CustomScenarioHandler<TData, TSteps>;
}

export interface CreateScenarioRuntimeOpts<TData, TSteps extends readonly string[]> {
  workflow: RegisteredWorkflow<TData, TSteps>;
  /** Default beats — used when `enqueue()` doesn't pass its own. */
  beats?: ScenarioBeat[];
}

/**
 * Build a scenario runtime around a real `runOneItem` invocation. The runtime
 * owns:
 *   - a temp tracker dir (every JSONL write lands here, never `.tracker/`)
 *   - a stub `Session` (no browsers launched; `captureAll` is a no-op)
 *   - a cloned workflow whose handler runs the scripted beats
 *   - a cooperative cancel flag exposed to `runOneItem.isCancelRequested`
 *   - synchronization helpers (`waitForStepStart`, `waitForTerminal`)
 */
export async function createScenarioRuntime<TData, TSteps extends readonly string[]>(
  opts: CreateScenarioRuntimeOpts<TData, TSteps>,
): Promise<ScenarioRuntime<TData, TSteps>> {
  const trackerDir = mkdtempSync(join(tmpdir(), "hrauto-scenario-"));

  // Step-start synchronization. Promises are created lazily so test code that
  // waits for a step BEFORE the handler reaches it still works (the resolver
  // fires when the handler hits the step, then the awaiter sees the resolved
  // promise immediately).
  const stepResolvers = new Map<string, () => void>();
  const stepPromises = new Map<string, Promise<void>>();
  const ensureStepPromise = (name: string): Promise<void> => {
    let promise = stepPromises.get(name);
    if (!promise) {
      let resolve!: () => void;
      promise = new Promise<void>((r) => { resolve = r; });
      stepResolvers.set(name, resolve);
      stepPromises.set(name, promise);
    }
    return promise;
  };

  // Hold latches — one per step name. Set when the scripted step's `holdAt`
  // hook is awaiting release; consumed by `cancelRow` / `releaseHold`.
  const holdResolvers = new Map<string, () => void>();
  const holdRejecters = new Map<string, (err: Error) => void>();
  let cancelRequested = false;

  // Per-run AbortControllers (Contract 5). The kernel's `runOneItem`
  // constructs an AbortController per run; we capture it via
  // `onCancelController` so `cancelRow(runId)` can `.abort()` it directly,
  // unblocking any AbortSignal-aware await inside a scripted beat (used by
  // `cancel-during-playwright-wait.test.ts` to simulate a long
  // `waitForSelector` rejecting on cancel).
  const runControllers = new Map<string, AbortController>();

  // Shared hooks used by every per-enqueue workflow clone. Each enqueue
  // clones the production workflow with its own scripted handler (so retry
  // scenarios can pass different beats per run); the hooks reference the
  // runtime-level latches above so cancel / step-start / hold-release work
  // across all runs.
  const scriptHooks = {
    onStepReached: (name: string) => {
      ensureStepPromise(name);
      stepResolvers.get(name)?.();
    },
    holdAt: (name: string) => new Promise<void>((resolve, reject) => {
      // If cancel was already requested before we entered the hold, fail fast
      // so the kernel sees the cancel at the right moment.
      if (cancelRequested) {
        reject(new Error(`scenario cancel before hold(${name})`));
        return;
      }
      holdResolvers.set(name, resolve);
      holdRejecters.set(name, reject);
    }),
  };

  // Stub session — Session.forTesting bypasses Session.launch entirely. The
  // scripted handler never calls `ctx.page()`, so the empty browsers map is
  // never touched. `captureAll` is stubbed to a no-op because the kernel's
  // `tryScreenshot` would otherwise try to drive real Playwright on failure.
  const session = Session.forTesting({
    systems: opts.workflow.config.systems,
    browsers: new Map(),
    readyPromises: new Map(opts.workflow.config.systems.map((s) => [s.id, Promise.resolve()])),
  });
  (session as unknown as { captureAll: (args: unknown) => Promise<unknown[]> }).captureAll = async () => [];

  // Terminal synchronization — one promise per runId.
  const terminalResolvers = new Map<string, () => void>();
  const terminalPromises = new Map<string, Promise<void>>();
  const ensureTerminalPromise = (runId: string): Promise<void> => {
    let promise = terminalPromises.get(runId);
    if (!promise) {
      let resolve!: () => void;
      promise = new Promise<void>((r) => { resolve = r; });
      terminalResolvers.set(runId, resolve);
      terminalPromises.set(runId, promise);
    }
    return promise;
  };

  const enqueue: ScenarioRuntime<TData, TSteps>["enqueue"] = (input, enqueueOpts) => {
    const itemId = enqueueOpts?.itemId
      ?? opts.workflow.config.deriveItemId?.(input)
      ?? `scenario-${randomUUID().slice(0, 8)}`;
    const runId = enqueueOpts?.runId ?? `${itemId}#${randomUUID().slice(0, 8)}`;
    const beatsForRun = enqueueOpts?.beats ?? opts.beats ?? [];
    // Per-enqueue clone with this run's scripted handler. Shared hooks wire
    // step-start + hold latches back to the runtime-level state.
    const registered = cloneWithScript(
      opts.workflow,
      beatsForRun,
      scriptHooks,
      enqueueOpts?.customHandler,
    );
    ensureTerminalPromise(runId);
    const result = runOneItem({
      wf: registered,
      session,
      item: input,
      itemId: String(itemId),
      runId,
      trackerDir,
      callerPreEmits: false,
      isCancelRequested: () => cancelRequested,
      onCancelController: (controller) => {
        runControllers.set(runId, controller);
      },
    }).then((res) => {
      terminalResolvers.get(runId)?.();
      runControllers.delete(runId);
      return res;
    });
    return { runId, itemId: String(itemId), result };
  };

  const withTimeout = async (label: string, promise: Promise<void>, timeoutMs: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const waitForStepStart: ScenarioRuntime<TData>["waitForStepStart"] = (stepName, timeoutMs = 5000) =>
    withTimeout(`waitForStepStart("${stepName}")`, ensureStepPromise(stepName), timeoutMs);

  const waitForTerminal: ScenarioRuntime<TData>["waitForTerminal"] = (runId, timeoutMs = 5000) =>
    withTimeout(`waitForTerminal("${runId}")`, ensureTerminalPromise(runId), timeoutMs);

  const cancelRow: ScenarioRuntime<TData>["cancelRow"] = async (runId) => {
    cancelRequested = true;
    // Contract 5: abort the per-run AbortController so any
    // AbortSignal-aware await inside a scripted beat (e.g. simulated
    // `page.waitForSelector` via `AbortSignal.timeout`-style logic)
    // rejects immediately. Existing tests that use `hold: true` still
    // work via the hold-rejecter path below — the controller abort is
    // additive.
    const controller = runControllers.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("scenario cancel"));
    }
    // Release every active hold by rejecting — the rejected promise propagates
    // out of `ctx.step`'s body, the kernel sees a thrown error PLUS an active
    // isCancelRequested, and `mapEscapedHandlerError` rewrites it to
    // CancelledError + stamps `step: "cancelled"` on the terminal row.
    for (const [name, reject] of holdRejecters) {
      reject(new Error(`scenario cancel during hold(${name})`));
    }
    holdResolvers.clear();
    holdRejecters.clear();
  };

  const releaseHold: ScenarioRuntime<TData>["releaseHold"] = (stepName) => {
    holdResolvers.get(stepName)?.();
    holdResolvers.delete(stepName);
    holdRejecters.delete(stepName);
  };

  const cleanup = () => {
    try { rmSync(trackerDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  return {
    trackerDir,
    workflow: opts.workflow.config.name,
    enqueue,
    waitForStepStart,
    waitForTerminal,
    cancelRow,
    releaseHold,
    cleanup,
  };
}
