import { AsyncLocalStorage } from "async_hooks";

export interface LogContext {
  kind: "run" | "daemon";
  workflow: string;
  dir?: string;
  itemId?: string;   // run scope
  runId?: string;    // run scope
  instance?: string; // daemon scope
}

const logStore = new AsyncLocalStorage<LogContext>();

/** Current log context, or undefined when none is active. */
export function getLogContext(): LogContext | undefined {
  return logStore.getStore();
}

/** Update the current context with a runId (called from withTrackedWorkflow). */
export function setLogRunId(runId: string): void {
  const ctx = logStore.getStore();
  if (ctx) ctx.runId = runId;
}

export function getLogRunId(): string | undefined {
  return logStore.getStore()?.runId;
}

export function getLogWorkflow(): string | undefined {
  return logStore.getStore()?.workflow;
}

/** Run `fn` stamped as ONE run's log context. Run log lines → run log. */
export function withLogContext<T>(
  workflow: string,
  itemId: string,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  return logStore.run({ kind: "run", workflow, itemId, dir }, fn);
}

/** Run `fn` stamped as the DAEMON's log context. Daemon log lines → session log. */
export function withDaemonLogContext<T>(
  workflow: string,
  instance: string,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  return logStore.run({ kind: "daemon", workflow, instance, dir }, fn);
}

/**
 * Set the daemon log context for the REST of the current async flow without
 * wrapping a callback. For long-lived top-level daemon code (Piece 3 uses this).
 * Per-item run contexts created later via `withLogContext` nest over this.
 */
export function enterDaemonLogContext(
  workflow: string,
  instance: string,
  dir?: string,
): void {
  logStore.enterWith({ kind: "daemon", workflow, instance, dir });
}
