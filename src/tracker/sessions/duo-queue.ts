import type { Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { pollDuoApproval, type DuoPollOptions } from "../../infra/auth/duo-poll.js";
import { finishDuoWebAuthn } from "../../infra/auth/duo-webauthn.js";
import { emitSessionEvent, readSessionEvents } from "../session-events.js";
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

async function waitForDuoTurn(
  requestId: string,
  _instance: string,
  _system: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  let logged = false;
  while (true) {
    throwIfDuoQueueAborted(abortSignal);
    const events = readSessionEvents();
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

    if (firstUnresolved && !isProcessAlive(firstUnresolved.pid)) {
      log.step(
        `[Duo Queue] Stale request detected (PID ${firstUnresolved.pid} dead) — advancing queue`,
      );
      emitSessionEvent({
        type: "duo_timeout",
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

    await waitForDuoQueue(500, abortSignal);
  }
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
