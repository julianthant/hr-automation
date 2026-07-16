import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { createInterface } from "node:readline";

import type { StructuredLogEvent } from "../domain/log-events.js";
import { deriveRowArchetype, type RowArchetype, type WorkflowArchetype } from "../domain/row-archetype.js";
import { trackerWarn } from "./log-sink.js";
import { logFilePath, rowFilePath, rowsDir, parseWorkflowDateFilename } from "./paths.js";

/**
 * LEAF half of the tracker JSONL layer: pure types, validators, date/path
 * helpers, and the cached read primitives. NO import of `utils/log.ts` (or of
 * anything that reaches it) — the logger itself persists through this layer,
 * so that edge would be a runtime module cycle (see `log-sink.ts` and the
 * `tests/unit/architecture/import-cycles.test.ts` ratchet). Warnings route
 * through the settable `trackerWarn` sink instead.
 *
 * The WRITE half (append + live SQLite projection) lives in `jsonl-io.ts`,
 * which re-exports everything here, so the public `jsonl.ts` barrel surface
 * is unchanged.
 */

export const DEFAULT_DIR = ".tracker";

/**
 * YYYY-MM-DD in the system's local timezone. Tracker filenames roll over at
 * local midnight (not UTC midnight) so reads/writes stay coherent for the
 * user's day — without this, every operation between local 5pm PDT and local
 * midnight reads/writes a different file than the dashboard is showing.
 */
export function dateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function trackerDateForTimestamp(timestamp: string): string {
  return dateLocal(new Date(timestamp));
}

export interface LogEntry extends Omit<Partial<StructuredLogEvent>, "level" | "message"> {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  ts: string;
}

export function getLogsJsonlPathForDate(workflow: string, dir: string, date: string): string {
  return logFilePath(workflow, date, dir);
}

function getLogsJsonlPath(workflow: string, dir: string): string {
  return logFilePath(workflow, dateLocal(), dir);
}

// Cache parsed JSONL by file path with LRU eviction. Map's insertion-order
// iteration plus delete-on-hit + re-set gives a 6-line LRU without a dep.
// Cap chosen for ~10 workflows × ~7 active dates.
const PARSE_CACHE_MAX = 64;
type JsonlCachedLine = { lineNum: number; value: unknown };
type ParseCacheEntry = { mtimeMs: number; size: number; entries: JsonlCachedLine[] };
const parseCache = new Map<string, ParseCacheEntry>();

export interface ReadJsonlOpts<T> {
  /** If provided, parsed lines that fail this guard are skipped with a warning. */
  validate?: (raw: unknown, ctx: { file: string; lineNum: number }) => raw is T;
}

function materializeJsonlEntries<T>(path: string, entries: JsonlCachedLine[], opts?: ReadJsonlOpts<T>): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (opts?.validate && !opts.validate(entry.value, { file: path, lineNum: entry.lineNum })) {
      trackerWarn(`[jsonl] skipping invalid line ${entry.lineNum} in ${path}`);
      continue;
    }
    out.push(entry.value as T);
  }
  return out;
}

export function readJsonlCached<T>(path: string, opts?: ReadJsonlOpts<T>): T[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const cached = parseCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Bump to most-recent.
    parseCache.delete(path);
    parseCache.set(path, cached);
    return materializeJsonlEntries(path, cached.entries, opts);
  }
  const entries: JsonlCachedLine[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const [idx, line] of lines.entries()) {
    if (!line) continue;
    const lineNum = idx + 1;
    try {
      entries.push({ lineNum, value: JSON.parse(line) as unknown });
    } catch (err) {
      if (!opts?.validate) throw err;
      trackerWarn(`[jsonl] skipping malformed JSON line ${lineNum} in ${path}: ${(err as Error).message}`);
    }
  }
  // Delete-then-set so a re-parse of an already-cached path bumps its
  // insertion-order position. Map.set on an existing key keeps the original
  // position, which would freeze hot files at first-read time and evict them
  // unfairly once the cache fills.
  parseCache.delete(path);
  parseCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey !== undefined) parseCache.delete(oldestKey);
  }
  return materializeJsonlEntries(path, entries, opts);
}

export async function* readJsonlStream<T>(path: string): AsyncIterable<T> {
  if (!existsSync(path)) return;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line) continue;
      yield JSON.parse(line) as T;
    }
  } finally {
    lines.close();
  }
}

/** Test-only — reset between cases. */
export function __resetParseCacheForTests(): void {
  parseCache.clear();
}

/** Test-only — observable cache size for size-cap assertions. */
export function __getParseCacheSizeForTests(): number {
  return parseCache.size;
}

export function readLogEntries(
  workflow: string,
  itemId?: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const all = readJsonlCached<LogEntry>(getLogsJsonlPath(workflow, dir), { validate: isLogEntry });
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}

/**
 * Rich-typed value carried alongside the string-at-rest `data` record. Each
 * slot preserves the original primitive's shape so the frontend can render
 * dates, numbers, and booleans correctly. Values are string-encoded on the
 * wire so the JSONL-on-disk format stays grep-friendly and numbers can't
 * lose precision across the SSE boundary.
 */
export type TypedValue =
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: string }
  | { type: "date"; value: string }
  | { type: "null"; value: "" };

/**
 * Derive a `TypedValue` from a raw tracker value for co-emission with
 * `data`. Frontend consumers read `typedData?.[k]` when present for
 * type-aware formatting, falling back to `data[k]` otherwise.
 *
 * Objects/arrays are collapsed to a JSON string ("string" type) — they don't
 * cleanly fit the primitive taxonomy and the dashboard never rendered them
 * specially before.
 */
export function toTypedValue(v: unknown): TypedValue {
  if (v === null || v === undefined) return { type: "null", value: "" };
  if (v instanceof Date) return { type: "date", value: v.toISOString() };
  if (typeof v === "number") return { type: "number", value: String(v) };
  if (typeof v === "boolean") return { type: "boolean", value: String(v) };
  if (typeof v === "string") return { type: "string", value: v };
  // fallback for objects/bigint/etc — serialize as string so the frontend
  // shows *something* rather than "[object Object]".
  try {
    return { type: "string", value: JSON.stringify(v) };
  } catch {
    return { type: "string", value: String(v) };
  }
}

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  /** 1-indexed stable run ordinal for this item (SQLite projection / SSE enrichment). */
  runOrdinal?: number;
  /**
   * Rich-typed mirror of `data`. Absent on older JSONL records — the frontend
   * falls back to `data` when a key is missing from `typedData`.
   */
  typedData?: Record<string, TypedValue>;
  /**
   * Original validated input the workflow was invoked with. Set ONLY on
   * `pending` rows by the enqueue / kernel pre-emit path. Subsequent status
   * updates (running/done/failed) do not touch this field — retry & edit-and-
   * resume read it from the run's pending entry. Absent on rows written
   * before this field landed; consumers must fall back to `data`-based
   * reconstruction or report "input unavailable" rather than crashing.
   */
  input?: Record<string, unknown>;
  error?: string;
}

/**
 * Contract 1 — Archetype Stamping.
 *
 * Every persisted tracker row carries `data.archetype`. Emit sites construct a
 * {@link StampedData} (a `Record<string, string>` *with* `archetype` required
 * at the type level) and hand it to `emitTrackerRow` (jsonl-io.ts). The
 * compiler refuses any row that drops the field, replacing the prior
 * "convention plus legacy heuristic" approach that broke whenever a
 * control-layer or orchestrator emit site forgot to stamp it.
 *
 * For row archetypes derived from a workflow's declared `WorkflowArchetype`,
 * see {@link stampArchetypeForRow}. `parentRunId` is still accepted so callers
 * can pass their tracker-row context alongside the workflow shape. The
 * `tests/unit/architecture/tracker-row-emission.test.ts` guard fails the
 * build if any new caller bypasses the helper.
 */
export type StampedData = Record<string, string> & { archetype: RowArchetype };

/** A tracker row emission with archetype-stamped `data` required at the type level. */
export interface TrackerRowEmission {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: TrackerEntry["status"];
  step?: string;
  data: StampedData;
  typedData?: Record<string, TypedValue>;
  input?: Record<string, unknown>;
  error?: string;
}

/**
 * Convenience builder — stamp `archetype` onto an existing data record so it
 * can be passed to `emitTrackerRow`. The resulting object satisfies the
 * `StampedData` constraint.
 *
 * Pass the workflow's declared `WorkflowArchetype` plus the row's
 * `parentRunId` (when present). For canonical row shapes that don't follow the
 * workflow derivation rule, set `override` directly.
 */
export function stampArchetypeForRow(
  data: Record<string, string>,
  args: { workflowArchetype: WorkflowArchetype; parentRunId?: string } | { override: RowArchetype },
): StampedData {
  if ("override" in args) {
    return { ...data, archetype: args.override };
  }
  return { ...data, archetype: deriveRowArchetype(args.workflowArchetype, args.parentRunId) };
}

const TRACKER_ENTRY_STATUSES = new Set<TrackerEntry["status"]>(["pending", "running", "done", "failed", "skipped"]);

export const LOG_ENTRY_LEVELS = new Set<LogEntry["level"]>(["step", "success", "error", "waiting", "warn", "debug"]);

export function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.workflow === "string" &&
    entry.workflow.length > 0 &&
    typeof entry.itemId === "string" &&
    entry.itemId.length > 0 &&
    typeof entry.level === "string" &&
    LOG_ENTRY_LEVELS.has(entry.level as LogEntry["level"]) &&
    typeof entry.message === "string" &&
    typeof entry.ts === "string" &&
    entry.ts.length > 0
  );
}

export function isTrackerEntryStatus(value: unknown): value is TrackerEntry["status"] {
  return typeof value === "string" && TRACKER_ENTRY_STATUSES.has(value as TrackerEntry["status"]);
}

export function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.workflow === "string" &&
    entry.workflow.length > 0 &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.timestamp === "string" &&
    entry.timestamp.length > 0 &&
    isTrackerEntryStatus(entry.status)
  );
}

function getTrackerJsonlPath(workflow: string, dir: string): string {
  return rowFilePath(workflow, dateLocal(), dir);
}

const SSN_KEYS: ReadonlySet<string> = new Set(["ssn"]);
const DOB_KEYS: ReadonlySet<string> = new Set(["dob", "dateOfBirth", "birthdate"]);

/**
 * Serialize an arbitrary value for storage in `TrackerEntry.data` (which is
 * `Record<string, string>` at rest). Preserves fidelity for common rich types:
 *   - Date → ISO string
 *   - null/undefined → ""
 *   - primitive (string/number/boolean/bigint) → String(v)
 *   - object/array → JSON.stringify(v) (falls back to String(v) if circular)
 *
 * SSN/DOB-like fields pass through unchanged; tracker/log dirs are local and gitignored.
 */
export function serializeValue(v: unknown, key?: string): string {
  if (v === null || v === undefined) return "";
  if (key && SSN_KEYS.has(key)) {
    return v instanceof Date ? v.toISOString() : String(v ?? "");
  }
  if (key && DOB_KEYS.has(key)) {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "");
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type RunIdFallbackTarget = { runId?: string } & ({ id: string } | { itemId: string });

export function getRunIdOr(e: RunIdFallbackTarget): string {
  const itemId = "id" in e ? e.id : e.itemId;
  return e.runId || `${itemId}#1`;
}

export function byTimestampAsc<T extends { timestamp: string }>(a: T, b: T): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

export function parseTrackerFilename(name: string): { workflow: string; date: string } | null {
  // Rows live in their own `rows/` subdirectory now, so no `-logs.jsonl` /
  // `sessions-*` exclusions are needed — that directory holds only row files.
  return parseWorkflowDateFilename(name);
}

export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  return readJsonlCached<TrackerEntry>(getTrackerJsonlPath(workflow, dir), { validate: isTrackerEntry });
}

/**
 * List all workflows that have tracker data. Scans the `rows/` subdirectory for
 * files matching `<workflow>-YYYY-MM-DD.jsonl` and returns the workflow names.
 *
 * The positive regex match (rather than "ends in .jsonl") rejects stray meta
 * files that might share the directory but aren't workflow row files.
 */
export function listWorkflows(dir: string = DEFAULT_DIR): string[] {
  const rows = rowsDir(dir);
  if (!existsSync(rows)) return [];
  const out = new Set<string>();
  for (const f of readdirSync(rows)) {
    const parsed = parseTrackerFilename(f);
    if (parsed) out.add(parsed.workflow);
  }
  return [...out];
}

/** List all dates that have tracker data for a given workflow. */
export function listDatesForWorkflow(workflow: string, dir: string = DEFAULT_DIR): string[] {
  const rows = rowsDir(dir);
  if (!existsSync(rows)) return [];
  return readdirSync(rows)
    .map(parseTrackerFilename)
    .filter((parsed): parsed is { workflow: string; date: string } => parsed?.workflow === workflow)
    .map((parsed) => parsed.date)
    .sort()
    .reverse();
}

/** Read entries for a specific date (not just today). */
export function readEntriesForDate(
  workflow: string,
  date: string,
  dir: string = DEFAULT_DIR,
): TrackerEntry[] {
  return readJsonlCached<TrackerEntry>(rowFilePath(workflow, date, dir), { validate: isTrackerEntry });
}

/** Whether this tracker row is terminal for UX/dedupe purposes (not pending/running). */
export function isTerminalTrackerEntryStatus(e: TrackerEntry): boolean {
  return e.status === "done" || e.status === "failed" || e.status === "skipped";
}

/**
 * Latest JSONL line for an item/run on a given calendar date (local filename date).
 * Used by daemon shutdown to avoid duplicate terminal rows when SQLite already
 * reflects cancel/fail but we'd otherwise emit another shutdown cancel.
 */
export function findLatestEntryForRunOnDate(
  workflow: string,
  itemId: string,
  runId: string,
  date: string,
  dir: string = DEFAULT_DIR,
): TrackerEntry | undefined {
  const rows = readEntriesForDate(workflow, date, dir).filter((e) => e.id === itemId && e.runId === runId);
  if (rows.length === 0) return undefined;
  return rows[rows.length - 1];
}

/** Read log entries for a specific date (not just today). */
export function readLogEntriesForDate(
  workflow: string,
  itemId: string | undefined,
  date: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const all = readJsonlCached<LogEntry>(getLogsJsonlPathForDate(workflow, dir, date), { validate: isLogEntry });
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}

/**
 * List distinct runs for a given ID, with their latest status, step, and timestamp.
 *
 * Older runs left in `pending` or `running` are reclassified to `failed`
 * (with step `"interrupted"`) when a newer run for the same ID has started
 * after them. Such runs were killed before they could emit a terminal event
 * (Ctrl+C, SIGKILL, process crash before the SIGINT handler could write
 * synchronously) — leaving them as "pending" forever in the dropdown is
 * misleading. Only the most recent run is allowed to retain a non-terminal
 * status, since it may legitimately still be in-flight.
 */
export function readRunsForId(
  workflow: string,
  id: string,
  date?: string,
  dir: string = DEFAULT_DIR,
): { runId: string; status: string; step?: string; timestamp: string; data?: Record<string, unknown> }[] {
  const all = date ? readEntriesForDate(workflow, date, dir) : readEntries(workflow, dir);
  const runs = new Map<string, {
    entry: TrackerEntry;
    firstTs: string;
    step?: string;
    data?: Record<string, unknown>;
  }>();
  for (const e of all) {
    if (e.id !== id) continue;
    const rid = getRunIdOr(e);
    const existing = runs.get(rid);
    const next = existing ?? { entry: e, firstTs: e.timestamp };
    next.entry = e;
    if (e.timestamp < next.firstTs) next.firstTs = e.timestamp;
    if (e.step) next.step = e.step;
    if (e.data && Object.keys(e.data).length > 0) next.data = e.data;
    runs.set(rid, next);
  }

  const raw = [...runs.entries()]
    .map(([rid, run]) => {
      return {
        runId: rid,
        status: run.entry.status,
        step: run.step,
        timestamp: run.entry.timestamp,
        ...(run.data ? { data: run.data } : {}),
      };
    })
    // Chronological asc (oldest first, newest last — callers rely on
    // data[length-1] to be the latest run). Both legacy `{id}#N` and UUID
    // runIds use tracker timestamps so the sort is shape-agnostic.
    .sort((a, b) => {
      const at = runs.get(a.runId)?.firstTs ?? a.timestamp;
      const bt = runs.get(b.runId)?.firstTs ?? b.timestamp;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

  if (raw.length <= 1) return raw;

  // Reclassify abandoned non-terminal runs. The newest run (last after sort)
  // keeps its real status — that may legitimately be running/pending.
  const newestIdx = raw.length - 1;
  return raw.map((r, i) => {
    if (i === newestIdx) return r;
    if (r.status === "pending" || r.status === "running") {
      return { ...r, status: "failed", step: r.step ?? "interrupted" };
    }
    return r;
  });
}
