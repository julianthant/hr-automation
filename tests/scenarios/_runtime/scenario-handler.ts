import type { RegisteredWorkflow } from "../../../src/core/kernel/types.js";

/**
 * One beat in a scripted scenario handler. Each beat maps 1:1 to a kernel
 * emission so the resulting tracker JSONL has the same step shape a real
 * production handler would emit, without doing any real Playwright work.
 *
 * - `markStep` → `ctx.markStep(name)` (synchronous timeline marker)
 * - `step` → `ctx.step(name, body)` (wraps body in tracker step boundaries;
 *   when `hold: true` the body awaits the runtime's `holdAt` hook, which the
 *   test uses to inject cancel mid-step; `throw` throws from inside the body
 *   to drive failure paths)
 * - `updateData` → `ctx.updateData(data)` (no step boundary, just merges data
 *   into the row)
 */
export type ScenarioBeat =
  | { kind: "markStep"; name: string }
  | {
      kind: "step";
      name: string;
      /** When true, the step body awaits the runtime's `holdAt` hook before returning. */
      hold?: boolean;
      /**
       * Contract 5: simulate a long AbortSignal-aware Playwright wait
       * (e.g. `page.waitForSelector("foo", { timeout: ms })`) inside the
       * step body. The body awaits a setTimeout for `signalWaitMs` ms, but
       * subscribes to `ctx.signal` so an operator cancel rejects the wait
       * within a few ms instead of running the full timeout. Test asserts
       * cancel completes fast (~100ms) regardless of `signalWaitMs`.
       */
      signalWaitMs?: number;
      /** Optional: throw this error from inside the step body (after hold). */
      throw?: Error;
      /** Optional: data merged into the row at the start of the step body. */
      updateData?: Record<string, unknown>;
    }
  | { kind: "updateData"; data: Record<string, unknown> };

export interface ScriptHooks {
  /**
   * Fired AFTER the kernel emission for this beat is in flight:
   * - For `markStep`: after the synchronous `running, step: <name>` row is written.
   * - For `step`: inside the step body, after Stepper has already emitted the
   *   `running, step: <name>` row but before the body's hold/throw runs.
   *
   * This means `await rt.waitForStepStart(name)` is safe to snapshot
   * immediately afterward — the row is on disk.
   */
  onStepReached?: (stepName: string) => void;
  /**
   * Called when a `step` beat with `hold: true` is awaiting release. Returning
   * a promise lets the runtime pause the step body until the test signals
   * release (or cancel). A reject from this hook throws inside `ctx.step`,
   * triggering the kernel's step-failed path (cancel path when
   * `isCancelRequested` is true).
   */
  holdAt?: (stepName: string) => Promise<void>;
}

/**
 * Build a workflow clone whose handler runs a scripted sequence of beats
 * against the real kernel `ctx` (real `ctx.step` / `markStep` / `updateData`
 * emissions, real tracker JSONL). The cloned workflow keeps the original
 * `name` so the dashboard projection + runtime-policy lookups behave
 * identically to production.
 */
export function cloneWithScript<TData, TSteps extends readonly string[]>(
  workflow: RegisteredWorkflow<TData, TSteps>,
  beats: ScenarioBeat[],
  hooks: ScriptHooks = {},
): RegisteredWorkflow<TData, TSteps> {
  return {
    ...workflow,
    config: {
      ...workflow.config,
      handler: async (ctx) => {
        for (const beat of beats) {
          if (beat.kind === "markStep") {
            ctx.markStep(beat.name);
            hooks.onStepReached?.(beat.name);
          } else if (beat.kind === "step") {
            await ctx.step(beat.name, async () => {
              hooks.onStepReached?.(beat.name);
              if (beat.updateData) ctx.updateData(beat.updateData);
              if (beat.hold) await hooks.holdAt?.(beat.name);
              if (typeof beat.signalWaitMs === "number") {
                // Simulate a long AbortSignal-aware Playwright wait. If the
                // per-run controller aborts before the timeout fires, the
                // wait rejects immediately — mirroring how a real
                // page.waitForSelector with options.signal would behave
                // when our Page proxy injects ctx.signal.
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, beat.signalWaitMs);
                  if (ctx.signal.aborted) {
                    clearTimeout(timer);
                    reject(new Error("aborted"));
                    return;
                  }
                  ctx.signal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new Error("aborted"));
                  }, { once: true });
                });
              }
              if (beat.throw) throw beat.throw;
            });
          } else {
            ctx.updateData(beat.data);
          }
        }
      },
    },
  };
}
