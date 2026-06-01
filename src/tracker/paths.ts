import { join } from "node:path";

/**
 * Centralized `.tracker/` directory layout. Every path *under* the tracker dir
 * is constructed here so the on-disk structure is defined in exactly one place.
 * Add a new persisted artifact? Give it a home in this module — never build a
 * `join(trackerDir, ...)` path inline elsewhere.
 *
 * Layout:
 * ```
 *   <dir>/state.db (+ -wal, -shm)        SQLite live truth   (root; see state/db.ts)
 *   <dir>/rows/<workflow>-<date>.jsonl   tracker / queue rows
 *   <dir>/logs/<workflow>-<date>.jsonl   operator log lines
 *   <dir>/sessions/<date>.jsonl          session events
 *   <dir>/runtime/<name>.json            runtime state (OCR key rotation, …)
 *   <dir>/daemons/   …                   daemon lockfiles + process logs (registry.ts)
 *   <dir>/debug/     …                   row-lifecycle debug dumps (row-lifecycle-debug.ts)
 *   <dir>/pdf-cache/ …                   rasterized PDF pages (files/pdf-cache.ts)
 *   <dir>/uploads/   …                   uploaded source files (dashboard)
 *   <dir>/screenshots/ …                 operator audit screenshots (PATHS.screenshotDir)
 *   <dir>/sharepoint/  *.xlsx            SharePoint roster downloads (sharepoint-download)
 *   <dir>/rosters/     *.xlsx            emergency-contact pre-flight roster downloads
 * ```
 *
 * Row "kind" is conveyed by DIRECTORY, not by a filename suffix: a `rows/` file
 * and a `logs/` file share the identical `<workflow>-<date>.jsonl` name. Classify
 * by which directory a path sits in (see {@link trackerKindForPath}), never by
 * `.endsWith("-logs.jsonl")` or a `sessions-` prefix.
 */

export const ROWS_SUBDIR = "rows";
export const LOGS_SUBDIR = "logs";
export const SESSIONS_SUBDIR = "sessions";
export const RUNTIME_SUBDIR = "runtime";
export const SCREENSHOTS_SUBDIR = "screenshots";
export const SHAREPOINT_SUBDIR = "sharepoint";
export const ROSTERS_SUBDIR = "rosters";

export function rowsDir(dir: string): string {
  return join(dir, ROWS_SUBDIR);
}

export function logsDir(dir: string): string {
  return join(dir, LOGS_SUBDIR);
}

export function sessionsDir(dir: string): string {
  return join(dir, SESSIONS_SUBDIR);
}

export function runtimeDir(dir: string): string {
  return join(dir, RUNTIME_SUBDIR);
}

/** `<dir>/screenshots` — operator audit screenshots (surfaced as `PATHS.screenshotDir`). */
export function screenshotsDir(dir: string): string {
  return join(dir, SCREENSHOTS_SUBDIR);
}

/** `<dir>/sharepoint` — SharePoint roster `.xlsx` downloads. */
export function sharepointDir(dir: string): string {
  return join(dir, SHAREPOINT_SUBDIR);
}

/** `<dir>/rosters` — emergency-contact pre-flight roster `.xlsx` downloads. */
export function rostersDir(dir: string): string {
  return join(dir, ROSTERS_SUBDIR);
}

/** `<dir>/rows/<workflow>-<date>.jsonl` — tracker/queue rows for one workflow+day. */
export function rowFilePath(workflow: string, date: string, dir: string): string {
  return join(rowsDir(dir), `${workflow}-${date}.jsonl`);
}

/** `<dir>/logs/<workflow>-<date>.jsonl` — operator log lines for one workflow+day. */
export function logFilePath(workflow: string, date: string, dir: string): string {
  return join(logsDir(dir), `${workflow}-${date}.jsonl`);
}

/** `<dir>/sessions/<date>.jsonl` — session events for one day (all workflows). */
export function sessionFilePath(date: string, dir: string): string {
  return join(sessionsDir(dir), `${date}.jsonl`);
}

/** `<dir>/runtime/<name>` — runtime state file (e.g. `rotation-state-<provider>.json`). */
export function runtimeFilePath(name: string, dir: string): string {
  return join(runtimeDir(dir), name);
}

const WORKFLOW_DATE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Parse a `rows/` or `logs/` filename `<workflow>-<date>.jsonl` into its parts.
 * Both directories share this filename shape, so one parser serves both.
 */
export function parseWorkflowDateFilename(
  name: string,
): { workflow: string; date: string } | null {
  const m = name.match(WORKFLOW_DATE_RE);
  if (!m) return null;
  return { workflow: m[1], date: m[2] };
}

/** Parse a `sessions/` filename `<date>.jsonl` into its date, else null. */
export function parseSessionFilename(name: string): string | null {
  const m = name.match(DATE_FILE_RE);
  return m ? m[1] : null;
}

/**
 * Classify a tracker file path by its parent directory segment. Returns the
 * projection source kind, defaulting to `"tracker"` for anything that isn't
 * clearly a `logs/` or `sessions/` file (matches the historical default).
 */
export function trackerKindForPath(path: string): "tracker" | "log" | "session" {
  const segments = path.split(/[\\/]/);
  const parent = segments[segments.length - 2];
  if (parent === LOGS_SUBDIR) return "log";
  if (parent === SESSIONS_SUBDIR) return "session";
  return "tracker";
}
