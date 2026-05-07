import type { Page } from "playwright";
import { pollDuoApproval, type DuoPollOptions } from "../auth/duo-poll.js";
import { emitSessionEvent, readSessionEvents } from "./session-events.js";
import { log } from "../utils/log.js";

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

  await waitForDuoTurn(requestId, options.instance, options.system, options.abortSignal);

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
    // when polling starts, AND so the `telegram_sent` session event
    // emitted by the Telegram notifier records the real workflow instance
    // label (e.g. "Oath Signature 1") in `workflowInstance`. Plain
    // `pollDuoApproval` falls back to "system" / workflow-name when unset
    // — direct callers (non-queued) keep working without change.
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

function waitForDuoQueue(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return new Promise((r) => setTimeout(r, ms));
  if (abortSignal.aborted) return Promise.reject(duoQueueAbortReason(abortSignal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(duoQueueAbortReason(abortSignal));
    };
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
