import { existsSync, rmSync } from "node:fs";
import { e2eGateHoldPath, e2eGateFailPath } from "../../tracker/paths.js";

/**
 * File-based hold gates for HRAUTO_E2E_STUBS scripted runs.
 *
 * The in-process delegation test harness coordinates holds through a shared
 * `GateCoordinator` object — impossible across processes. Dashboard-spawned
 * daemons are separate `tsx` subprocesses, so the e2e bridge uses gate FILES
 * under `<trackerDir>/e2e-gates/` instead:
 *
 *   <workflow>.hold           park every step of every run of the workflow
 *   <workflow>--<step>.hold   park only the named step
 *
 * A scripted handler polls until no applicable hold file exists, or rejects
 * when the run's `ctx.signal` aborts (operator cancel / daemon stop), letting
 * the kernel map the throw to its standard cancelled terminal row.
 */

const DEFAULT_POLL_MS = 150;

function resolveTrackerDir(trackerDir: string | undefined): string {
  // Mirrors `src/config.ts`: daemons receive HRAUTO_TRACKER_DIR from the
  // spawner; an explicit ctx.trackerDir wins when the kernel threads one.
  return trackerDir ?? process.env.HRAUTO_TRACKER_DIR ?? ".tracker";
}

/** True while a workflow-level or step-level hold file exists. */
export function isGateHeld(opts: {
  workflow: string;
  step: string;
  trackerDir?: string;
}): boolean {
  const dir = resolveTrackerDir(opts.trackerDir);
  return (
    existsSync(e2eGateHoldPath(opts.workflow, undefined, dir)) ||
    existsSync(e2eGateHoldPath(opts.workflow, opts.step, dir))
  );
}

/**
 * Error thrown by a scripted step when its fail gate is armed. A plain Error
 * (NOT a CancelledError) so the kernel stepper's catch runs `emitFailed` and
 * the daemon writes a terminal `failed` row (red badge + Retry button), the
 * organic-failure path the e2e retry test exercises.
 */
export class E2EScriptedFailError extends Error {
  constructor(workflow: string, step: string) {
    super(`[e2e-stubs] scripted fail gate fired for ${workflow} at step "${step}"`);
    this.name = "E2EScriptedFailError";
  }
}

/**
 * One-shot fail gate. Returns true (and DELETES the gate file) when a
 * `<workflow>--fail-at--<step>.fail` file exists, so the caller throws an
 * `E2EScriptedFailError` exactly once. Self-consuming: the driver arms the
 * file, the run fails at that step, and the Retry replay sees no gate → passes
 * — no manual cleanup between fail and retry. A non-existent file is the
 * common case (no fs delete attempted).
 */
export function consumeFailGate(opts: {
  workflow: string;
  step: string;
  trackerDir?: string;
}): boolean {
  const path = e2eGateFailPath(opts.workflow, opts.step, resolveTrackerDir(opts.trackerDir));
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort — if the unlink races the driver, the throw still fires once */
  }
  return true;
}

/**
 * Resolve once no hold file applies to `(workflow, step)`; reject as soon as
 * `signal` aborts. Polling — not fs.watch — because the gate dir may not exist
 * yet when the daemon starts and the driver creates/removes files from another
 * process.
 */
export function awaitGateRelease(opts: {
  workflow: string;
  step: string;
  trackerDir?: string;
  signal: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearInterval(timer);
      reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
    };
    if (opts.signal.aborted) {
      reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
      return;
    }
    const check = () => {
      if (!isGateHeld(opts)) {
        clearInterval(timer);
        opts.signal.removeEventListener("abort", abort);
        resolve();
      }
    };
    const timer = setInterval(check, pollMs);
    opts.signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

/**
 * Await `ms` but reject immediately when `signal` aborts — models a real
 * `page.waitForSelector(..., { signal })` so an operator cancel unwinds a
 * scripted step within milliseconds instead of running out the pause.
 */
export function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}
