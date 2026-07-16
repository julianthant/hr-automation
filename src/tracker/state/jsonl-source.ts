import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { ProjectionSourceKind, ProjectionSourceRef } from "./types.js";
import { trackerKindForPath } from "../paths.js";
import { truncateToLastNewline } from "../jsonl-recovery.js";
import { withJsonlAppendLock } from "../jsonl-lock.js";
import { trackerWarn } from "../log-sink.js";
import { appendFileDurable } from "../fs-atomic.js";
import { canonicalSourcePath } from "./source-path.js";

export function appendJsonlWithSource(
  path: string,
  payload: unknown,
  source: Omit<ProjectionSourceRef, "path" | "line" | "offset">,
): ProjectionSourceRef {
  const offset = appendJsonlLineLocked(path, payload);
  return { ...source, path: canonicalSourcePath(path), offset };
}

/** Append one JSONL record under the shared per-file lock and return its byte offset. */
export function appendJsonlLineLocked(path: string, payload: unknown): number {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  return withJsonlAppendLock(path, () => {
    const bytesDropped = truncateToLastNewline(path);
    if (bytesDropped > 0) {
      trackerWarn(
        `[jsonl] recovered torn tail in ${path}: dropped ${bytesDropped} byte(s) of a partial line left by a previous crash`,
      );
    }
    let offset = 0;
    try {
      offset = statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const line = JSON.stringify(payload) + "\n";
    appendFileDurable(path, line);
    return offset;
  });
}

export function sourceKindForFile(path: string): ProjectionSourceKind {
  // Kind is conveyed by the parent directory (`rows/` | `logs/` | `sessions/`),
  // not a filename suffix. See `paths.ts`.
  return trackerKindForPath(path);
}
