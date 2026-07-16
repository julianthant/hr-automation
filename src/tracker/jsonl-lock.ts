import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 10;
const STALE_LOCK_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeDeadOrStaleLock(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath);
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    const ownerIsDead = Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
    const ownerWasNeverRecorded = !Number.isInteger(pid) && Date.now() - stat.mtimeMs >= STALE_LOCK_MS;
    if (!ownerIsDead && !ownerWasNeverRecorded) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/**
 * Cross-process critical section for one JSONL file.
 *
 * The exclusive-create lock is deliberately adjacent to the JSONL source so
 * every dashboard/daemon process on the same filesystem observes the same
 * owner. A dead PID is reclaimed immediately; an owner-less lock (the tiny
 * crash window between create and writing the PID) is reclaimed after a
 * bounded stale interval. A live holder that exceeds the timeout fails loud.
 */
export function withExclusiveFileLock<T>(
  lockPath: string,
  body: () => T,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  label: string = lockPath,
): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeDeadOrStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label}`, { cause: error });
      }
      sleepSync(RETRY_MS);
    }
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const cleanupErrors: Error[] = [];
  try {
    closeSync(fd);
  } catch (error) {
    cleanupErrors.push(error instanceof Error
      ? error
      : new Error(`Failed to close lock file: ${lockPath}`, { cause: error }));
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      cleanupErrors.push(error instanceof Error
        ? error
        : new Error(`Failed to remove lock file: ${lockPath}`, { cause: error }));
    }
  }

  if (!outcome.ok) {
    const bodyError = outcome.error instanceof Error
      ? outcome.error
      : new Error(`Lock body threw a non-Error value: ${label}`, { cause: outcome.error });
    if (cleanupErrors.length > 0) {
      throw new AggregateError([bodyError, ...cleanupErrors], `Lock body and cleanup failed: ${label}`);
    }
    throw bodyError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Lock cleanup failed: ${label}`);
  }
  return outcome.value;
}

export function withJsonlAppendLock<T>(
  jsonlPath: string,
  body: () => T,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): T {
  return withExclusiveFileLock(
    `${jsonlPath}.append.lock`,
    body,
    timeoutMs,
    `JSONL append lock: ${jsonlPath}`,
  );
}
