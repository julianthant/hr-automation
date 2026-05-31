import { styleText } from "node:util";
import { appendLogEntry, type LogEntry } from "../tracker/jsonl.js";
import { getLogContext } from "./log-context.js";
import { emitDaemonLog } from "../tracker/session-events.js";
import type { StructuredLogEvent } from "../domain/log-events.js";

export {
  setLogRunId, getLogRunId, getLogWorkflow,
  withLogContext, withDaemonLogContext, enterDaemonLogContext,
} from "./log-context.js";

function envBool(name: string): boolean {
  return process.env[name] === "true" || process.env[name] === "1";
}

const DEBUG_ENABLED = envBool("DEBUG");
const E2E_DEBUG_ENABLED = envBool("E2E_DEBUG");

type LogMessage = string | Omit<StructuredLogEvent, "level">;

function messageText(input: LogMessage): string {
  return typeof input === "string" ? input : input.message;
}

function structuredFields(input: LogMessage): Omit<StructuredLogEvent, "level" | "message"> {
  if (typeof input === "string") return {};
  const { message: _message, ...rest } = input;
  return rest;
}

function toStringData(extra: Omit<StructuredLogEvent, "level" | "message">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function appendFromContext(
  level: LogEntry["level"],
  message: string,
  extra: Omit<StructuredLogEvent, "level" | "message"> = {},
): void {
  const ctx = getLogContext();
  if (!ctx) return;
  if (ctx.kind === "daemon") {
    emitDaemonLog(ctx.instance ?? ctx.workflow, level, message, ctx.dir, toStringData(extra));
    return;
  }
  appendLogEntry(
    {
      workflow: ctx.workflow,
      itemId: ctx.itemId ?? "",
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      level,
      message,
      ...extra,
      ts: new Date().toISOString(),
    },
    ctx.dir,
  );
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

  appendFromContext(level, msg, extra);
}

function emitDebug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.log(styleText("gray", "\u00B7 " + msg));
  }
  appendFromContext("debug", msg);
}

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
  e2e: (category: string, payload: string | Record<string, unknown>): void =>
    emitE2e(category, payload),
};
