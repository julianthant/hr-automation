import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { ProjectionSourceKind, ProjectionSourceRef } from "./types.js";
import { trackerKindForPath } from "../paths.js";

const knownDirs = new Set<string>();

export function appendJsonlWithSource(
  path: string,
  payload: unknown,
  source: Omit<ProjectionSourceRef, "path" | "line" | "offset">,
): ProjectionSourceRef {
  const dir = dirname(path);
  if (!knownDirs.has(dir)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    knownDirs.add(dir);
  }
  let offset = 0;
  try {
    offset = statSync(path).size;
  } catch {
    // File doesn't exist yet — append will create it.
  }
  const line = JSON.stringify(payload) + "\n";
  try {
    appendFileSync(path, line);
  } catch (err) {
    // Cached dir may have been removed (e.g. tests rm-rf the tracker dir
    // between cases). Recreate and retry once.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dir, { recursive: true });
      knownDirs.add(dir);
      appendFileSync(path, line);
    } else {
      throw err;
    }
  }
  return { ...source, path, offset };
}

export function sourceKindForFile(path: string): ProjectionSourceKind {
  // Kind is conveyed by the parent directory (`rows/` | `logs/` | `sessions/`),
  // not a filename suffix. See `paths.ts`.
  return trackerKindForPath(path);
}
