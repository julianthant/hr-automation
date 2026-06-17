import type { Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { pollDuoApproval, type DuoPollOptions } from "../../infra/auth/duo-poll.js";
import { finishDuoWebAuthn } from "../../infra/auth/duo-webauthn.js";
import { emitSessionEvent, readSessionEvents, type SessionEvent } from "../session-events.js";
import { log } from "../../utils/log.js";

/** Options for requestDuoApproval — extends DuoPollOptions with queue metadata. */
export interface DuoQueueOptions extends DuoPollOptions {
  system: string;
  instance: string;
}

export async function requestDuoApproval(
  page: Page,
  options: DuoQueueOptions,
): Promise<boolean> {
  const requestId = `${options.instance}-${options.system}-${Date.now()}`;

  log.step(`[Duo Queue] Enqueuing: ${options.system} for ${options.instance}`);
  emitSessionEvent({
    type: "duo_request",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  try {
    await waitForDuoTurn(requestId, options.instance, options.system, options.abortSignal);
  } catch (err) {
    // The authenticator is armed at `clickSsoSubmit`, BEFORE this queue wait.
    // If the wait aborts (daemon stop) we'd otherwise leave that virtual
    // authenticator armed without persisting its signCount — desyncing Duo for
    // the next assertion. Finalize it cleanly before propagating the abort
    // (idempotent / no-op when WebAuthn isn't in play).
    await finishDuoWebAuthn(page);
    throw err;
  }

  log.step(`[Duo Queue] Active: ${options.system} for ${options.instance}`);
  emitSessionEvent({
    type: "duo_start",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  try {
    // Pass the queue's system label + instance through so duo-poll.ts's
    // voice-cue hook (HR_AUTOMATION_VOICE_CUES=1) says "Duo for <system>"
    // when polling starts. Plain `pollDuoApproval` falls back to "system" /
    // workflow-name when unset — direct callers (non-queued) keep working
    // without change.
    return await pollDuoApproval(page, {
      ...options,
      systemLabel: options.system,
      instance: options.instance,
    });
  } finally {
    log.step(`[Duo Queue] Complete: ${options.system} for ${options.instance}`);
    emitSessionEvent({
      type: "duo_complete",
      workflowInstance: options.instance,
      system: options.system,
      duoRequestId: requestId,
    });
  }
}

/** Poll interval for the serial Duo queue. */
const DUO_QUEUE_POLL_MS = 500;

/**
 * Wall-clock cap on how long a single worker will sit in the queue waiting for
 * its turn. If a worker can't reach the head of the queue within this window it
 * fails fast (and the kernel retries) rather than blocking one of N parallel
 * workers forever. Chosen well above one full manual Duo cycle (180s UCPath
 * timeout) so a healthy in-progress prompt ahead of us is never cut off.
 */
export const DUO_QUEUE_MAX_WAIT_MS = 300_000;

/**
 * Age (since the request's own event timestamp) past which a STILL-RUNNING (PID
 * alive) head-of-queue request is treated as stalled and timed out so the queue
 * advances. Set just above the longest manual Duo timeout (180s UCPath) so a
 * normally-progressing prompt is never preempted — only a wedged one (e.g. a
 * worker mid-`page.reload()` that never recovers, or a hung WebAuthn ceremony)
 * trips it. The PID-dead advance below stays as the fast path; this covers the
 * "alive but stuck" case the PID check can't see.
 */
export const DUO_QUEUE_STALE_REQUEST_MS = 200_000;

function eventAgeMs(timestamp: string | undefined, now: number): number {
  if (!timestamp) return 0;
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return 0;
  return now - ts;
}

/**
 * Injectable seams for the queue-turn loop. Production wires these to the real
 * session-event reader/emitter, `node:timers/promises` sleep, the process clock,
 * and `process.kill(pid, 0)`. Tests inject deterministic doubles so the
 * max-wait / stale-advance thresholds can be exercised without real time.
 */
export interface DuoQueueTurnDeps {
  readEvents: () => SessionEvent[];
  emitTimeout: (e: { workflowInstance: string; system: string; duoRequestId: string }) => void;
  isAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

const defaultDuoQueueTurnDeps: DuoQueueTurnDeps = {
  readEvents: () => readSessionEvents(),
  emitTimeout: (e) => emitSessionEvent({ type: "duo_timeout", ...e }),
  isAlive: isProcessAlive,
  now: () => Date.now(),
  sleep: (ms, abortSignal) => waitForDuoQueue(ms, abortSignal),
};

/**
 * Core of the serial-Duo-queue wait, factored out so the timeout/stale-advance
 * logic is unit-testable without real time or a real `.tracker/`. Resolves when
 * `requestId` reaches the head of the queue. Advances past a head-of-queue
 * request that is either dead (PID) or wedged (alive but older than
 * `DUO_QUEUE_STALE_REQUEST_MS`), and throws if this worker has waited longer
 * than `DUO_QUEUE_MAX_WAIT_MS` (fail-fast so one stuck worker can't block the
 * pool — the run retries instead).
 */
export async function runDuoQueueTurn(
  requestId: string,
  abortSignal: AbortSignal | undefined,
  deps: DuoQueueTurnDeps = defaultDuoQueueTurnDeps,
): Promise<void> {
  let logged = false;
  const waitStartedAt = deps.now();
  while (true) {
    throwIfDuoQueueAborted(abortSignal);

    // Fail fast rather than block a parallel worker indefinitely: if one
    // stalled worker ahead of us never resolves, we'd otherwise wait forever.
    if (deps.now() - waitStartedAt >= DUO_QUEUE_MAX_WAIT_MS) {
      throw new Error(
        `[Duo Queue] Timed out after ${Math.round(DUO_QUEUE_MAX_WAIT_MS / 1000)}s waiting for a Duo turn — a worker ahead in the queue is stuck; failing fast so this run can retry.`,
      );
    }

    const events = deps.readEvents();
    const duoEvents = events.filter(
      (e) => e.type === "duo_request" || e.type === "duo_complete" || e.type === "duo_timeout",
    );

    const resolved = new Set(
      duoEvents
        .filter((e) => e.type === "duo_complete" || e.type === "duo_timeout")
        .map((e) => e.duoRequestId),
    );

    const firstUnresolved = duoEvents
      .filter((e) => e.type === "duo_request" && !resolved.has(e.duoRequestId))
      .at(0);

    if (firstUnresolved?.duoRequestId === requestId) {
      return;
    }

    if (firstUnresolved && !deps.isAlive(firstUnresolved.pid)) {
      log.step(
        `[Duo Queue] Stale request detected (PID ${firstUnresolved.pid} dead) — advancing queue`,
      );
      deps.emitTimeout({
        workflowInstance: firstUnresolved.workflowInstance ?? "",
        system: firstUnresolved.system ?? "",
        duoRequestId: firstUnresolved.duoRequestId ?? "",
      });
      continue;
    }

    // Time-based stale advance: a request whose PID is still alive but which has
    // sat at the head of the queue longer than DUO_QUEUE_STALE_REQUEST_MS is
    // wedged (its own Duo poll has long since timed out). Time it out from the
    // request's own event timestamp — it may belong to another process, so its
    // age cannot be derived from this worker's local clock-since-wait-start.
    if (
      firstUnresolved &&
      eventAgeMs(firstUnresolved.timestamp, deps.now()) >= DUO_QUEUE_STALE_REQUEST_MS
    ) {
      log.step(
        `[Duo Queue] Stale request detected (PID ${firstUnresolved.pid} alive but request older than ${Math.round(DUO_QUEUE_STALE_REQUEST_MS / 1000)}s) — advancing queue`,
      );
      deps.emitTimeout({
        workflowInstance: firstUnresolved.workflowInstance ?? "",
        system: firstUnresolved.system ?? "",
        duoRequestId: firstUnresolved.duoRequestId ?? "",
      });
      continue;
    }

    if (!logged) {
      log.waiting(
        `[Duo Queue] Waiting — ${firstUnresolved?.system} (${firstUnresolved?.workflowInstance}) is using Duo`,
      );
      logged = true;
    }

    await deps.sleep(DUO_QUEUE_POLL_MS, abortSignal);
  }
}

async function waitForDuoTurn(
  requestId: string,
  _instance: string,
  _system: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  await runDuoQueueTurn(requestId, abortSignal);
}

function duoQueueAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(reason ? String(reason) : "Duo queue wait aborted");
}

function throwIfDuoQueueAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw duoQueueAbortReason(signal);
}

async function waitForDuoQueue(ms: number, abortSignal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw duoQueueAbortReason(abortSignal);
    throw err;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
