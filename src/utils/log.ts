import pc from "picocolors";
import { AsyncLocalStorage } from "async_hooks";
import { appendLogEntry, type LogEntry } from "../tracker/jsonl.js";

interface LogContext {
  workflow: string;
  itemId: string;
  dir?: string;
}

const logStore = new AsyncLocalStorage<LogContext>();

function emit(
  level: LogEntry["level"],
  prefix: string,
  msg: string,
  toStderr = false,
): void {
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
        level,
        message: msg,
        ts: new Date().toISOString(),
      },
      ctx.dir,
    );
  }
}

export const log = {
  step: (msg: string): void => emit("step", pc.blue("->"), msg),
  success: (msg: string): void => emit("success", pc.green("\u2713"), msg),
  waiting: (msg: string): void => emit("waiting", pc.yellow("\u231B"), msg),
  error: (msg: string): void => emit("error", pc.red("\u2717"), msg, true),
};

export function withLogContext<T>(
  workflow: string,
  itemId: string,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  return logStore.run({ workflow, itemId, dir }, fn);
}
