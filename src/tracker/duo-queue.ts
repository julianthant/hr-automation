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

  await waitForDuoTurn(requestId, options.instance, options.system);

  log.step(`[Duo Queue] Active: ${options.system} for ${options.instance}`);
  emitSessionEvent({
    type: "duo_start",
    workflowInstance: options.instance,
    system: options.system,
    duoRequestId: requestId,
  });

  try {
    return await pollDuoApproval(page, options);
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
  instance: string,
  system: string,
): Promise<void> {
  let logged = false;
  while (true) {
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

    await new Promise((r) => setTimeout(r, 500));
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
