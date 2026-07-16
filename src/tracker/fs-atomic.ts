import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Crash-safe whole-file replacement (LEAF — no imports beyond node builtins).
 *
 * Write-in-place (`writeFileSync`) has two crash windows: a partial write
 * leaves a truncated/garbled file, and even a complete write may not be
 * durable until fsync. `writeFileAtomic` closes both: the content is written
 * to a temp file IN THE SAME DIRECTORY (rename is only atomic within one
 * filesystem), fsync'd, `renameSync`'d over the destination (POSIX rename is
 * atomic — readers see either the old file or the new one, never a mix), and
 * the directory is fsync'd so the rename itself survives power loss.
 *
 * Fail-loud: any error throws (including a missing parent directory — no
 * silent mkdir). On a rename failure the fsync'd temp file is left behind as
 * forensic evidence rather than masked by best-effort cleanup.
 *
 * Introduced 2026-07-16 for the crash-safe-persistence milestone; batch 2
 * wires it to the JSON state writers (daemon lockfiles, rotation state, …).
 */
export function writeFileAtomic(path: string, content: string | Buffer): void {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;

  const fd = openSync(tmp, "w");
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmp, path);

  // fsync the directory so the rename (the file's new directory entry) is
  // durable too — without this a crash can roll back to the OLD file even
  // though the write "succeeded".
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Remove a file and fsync its parent directory so the deletion is durable. */
export function unlinkFileDurable(path: string): void {
  const dir = dirname(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Append bytes, fsync the file, and fsync its directory when first created. */
export function appendFileDurable(path: string, content: string | Buffer): void {
  const existed = existsSync(path);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const fd = openSync(path, "a", 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}
