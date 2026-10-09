import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { logsDir, rowsDir, sessionsDir } from "./paths.js";

/**
 * Torn-write recovery for append-only JSONL files (LEAF — no `utils/log.ts`,
 * see `log-sink.ts`).
 *
 * `appendJsonlWithSource` appends after whatever tail exists. A crash mid-write
 * (power loss, SIGKILL between the page-cache write and the newline landing)
 * leaves a partial line with NO trailing newline; the NEXT append then fuses
 * with the fragment, permanently corrupting TWO rows (the torn one and the
 * fresh one). Truncating the file back to its last complete newline before any
 * further append converts that into the loss of ONLY the already-torn line —
 * which was never durable to begin with.
 *
 * The live writer calls `truncateToLastNewline` immediately before every
 * append while holding that file's cross-process append lock. The bulk sweep
 * remains available only for explicit offline maintenance; running it during
 * dashboard/daemon startup can race a live writer and truncate valid bytes.
 */

/** Backwards-scan block size for locating the last newline. */
const SCAN_CHUNK_BYTES = 4096;

/**
 * If `path` does not end in `\n`, inspect the final segment. A complete JSON
 * value is durable data whose newline alone was interrupted, so normalize it
 * by appending `\n`. Only an unparseable fragment is truncated back to the
 * preceding newline. Returns bytes dropped (normalization returns `0`).
 */
export function truncateToLastNewline(path: string): number {
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  if (size === 0) return 0;
  const fd = openSync(path, "r+");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0; // healthy: newline-terminated

    // Locate the start of the newline-less tail.
    let keep = 0; // bytes to keep: index just past the last '\n'
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - SCAN_CHUNK_BYTES);
      const chunk = Buffer.alloc(pos - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const idx = chunk.lastIndexOf(0x0a);
      if (idx !== -1) {
        keep = start + idx + 1;
        break;
      }
      pos = start;
    }
    const tail = Buffer.alloc(size - keep);
    readSync(fd, tail, 0, tail.length, keep);
    try {
      JSON.parse(tail.toString("utf8"));
      writeSync(fd, Buffer.from("\n"), 0, 1, size);
      fsyncSync(fd);
      return 0;
    } catch {
      // A syntactically incomplete value was never a complete JSONL record.
    }
    ftruncateSync(fd, keep);
    fsyncSync(fd);
    return size - keep;
  } finally {
    closeSync(fd);
  }
}

export interface TornTailRecovery {
  path: string;
  bytesDropped: number;
}

/**
 * Offline-only sweep of every `.jsonl` under `rows/`, `logs/`, and `sessions/`
 * dirs and truncate any torn tail. Returns the files that were actually
 * repaired so the caller can surface them (boot recovery must be visible, not
 * silent). Sweeping all partitions (not just today's) also heals a crash that
 * tore yesterday's file just before midnight; healthy files cost one stat +
 * one-byte read each.
 */
export function recoverTornJsonlTails(dir: string): TornTailRecovery[] {
  const out: TornTailRecovery[] = [];
  for (const root of [rowsDir(dir), logsDir(dir), sessionsDir(dir)]) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, f);
      const bytesDropped = truncateToLastNewline(path);
      if (bytesDropped > 0) out.push({ path, bytesDropped });
    }
  }
  return out;
}
