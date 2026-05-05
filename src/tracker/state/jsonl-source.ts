import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { ProjectionSourceKind, ProjectionSourceRef } from "./types.js";

export function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").filter(Boolean).length;
}

export function appendJsonlWithSource(
  path: string,
  payload: unknown,
  source: Omit<ProjectionSourceRef, "path" | "line" | "offset">,
): ProjectionSourceRef {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const offset = existsSync(path) ? statSync(path).size : 0;
  const line = countJsonlLines(path) + 1;
  appendFileSync(path, JSON.stringify(payload) + "\n");
  return { ...source, path, line, offset };
}

export function sourceKindForFile(path: string): ProjectionSourceKind {
  if (path.endsWith("sessions.jsonl")) return "session";
  if (path.endsWith("-logs.jsonl")) return "log";
  return "tracker";
}
