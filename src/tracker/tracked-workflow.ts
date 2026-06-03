import { appendFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { randomUUID } from "node:crypto";

import { log } from "../utils/log.js";
import { setLogRunId } from "../utils/log-context.js";
import { classifyError } from "../utils/errors.js";
import { applySigintTerminalToProjection } from "./state/runtime.js";
import {
  generateInstanceName,
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitBrowserClose,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
  emitItemStart,
  emitItemComplete,
  emitStepChange,
} from "./session-events.js";
import { findLatestEntryForPredicate } from "./find-latest-entry.js";
import { rowFilePath } from "./paths.js";
import {
  DEFAULT_DIR,
  emitTrackerRow,
  getLogsJsonlPathForDate,
  serializeValue,
  toTypedValue,
  trackerDateForTimestamp,
  type LogEntry,
  type StampedData,
  type TrackerEntry,
  type TypedValue,
} from "./jsonl-io.js";
import type { RowArchetype } from "../domain/row-archetype.js";

/** Session context passed to workflow callbacks for registering sessions/browsers. */
export interface SessionContext {
  /** Auto-generated instance name, e.g. "Separation 1" */
  instance: string;
  registerSession(sessionId: string): void;
  registerBrowser(sessionId: string, browserId: string, system: string): void;
  closeBrowser(browserId: string, system: string): void;
  setAuthState(browserId: string, system: string, state: "start" | "complete" | "failed"): void;
  setCurrentItem(itemId: string): void;
  completeItem(itemId: string): void;
}

/**
 * Wrap a workflow function with automatic lifecycle tracking.
 *
 * Emits: pending (on start) → running/step (via setStep) → done (on success) | failed (on throw).
 * Call `updateData()` to enrich the entry with data discovered during execution (e.g. employee name).
 *
 * `updateData` accepts `Record<string, unknown>`; each value is stringified at the write
 * boundary via `serializeValue` (Date → ISO, object → JSON). The on-disk `TrackerEntry.data`
 * remains `Record<string, string>`.
 */
/**
 * All non-required arguments to `withTrackedWorkflow`. Includes both the
 * pre-existing richness hooks (declaredDetailFields, nameFn, idFn — the kernel
 * passes these via `buildTrackerOpts`) AND the previously-positional batch /
 * test-isolation knobs (initialData, preAssignedRunId, dir).
 *
 * Legacy callers omit any field they don't need — the runtime warning never
 * fires when `declaredDetailFields` is absent, and `getName`/`getId` aren't
 * computed when `nameFn`/`idFn` are absent, preserving pre-subsystem-D
 * behavior exactly.
 */
export interface WithTrackedWorkflowOpts {
  /**
   * Declared detailFields keys from `defineWorkflow`. If provided, the wrapper
   * logs `log.warn` for any key never populated via `updateData` before the
   * `done` emit. Non-fatal — only a warning.
   */
  declaredDetailFields?: readonly string[];
  /**
   * Server-side name computation. Result is stored as `data.__name`.
   */
  nameFn?: (data: Record<string, string>) => string;
  /**
   * Server-side id computation. Result is stored as `data.__id`.
   */
  idFn?: (data: Record<string, string>) => string;
  /** Seed data — merged into the entry before the first emit. Default `{}`. */
  initialData?: Record<string, string>;
  /** Pre-assigned runId (batch mode) — skips run computation and initial pending emit. */
  preAssignedRunId?: string;
  /**
   * Pool-/batch-assigned workflow instance name. When provided, the wrapper
   * REUSES this name instead of calling `generateInstanceName` and SKIPS the
   * `emitWorkflowStart` / `emitWorkflowEnd` calls on every code path
   * (success, error, SIGINT/SIGTERM). The batch runner that owns the
   * lifecycle (e.g. `withBatchLifecycle`) is responsible for both emits,
   * ensuring the dashboard sees ONE session-panel row per batch regardless
   * of item count. `data.instance` on tracker rows still gets stamped so the
   * dashboard's `EntryItem` still renders an instance chip per row.
   */
  preAssignedInstance?: string;
  /**
   * Original validated input the run was invoked with. Stamped onto the
   * initial `pending` tracker row only. Used by the dashboard's retry / edit-
   * and-resume features to reconstruct the input verbatim. Optional — when
   * absent, the pending row is written without the `input` field.
   */
  input?: Record<string, unknown>;
  /** Override tracker directory — defaults to DEFAULT_DIR (`.tracker`). Mainly for test isolation. */
  dir?: string;
  /**
   * When set, every TrackerEntry emitted by this run carries `parentRunId`.
   * Used by delegated child workflows (e.g. sharepoint-download spawned by
   * the OCR orchestrator) so the dashboard can render parent→child pills.
   */
  parentRunId?: string;
  /**
   * Canonical row archetype. Stamped into `data.archetype` on every emit so
   * queue-surface, log-panel, and display-name classifiers can dispatch on a
   * single field instead of the legacy seven-discriminator sprawl.
   */
  archetype?: import("../domain/row-archetype.js").RowArchetype;
}

export async function withTrackedWorkflow<T>(
  workflow: string,
  id: string,
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /** Register a sync cleanup function (e.g. kill browsers) that runs on SIGINT before exit. */
    onCleanup: (cb: () => void) => void,
    session: SessionContext,
    /**
     * Emit a proper step-failed signal. Routes to the same underlying emission
     * path as Stepper's emitFailed: writes a `running` entry whose step encodes
     * the failure, then the outer `catch` block writes the terminal `failed`
     * entry. Use this instead of encoding failure info into a mangled step name.
     */
    emitFailed: (step: string, error: string) => void,
    /**
     * The tracker-stamped runId for this invocation — either the caller's
     * `preAssignedRunId` or the auto-generated `{id}#N` value. Callers that
     * build a Stepper / screenshot emitter inside the body should thread this
     * in so their emitted events correlate 1:1 with the JSONL rows. Without
     * this, the body would generate its own runId for Stepper while the
     * tracker stamps a different one on its rows (prior bug fixed 2026-04-23).
     */
    runId: string,
    /**
     * Emit a "this step was bypassed" signal — writes a `skipped` tracker
     * row that the dashboard's StepPipeline can render distinctly from
     * `done`. Use for edit-and-resume style flows where extracted data was
     * pre-populated and the extraction step is intentionally not executed.
     * The bypassed step name still becomes `currentStep` so subsequent
     * step transitions advance the pipeline correctly.
     */
    emitSkipped: (step: string) => void,
  ) => Promise<T>,
  opts: WithTrackedWorkflowOpts = {},
): Promise<T> {
  const initialData = opts.initialData ?? {};
  const preAssignedRunId = opts.preAssignedRunId;
  const dir = opts.dir ?? DEFAULT_DIR;
  // Default archetype to "single" so the StampedData contract is always
  // satisfied. Real kernel call paths pass `opts.archetype` from
  // `deriveRowArchetype(wf.archetype, parentRunId)`; tests that bypass the
  // kernel get a "single" stamp which matches their workflow shape.
  const stampedArchetype: RowArchetype = opts.archetype ?? "single";
  const data: Record<string, string> = { ...initialData, archetype: stampedArchetype };
  const typedData: Record<string, TypedValue> = {};
  const ts = () => new Date().toISOString();
  let lastEmittedTrackerDate: string | undefined;

  let runId: string;
  if (preAssignedRunId) {
    runId = preAssignedRunId;
  } else {
    runId = `${id}#${randomUUID().slice(0, 8)}`;
  }
  setLogRunId(runId);

  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    // Apply server-side getName/getId before each emit so the dashboard sees
    // the freshest computed display values. Functions receive the current
    // stringified data snapshot and mutate __name / __id back into it.
    if (opts.nameFn) {
      try { data.__name = opts.nameFn(data); } catch { /* non-fatal */ }
    }
    if (opts.idFn) {
      try { data.__id = opts.idFn(data); } catch { /* non-fatal */ }
    }
    const timestamp = ts();
    // Re-stamp archetype on every emit so that even if a handler clears it
    // via updateData (it shouldn't, but defensive), the StampedData
    // invariant for emitTrackerRow holds.
    const stampedData: StampedData = { ...data, archetype: stampedArchetype };
    emitTrackerRow(
      {
        workflow,
        timestamp,
        id,
        runId,
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        status,
        data: stampedData,
        ...(Object.keys(typedData).length > 0 ? { typedData } : {}),
        // `input` rides ONLY on the initial pending row (see TrackerEntry doc).
        ...(status === "pending" && opts.input ? { input: opts.input } : {}),
        ...extra,
      },
      dir,
    );
    lastEmittedTrackerDate = trackerDateForTimestamp(timestamp);
  };

  if (!preAssignedRunId) emit("pending");

  // Session tracking context. All session-event emits route to the same `dir`
  // as the tracker writes — without this, tests passing `trackerDir: TMP_DIR`
  // for entry/log isolation would still leak workflow_start/step_change/etc.
  // into the real `.tracker/` session files and clutter the operator's
  // session drawer with dead test workflow instances.
  const instanceName = opts.preAssignedInstance ?? generateInstanceName(workflow, dir);
  if (!opts.preAssignedInstance) emitWorkflowStart(instanceName, dir);
  // Store instance name in tracker data so EntryItem can show it
  data.instance = instanceName;

  const session: SessionContext = {
    instance: instanceName,
    registerSession: (sessionId) => emitSessionCreate(instanceName, sessionId, dir),
    registerBrowser: (sessionId, browserId, system) => emitBrowserLaunch(instanceName, sessionId, browserId, system, dir),
    closeBrowser: (browserId, system) => emitBrowserClose(instanceName, browserId, system, dir),
    setAuthState: (browserId, system, state) => {
      if (state === "start") emitAuthStart(instanceName, browserId, system, dir);
      else if (state === "complete") emitAuthComplete(instanceName, browserId, system, dir);
      else emitAuthFailed(instanceName, browserId, system, dir);
    },
    setCurrentItem: (itemId) => emitItemStart(instanceName, itemId, dir),
    completeItem: (itemId) => emitItemComplete(instanceName, itemId, dir),
  };

  // Cleanup callbacks registered by the workflow (e.g. kill browsers)
  const cleanupFns: (() => void)[] = [];

  // Track the last `running` step so terminal `failed` emits (SIGINT, error
  // rethrow) can preserve it. Without this the dashboard's RunSelector
  // shows "interrupted" (or falls back to step 0) for any run killed mid-
  // step, even though we knew exactly which step was in flight.
  let lastStep: string | undefined;

  // Catch Ctrl+C / kill — write synchronously (bypass async mutex) since process.exit follows
  let cleaned = false;
  const onSignal = (signal: string) => {
    if (cleaned) return;
    cleaned = true;
    // Kill all Playwright-launched Chrome processes (Windows-safe)
    if (process.platform === "win32") {
      try {
        execSync('wmic process where "name=\'chrome.exe\' and CommandLine like \'%--enable-automation%\'" call terminate', { stdio: "ignore" });
      } catch { /* best-effort */ }
    }
    for (const cb of cleanupFns) { try { cb(); } catch { /* best-effort */ } }
    // Skip the end-emit when a batch runner owns the lifecycle — it writes
    // its own `workflow_end(failed)` in its SIGINT path so the orphan-start
    // heal in generateInstanceName doesn't need to kick in.
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "failed", dir);
    const error = `Process terminated (${signal})`;
    const now = ts();
    const date = lastEmittedTrackerDate ?? findLatestTrackerDateForRun(workflow, id, runId, dir) ?? trackerDateForTimestamp(now);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logEntry: LogEntry = { workflow, itemId: id, runId, level: "error", message: error, ts: now };
    // SIGINT path runs synchronously and bypasses emitTrackerRow, but `data`
    // always carries `archetype` (seeded at the top of withTrackedWorkflow)
    // so the row written here still satisfies the stamping contract.
    const trackEntry: TrackerEntry = {
      workflow,
      timestamp: now,
      id,
      runId,
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      status: "failed",
      data: { ...data, archetype: stampedArchetype },
      error,
      ...(lastStep ? { step: lastStep } : {}),
    };
    const trackerPath = rowFilePath(workflow, date, dir);
    const logPath = getLogsJsonlPathForDate(workflow, dir, date);
    appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
    appendFileSync(trackerPath, JSON.stringify(trackEntry) + "\n");
    // JSONL is written; now mirror the same terminal state into the SQLite
    // projection so a live dashboard doesn't show the killed run stuck
    // "running" forever. `node:sqlite` is synchronous, so this is safe inside
    // the signal handler. JSONL-first, SQLite-second, SQLite failure swallowed
    // locally — the startup rebuild is the backstop.
    applySigintTerminalToProjection(
      trackEntry,
      logEntry,
      { trackerPath, logPath, trackerDate: date },
      dir,
    );
  };
  const onSigint = (): void => { onSignal("SIGINT"); process.exit(130); };
  const onSigterm = (): void => { onSignal("SIGTERM"); process.exit(143); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // Real emitFailed: sets lastStep (preserves step in terminal failed entry)
  // then emits a running row with a `step:failed:<error>` step string that the
  // StepPipeline uses to show the failed dot. The outer catch block then writes
  // the terminal `failed` entry, so the sequence is:
  //   running(step:failed:…) → [rethrow] → failed(step=lastStep)
  const emitFailedFn = (step: string, error: string) => {
    const encoded = `${step}:failed:${error}`
    lastStep = step
    emit("running", { step: encoded })
    emitStepChange(instanceName, encoded, dir, workflow)
  }

  // emitSkipped: announce a bypassed step. Writes a single `skipped` tracker
  // row with the step name. Updates lastStep so a later terminal failure
  // attributes correctly. No corresponding emitStepChange — the dashboard
  // session drawer "current step" tracking treats skipped as a no-op
  // advance for live state (the session-events stream covers running steps).
  const emitSkippedFn = (step: string) => {
    lastStep = step
    emit("skipped", { step })
  }

  try {
    const result = await fn(
      (step) => { lastStep = step; emit("running", { step }); emitStepChange(instanceName, step, dir, workflow); },
      (d) => {
        // Stringify rich values at the write boundary — data stays Record<string, string>
        // on disk, but callers can pass Date/object/etc. without losing fidelity.
        // Also populate the typedData mirror so the dashboard can render
        // dates/numbers/booleans with type-aware formatting.
        for (const [k, v] of Object.entries(d)) {
          data[k] = serializeValue(v, k);
          typedData[k] = toTypedValue(v);
        }
      },
      (cb) => cleanupFns.push(cb),
      session,
      emitFailedFn,
      runId,
      emitSkippedFn,
    );

    // Runtime warning (Option A) — any declared detailField key that the
    // workflow never populated is surfaced as a log.warn so drift is audible
    // without being fatal. Only runs on the success path; failed runs often
    // short-circuit before populating everything.
    if (opts.declaredDetailFields) {
      for (const key of opts.declaredDetailFields) {
        if (!(key in data)) {
          log.warn(`dashboard: detailField '${key}' was declared but never populated`);
        }
      }
    }

    emit("done");
    // Run-scope `run:terminal` event (outcome=completed). The Tier-1 harness
    // `waitForEvent("run:terminal", { runId })` to await deterministic run
    // completion. Run-scope log → logs/<workflow>-<date>.jsonl; see
    // docs/engineering/structured-log-events.md.
    log.success({
      message: "Run complete",
      event: "run:terminal",
      occasion: "completed",
      ...(lastStep ? { step: lastStep } : {}),
    });
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "done", dir);
    return result;
  } catch (e) {
    const error = classifyError(e);
    const cancelled = e instanceof Error && e.name === "CancelledError";
    // Annotate the existing terminal log line with `run:terminal` (outcome =
    // cancelled|failed) so the harness can await ANY terminal outcome on one
    // event name + branch on `occasion`.
    if (cancelled) {
      log.warn({ message: error, event: "run:terminal", occasion: "cancelled", ...(lastStep ? { step: lastStep } : {}) });
    } else {
      log.error({ message: error, event: "run:terminal", occasion: "failed", ...(lastStep ? { step: lastStep } : {}) });
    }
    emit("failed", { error, ...(lastStep ? { step: lastStep } : {}) });
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "failed", dir);
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function findLatestTrackerDateForRun(
  workflow: string,
  itemId: string,
  runId: string,
  dir: string = DEFAULT_DIR,
): string | undefined {
  // Resolve the most-recent JSONL line for this (itemId, runId) via the
  // canonical newest-first walker, then derive its calendar date. Only used
  // as a SIGINT-path fallback when `lastEmittedTrackerDate` is unset, so the
  // 7-day default lookback comfortably covers any in-flight run.
  const ts = findLatestEntryForPredicate({
    workflow,
    trackerDir: dir,
    predicate: (entry) => entry.id === itemId && entry.runId === runId,
  })?.timestamp;
  return ts ? trackerDateForTimestamp(ts) : undefined;
}
