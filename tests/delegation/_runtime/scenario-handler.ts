import { z } from "zod";
import { defineWorkflow } from "../../../src/core/kernel/workflow.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../../src/domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../../src/domain/workflow-runtime/types.js";
import type { OperatorSubjectKind } from "../../../src/domain/operator-subject.js";
import type { Ctx, RegisteredWorkflow } from "../../../src/core/kernel/types.js";

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
  | { kind: "skipStep"; name: string }
  | {
      kind: "step";
      name: string;
      /** When true, the step body awaits the runtime's `holdAt` hook before returning. */
      hold?: boolean;
      /**
       * Simulate a long AbortSignal-aware wait (e.g. `page.waitForSelector`)
       * inside the step body. The body awaits a setTimeout for `signalWaitMs`
       * ms, but subscribes to `ctx.signal` so an operator cancel rejects the
       * wait within a few ms instead of running the full timeout.
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
   * This means `await rt.waitForEvent("step:start", { step })` is safe to
   * snapshot immediately afterward — the row is on disk.
   */
  onStepReached?: (stepName: string) => void;
  /**
   * Called when a `step` beat with `hold: true` is awaiting release. Returning
   * a promise lets the runtime pause the step body until the test signals
   * release (or cancel). A reject from this hook throws inside `ctx.step`,
   * triggering the kernel's step-failed path (cancel path when the per-run
   * signal is aborted).
   */
  holdAt?: (stepName: string) => Promise<void>;
}

/**
 * Optional override that completely replaces the scripted-beats handler
 * body with arbitrary test-supplied code. Use when a scenario needs to
 * call real kernel primitives that the beat vocabulary doesn't cover
 * (e.g. `ctx.delegateTo`, `ctx.delegateToAll`). The hooks (`onStepReached`,
 * `holdAt`) are still wired through so event/hold-release remain available.
 */
export type CustomScenarioHandler<TData, TSteps extends readonly string[]> =
  (args: {
    ctx: Ctx<TSteps, TData>;
    input: TData;
    hooks: ScriptHooks;
  }) => Promise<void>;

/**
 * Build a workflow clone whose handler runs a scripted sequence of beats
 * against the real kernel `ctx`. The cloned workflow keeps the original
 * `name` so the dashboard projection + runtime-policy lookups behave
 * identically to production.
 *
 * Kept for back-compat with the salvaged runtime; the daemon harness
 * (`createDelegationRuntime`) prefers `makeGatedWorkflow` below.
 */
export function cloneWithScript<TData, TSteps extends readonly string[]>(
  workflow: RegisteredWorkflow<TData, TSteps>,
  beats: ScenarioBeat[],
  hooks: ScriptHooks = {},
  customHandler?: CustomScenarioHandler<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  return {
    ...workflow,
    config: {
      ...workflow.config,
      handler: async (ctx, input) => {
        if (customHandler) {
          await customHandler({
            ctx: ctx as Ctx<TSteps, TData>,
            input,
            hooks,
          });
          return;
        }
        await runBeats(ctx as Ctx<readonly string[], unknown>, beats, hooks);
      },
    },
  };
}

/**
 * Interpret a list of scripted beats against a real kernel `ctx`. Shared by
 * `cloneWithScript` and `makeGatedWorkflow`.
 */
export async function runBeats(
  ctx: Ctx<readonly string[], unknown>,
  beats: ScenarioBeat[],
  hooks: ScriptHooks = {},
): Promise<void> {
  for (const beat of beats) {
    if (beat.kind === "markStep") {
      ctx.markStep(beat.name);
      hooks.onStepReached?.(beat.name);
    } else if (beat.kind === "skipStep") {
      ctx.skipStep(beat.name);
      hooks.onStepReached?.(beat.name);
    } else if (beat.kind === "step") {
      await ctx.step(beat.name, async () => {
        hooks.onStepReached?.(beat.name);
        if (beat.updateData) {
          ctx.updateData(beat.updateData);
        }
        if (beat.hold) await hooks.holdAt?.(beat.name);
        if (typeof beat.signalWaitMs === "number") {
          await waitWithSignal(beat.signalWaitMs, ctx.signal);
        }
        if (beat.throw) throw beat.throw;
      });
    } else {
      ctx.updateData(beat.data);
    }
  }
}

/**
 * Await `ms` but reject immediately if `signal` aborts first — models a real
 * `page.waitForSelector(..., { signal })` so an operator cancel rejects the
 * wait inside a few ms instead of running the full timeout.
 */
export function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// ─── Gated stub workflows (daemon harness) ──────────────────────────────────

/**
 * A `GateCoordinator` is the shared latch registry that the daemon-driven
 * harness installs and a gated stub workflow's handler reads. Because the
 * harness runs the real daemon IN-PROCESS (same module instance), the handler
 * closure can reach the coordinator directly — no cross-process channel needed.
 *
 * Keyed by `(runId, stage)`: when a handler reaches a held stage it
 * `await`s `hold(runId, stage)`, which the test releases via `release(runId,
 * stage)` or which rejects when the run's `ctx.signal` aborts (cancel path).
 */
export interface GateCoordinator {
  /**
   * Called by the handler when it reaches a held stage. Resolves when the test
   * calls `release` for this exact `(runId, stage)`, or rejects when `signal`
   * aborts (so the held step throws → the kernel maps it to a cancelled
   * terminal row).
   */
  hold(runId: string, stage: string, signal: AbortSignal): Promise<void>;
  /** Release a specific held stage for one run. */
  release(runId: string, stage: string): void;
  /** Register a default release predicate so `holdAll(workflow, stage)` works. */
  shouldHold(workflow: string, runId: string, stage: string): boolean;
}

/**
 * Build a `GateCoordinator` backed by in-memory latch maps. One per runtime.
 */
export function createGateCoordinator(): GateCoordinator & {
  /** Mark every run of `workflow` reaching `stage` as held until released. */
  holdAll(workflow: string, stage: string): void;
} {
  // Latch resolvers keyed by `${runId} ${stage}` — set when a handler is
  // parked at a stage, consumed by `release` or signal-abort.
  const resolvers = new Map<string, () => void>();
  // `holdAll` registrations keyed by `${workflow} ${stage}`.
  const holdAllStages = new Set<string>();

  const key = (runId: string, stage: string): string => `${runId} ${stage}`;
  const wfKey = (workflow: string, stage: string): string => `${workflow} ${stage}`;

  const shouldHold = (workflow: string, _runId: string, stage: string): boolean =>
    holdAllStages.has(wfKey(workflow, stage));

  const hold = (runId: string, stage: string, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled before hold"));
        return;
      }
      resolvers.set(key(runId, stage), resolve);
      signal.addEventListener(
        "abort",
        () => {
          resolvers.delete(key(runId, stage));
          reject(new Error(`cancelled during hold(${stage})`));
        },
        { once: true },
      );
    });

  const release = (runId: string, stage: string): void => {
    const resolve = resolvers.get(key(runId, stage));
    if (resolve) {
      resolvers.delete(key(runId, stage));
      resolve();
    }
  };

  const holdAll = (workflow: string, stage: string): void => {
    holdAllStages.add(wfKey(workflow, stage));
  };

  return { hold, release, shouldHold, holdAll };
}

export interface GatedWorkflowSpec {
  /** Workflow name (must be unique in the registry). */
  name: string;
  /** 2-char trace/daemon code (defaults to first two chars of `name`). */
  code?: string;
  /** Ordered stage names the handler walks through via `ctx.step`. */
  stages: readonly string[];
  /**
   * Which stages are gated (the handler parks at them until released/cancelled)
   * when the coordinator's `holdAll(workflow, stage)` is active for the run.
   * Defaults to the LAST stage (the common "park before terminal" shape).
   */
  gatedStages?: readonly string[];
  /** Row archetype — `single` (default) or `operation`. */
  archetype?: "single" | "operation";
  /** Input subject — drives `queueRowKind`. Defaults to `name` (person). */
  inputSubject?: "name" | "eid" | "email" | "kualiId" | "pdf" | "selector";
  /**
   * Override the runtime policy. Defaults to `DEFAULT_WORKFLOW_RUNTIME_POLICY`.
   * Pass a real workflow's policy (e.g. oath-signature's
   * `delegation.alwaysOperationDelegatedMembers: true`) when the stub must mirror
   * production grouping/surface behavior so the projection matches the truth.
   */
  runtimePolicy?: WorkflowRuntimePolicy;
  /** Dashboard label. Defaults to `name`. */
  label?: string;
  /**
   * Stamp operator-facing fields into the row's `data` (like a real workflow's
   * `initialData`). The oath-signature stub uses this to stamp `emplId` so the
   * person-kind subtitle resolves to the EID exactly as production does.
   */
  initialData?: (input: GatedInput) => Record<string, string | undefined>;
  /** Resolve the row id from data. Defaults to `d.id`. */
  getId?: (d: Record<string, string>) => string;
  /** Resolve the row name from data. Defaults to `d.name`. */
  getName?: (d: Record<string, string>) => string;
  /** Item id from the enqueued input. Defaults to `input.id`. */
  deriveItemId?: (input: GatedInput) => string;
  /**
   * Operator subject. Defaults to a `person`-kind subject from `name`/`id`.
   * Pass an `eid`-kind subject (oath-signature) so `__subjectKind` matches
   * production and the title/subtitle dispatch is faithful.
   */
  operatorSubject?: (input: GatedInput) => { kind: OperatorSubjectKind; label: string };
}

/**
 * Input schema every gated stub workflow accepts: an opaque `id` plus an
 * optional `name` so person rows render a title. Extra keys are allowed so a
 * parent can stamp `__runtimeOptions` / delegation channels without the schema
 * rejecting them.
 */
export const GatedInputSchema = z
  .object({ id: z.string(), name: z.string().optional() })
  .passthrough();

export type GatedInput = z.infer<typeof GatedInputSchema>;

/**
 * Build a gated stub workflow registered via the REAL `defineWorkflow`. Its
 * handler walks `stages` through `ctx.step`; at a gated stage it parks on
 * `coordinator.hold(runId, stage, ctx.signal)` so the harness can hold/release
 * the run or cancel it (the held promise rejects on signal-abort, the stepper
 * remaps that to a cancelled terminal row). No browser, no real systems.
 */
export function makeGatedWorkflow(
  spec: GatedWorkflowSpec,
  coordinator: GateCoordinator,
): RegisteredWorkflow<GatedInput, readonly string[]> {
  const gated = new Set(spec.gatedStages ?? [spec.stages[spec.stages.length - 1]!]);
  return defineWorkflow({
    name: spec.name,
    ...(spec.code ? { code: spec.code } : {}),
    label: spec.label ?? spec.name,
    schema: GatedInputSchema,
    steps: [...spec.stages],
    systems: [],
    authSteps: false,
    archetype: spec.archetype ?? "single",
    inputSubject: spec.inputSubject ?? "name",
    runtimePolicy: spec.runtimePolicy ?? DEFAULT_WORKFLOW_RUNTIME_POLICY,
    ...(spec.initialData
      ? {
          initialData: (input: GatedInput) => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(spec.initialData!(input))) {
              if (v !== undefined) out[k] = v;
            }
            return out;
          },
        }
      : {}),
    getId: spec.getId ?? ((d: Record<string, string>) => d.id ?? ""),
    getName: spec.getName ?? ((d: Record<string, string>) => d.name ?? ""),
    deriveItemId: spec.deriveItemId ?? ((input) => input.id),
    operatorSubject:
      spec.operatorSubject ?? ((input) => ({ kind: "person", label: input.name ?? input.id })),
    handler: async (ctx) => {
      for (const stage of spec.stages) {
        await ctx.step(stage, async () => {
          if (gated.has(stage) && coordinator.shouldHold(spec.name, ctx.runId, stage)) {
            await coordinator.hold(ctx.runId, stage, ctx.signal);
          }
        });
      }
    },
  }) as unknown as RegisteredWorkflow<GatedInput, readonly string[]>;
}
