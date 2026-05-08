import { styleText } from "node:util";
import { AsyncLocalStorage } from "async_hooks";
import { appendLogEntry, type LogEntry } from "../tracker/jsonl.js";
import type { StructuredLogEvent } from "../domain/log-events.js";

interface LogContext {
  workflow: string;
  itemId: string;
  runId?: string;
  dir?: string;
}

const logStore = new AsyncLocalStorage<LogContext>();

const DEBUG_ENABLED = process.env.DEBUG === "true" || process.env.DEBUG === "1";
// E2E-TEMP: Gate verbose E2E debug logs behind E2E_DEBUG=1 env. Branch-local
// scaffolding for dashboard/backend sync verification; not for master.
const E2E_DEBUG_ENABLED = process.env.E2E_DEBUG === "true" || process.env.E2E_DEBUG === "1";

type LogMessage = string | Omit<StructuredLogEvent, "level">;

function messageText(input: LogMessage): string {
  return typeof input === "string" ? input : input.message;
}

function structuredFields(input: LogMessage): Omit<StructuredLogEvent, "level" | "message"> {
  if (typeof input === "string") return {};
  const { message: _message, ...rest } = input;
  return rest;
}

function emit(
  level: LogEntry["level"],
  prefix: string,
  input: LogMessage,
  toStderr = false,
): void {
  const msg = messageText(input);
  const extra = structuredFields(input);
  if (toStderr) {
    console.error(prefix + " " + msg);
  } else {
    console.log(prefix + " " + msg);
  }

  const ctx = logStore.getStore();
  if (ctx) {
    appendLogEntry(
      {
        workflow: ctx.workflow,
        itemId: ctx.itemId,
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        level,
        message: msg,
        ...extra,
        ts: new Date().toISOString(),
      },
      ctx.dir,
    );
  }
}

function emitDebug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.log(styleText("gray", "\u00B7 " + msg));
  }
  const ctx = logStore.getStore();
  if (ctx) {
    appendLogEntry(
      {
        workflow: ctx.workflow,
        itemId: ctx.itemId,
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        level: "debug",
        message: msg,
        ts: new Date().toISOString(),
      },
      ctx.dir,
    );
  }
}

// E2E-TEMP: Verbose, no-op when E2E_DEBUG is unset. Stdout-only (does NOT
// write to JSONL \u2014 keeps tracker files clean during E2E reruns).
function emitE2e(category: string, payload: string | Record<string, unknown>): void {
  if (!E2E_DEBUG_ENABLED) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.sss
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  console.log(styleText("magenta", `[E2E][${ts}][${category}]`) + " " + body);
}

export const log = {
  step: (msg: LogMessage): void => emit("step", styleText("blue", "->"), msg),
  success: (msg: LogMessage): void => emit("success", styleText("green", "\u2713"), msg),
  waiting: (msg: LogMessage): void => emit("waiting", styleText("yellow", "\u231B"), msg),
  warn: (msg: LogMessage): void => emit("warn", styleText("yellow", "!"), msg),
  error: (msg: LogMessage): void => emit("error", styleText("red", "\u2717"), msg, true),
  debug: (msg: string): void => emitDebug(msg),
  // E2E-TEMP: log.e2e(category, payload) \u2014 no-op unless E2E_DEBUG=1.
  e2e: (category: string, payload: string | Record<string, unknown>): void =>
    emitE2e(category, payload),
};

/** Update the current log context with a runId (called from withTrackedWorkflow). */
export function setLogRunId(runId: string): void {
  const ctx = logStore.getStore();
  if (ctx) ctx.runId = runId;
}

/** Read the runId from the current AsyncLocalStorage log context, if set. */
export function getLogRunId(): string | undefined {
  return logStore.getStore()?.runId;
}

/** Read the workflow name from the current AsyncLocalStorage log context, if set. */
export function getLogWorkflow(): string | undefined {
  return logStore.getStore()?.workflow;
}

export function withLogContext<T>(
  workflow: string,
  itemId: string,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  return logStore.run({ workflow, itemId, dir }, fn);
}
