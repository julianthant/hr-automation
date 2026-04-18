// Step-output cache for workflow handlers. Pattern-twin of idempotency.ts.
//
// Problem: when a workflow fails late, re-running redoes expensive read-only
// work (CRM extraction, PDF download). The transactional step is already
// protected by idempotency.ts. Step-cache solves the complementary
// "don't redo expensive read-only work" problem: handlers call stepCacheGet
// at step start and stepCacheSet at step end.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_STEP_CACHE_DIR = ".tracker/step-cache";

export interface StepCacheRecord<T> {
  workflow: string;
  itemId: string;
  stepName: string;
  ts: string; // ISO-8601
  value: T;
}

export interface StepCacheGetOpts {
  /**
   * Max age in hours. Default 2. Pass 0 to disable the TTL check entirely
   * (returns any non-corrupt entry regardless of age).
   */
  withinHours?: number;
  /** Directory containing the step-cache tree. Default `.tracker/step-cache`. */
  dir?: string;
}

export interface StepCacheSetOpts {
  /** Directory containing the step-cache tree. Default `.tracker/step-cache`. */
  dir?: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

// Path-traversal / filesystem-corruption metacharacters.
const UNSAFE_ITEM_ID_RE = /[/\\\0\x00-\x1f]/;
const PARENT_DIR_SEGMENT = /(^|\/)\.\.(\/|$)/;

function assertSafeItemId(itemId: string): void {
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new Error(`step-cache: itemId must be a non-empty string`);
  }
  if (UNSAFE_ITEM_ID_RE.test(itemId)) {
    throw new Error(
      `step-cache: itemId contains unsafe character (path separator, NUL, or ASCII control char): ${JSON.stringify(itemId)}`,
    );
  }
  if (itemId === "." || itemId === ".." || PARENT_DIR_SEGMENT.test(itemId)) {
    throw new Error(`step-cache: itemId may not be '.' or contain '..': ${JSON.stringify(itemId)}`);
  }
}

function itemDir(dir: string, workflow: string, itemId: string): string {
  return join(dir, `${workflow}-${itemId}`);
}

function stepFile(
  dir: string,
  workflow: string,
  itemId: string,
  stepName: string,
): string {
  return join(itemDir(dir, workflow, itemId), `${stepName}.json`);
}

/**
 * Atomic JSON write: writeFileSync to a temp file, then renameSync over the
 * target. A crash mid-write leaves the target intact (old or missing).
 * Throws if JSON.stringify throws (circular ref, BigInt, etc.).
 */
function atomicWriteJson(path: string, data: unknown): void {
  const serialized = JSON.stringify(data, null, 2);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, serialized);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if it was written but rename failed.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Read the most recent cached value. Returns null on miss, TTL expiry, corrupt
 * JSON, or filesystem error. Default TTL: 2 hours. Pass `withinHours: 0` to
 * disable the TTL check entirely.
 */
export function stepCacheGet<T>(
  workflow: string,
  itemId: string,
  stepName: string,
  opts: StepCacheGetOpts = {},
): T | null {
  const dir = opts.dir ?? DEFAULT_STEP_CACHE_DIR;
  const path = stepFile(dir, workflow, itemId, stepName);
  if (!existsSync(path)) return null;

  let record: StepCacheRecord<T>;
  try {
    const raw = readFileSync(path, "utf-8");
    record = JSON.parse(raw) as StepCacheRecord<T>;
  } catch {
    return null;
  }

  if (!record || typeof record.ts !== "string" || !("value" in record)) {
    return null;
  }

  // withinHours === undefined ⇒ use default 2h. Explicit 0 ⇒ disable TTL.
  const withinHours = opts.withinHours !== undefined ? opts.withinHours : 2;
  if (withinHours > 0) {
    const ts = Date.parse(record.ts);
    if (Number.isNaN(ts)) return null;
    const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
    if (ts < cutoff) return null;
  }

  return record.value;
}

/**
 * Write a cached value. Creates the workflow+itemId directory if needed.
 * Atomic (temp file + rename). Throws if:
 *   - `value` isn't JSON-serializable (circular, BigInt, function, etc.)
 *   - `itemId` contains a path-traversal metacharacter
 *
 * Callers invoking from inside a `ctx.step` fn SHOULD wrap this in try/catch
 * so a cache-write failure logs a warning rather than marking the step failed
 * (the underlying work succeeded).
 */
export function stepCacheSet<T>(
  workflow: string,
  itemId: string,
  stepName: string,
  value: T,
  opts: StepCacheSetOpts = {},
): void {
  assertSafeItemId(itemId);
  const dir = opts.dir ?? DEFAULT_STEP_CACHE_DIR;
  const item = itemDir(dir, workflow, itemId);
  if (!existsSync(item)) mkdirSync(item, { recursive: true });

  const record: StepCacheRecord<T> = {
    workflow,
    itemId,
    stepName,
    ts: new Date().toISOString(),
    value,
  };

  atomicWriteJson(stepFile(dir, workflow, itemId, stepName), record);
}

/**
 * Delete cached values for a workflow+itemId. If `stepName` is provided, only
 * that one step; otherwise the whole item directory. Silent on missing paths.
 */
export function stepCacheClear(
  workflow: string,
  itemId: string,
  stepName?: string,
  dir: string = DEFAULT_STEP_CACHE_DIR,
): void {
  if (stepName !== undefined) {
    const path = stepFile(dir, workflow, itemId, stepName);
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const item = itemDir(dir, workflow, itemId);
  if (existsSync(item)) rmSync(item, { recursive: true });
}

/**
 * Walk the step-cache tree and delete `.json` files whose mtime is older than
 * `maxAgeHours`. Empty item directories are removed too. Non-json files are
 * ignored. Returns the count of deleted files.
 */
export function pruneOldStepCache(
  maxAgeHours: number = 168, // 7 days
  dir: string = DEFAULT_STEP_CACHE_DIR,
): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let deleted = 0;

  for (const itemName of readdirSync(dir)) {
    const itemPath = join(dir, itemName);
    let itemStat;
    try {
      itemStat = statSync(itemPath);
    } catch {
      continue;
    }
    if (!itemStat.isDirectory()) continue;

    for (const fileName of readdirSync(itemPath)) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = join(itemPath, fileName);
      try {
        const fileStat = statSync(filePath);
        if (fileStat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        /* best-effort */
      }
    }

    // Remove the item dir if it's now empty.
    try {
      const remaining = readdirSync(itemPath);
      if (remaining.length === 0) rmSync(itemPath, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  return deleted;
}
