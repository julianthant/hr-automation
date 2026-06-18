import { execFile } from "node:child_process";
import { open, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

export interface ZipFolderOptions {
  /** Abort signal — forwarded to the `zip` child process. */
  signal?: AbortSignal;
}

/**
 * Append a folder into a zip archive, creating the archive if it does not yet
 * exist. The folder is stored by its **basename** (so the archive contains
 * `<folderName>/...`, not the absolute path), by running `zip` from the
 * folder's parent directory.
 *
 * Uses the system `zip` binary (present on macOS at `/usr/bin/zip`); the repo
 * intentionally carries no archive dependency. `zip` is append-by-default: a
 * second call with the same archive adds to it rather than replacing it, which
 * is how a pool of workers builds one combined archive (serialize the calls
 * with {@link withFileLock} — concurrent writes to one archive corrupt it).
 *
 * Fails loud: a missing `zip` binary or a non-zero exit throws.
 */
export async function zipFolderInto(
  archivePath: string,
  folderPath: string,
  opts: ZipFolderOptions = {},
): Promise<void> {
  const cwd = dirname(folderPath);
  const folderName = basename(folderPath);
  try {
    // -r recurse, -q quiet. Relative folderName + cwd → stored path is the
    // folder name only. Absolute archivePath is written regardless of cwd.
    await execFileAsync("zip", ["-r", "-q", archivePath, folderName], {
      cwd,
      signal: opts.signal,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `zip binary not found — cannot archive "${folderName}". Install zip or add an archive dependency.`,
        { cause: err },
      );
    }
    throw new Error(`zip failed for "${folderName}" → ${archivePath}: ${e.message}`, { cause: err });
  }
}

export interface FileLockOptions {
  /** Abort signal — rejects the acquire loop. */
  signal?: AbortSignal;
  /** Poll interval while the lock is held by someone else (ms). */
  retryMs?: number;
  /** Give up acquiring after this long and throw (ms). */
  timeoutMs?: number;
  /** Treat a lock file older than this as abandoned and steal it (ms). */
  staleMs?: number;
}

/**
 * Run `fn` while holding an exclusive cross-process lock represented by a
 * lock file at `lockPath`. The lock is acquired by atomically creating the
 * file with the `wx` flag (fails if it already exists); held locks are polled
 * until free, a `staleMs`-old lock is stolen (covers a crashed holder), and a
 * `timeoutMs` ceiling fails loud rather than waiting forever. Always released
 * (file removed) in `finally`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const retryMs = opts.retryMs ?? 150;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const staleMs = opts.staleMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Held by someone else — steal if abandoned, else wait.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          log.warn(`Stealing stale lock: ${lockPath}`);
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring lock after ${timeoutMs}ms: ${lockPath}`, { cause: err });
      }
      await sleep(retryMs, opts.signal);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
