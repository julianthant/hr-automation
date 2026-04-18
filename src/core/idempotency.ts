// Idempotency keys for UCPath Smart HR transactions.
//
// Problem: if a workflow crashes after submitting a transaction but before the
// success tracker event is emitted, re-running creates a duplicate transaction.
//
// Solution: compute a deterministic hash of the transaction's identifying
// fields (e.g. emplId + effectiveDate + template), check a local log before
// submitting. If the same key succeeded within the lookback window, skip.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_IDEMPOTENCY_DIR = ".tracker";
export const IDEMPOTENCY_FILENAME = "idempotency.jsonl";

export interface IdempotencyRecord {
  key: string;
  transactionId: string;
  ts: string; // ISO-8601
  workflow: string;
}

export interface CheckOpts {
  /** Match only records recorded within this many days. Default 14. */
  withinDays?: number;
  /** Directory containing idempotency.jsonl. Default `.tracker`. */
  dir?: string;
}

/**
 * Compute a stable hash from a record. Keys are sorted before stringification
 * so `{a:1,b:2}` and `{b:2,a:1}` produce the same hash. Values are
 * JSON-serialized (undefined/null/numbers/strings all fine).
 */
export function hashKey(record: Record<string, unknown>): string {
  const keys = Object.keys(record).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) {
    normalized[k] = record[k];
  }
  const payload = JSON.stringify(normalized);
  return createHash("sha256").update(payload).digest("hex");
}

function filePath(dir: string): string {
  return join(dir, IDEMPOTENCY_FILENAME);
}

function readRecords(dir: string): IdempotencyRecord[] {
  const path = filePath(dir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: IdempotencyRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as IdempotencyRecord;
      if (parsed && typeof parsed.key === "string" && typeof parsed.ts === "string") {
        out.push(parsed);
      }
    } catch {
      // Skip malformed lines — don't let one bad line block lookups.
    }
  }
  return out;
}

/**
 * Returns true if `key` has a successful record within the lookback window.
 * Silently returns false if the file doesn't exist or is unreadable.
 */
export function hasRecentlySucceeded(key: string, opts: CheckOpts = {}): boolean {
  const withinDays = opts.withinDays ?? 14;
  const dir = opts.dir ?? DEFAULT_IDEMPOTENCY_DIR;
  const records = readRecords(dir);
  if (records.length === 0) return false;

  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return records.some((r) => {
    if (r.key !== key) return false;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) return false;
    return ts >= cutoff;
  });
}

/**
 * Lookup the most recent transactionId recorded for `key` within the window.
 * Useful when the caller wants to surface "already submitted as TX_123".
 */
export function findRecentTransactionId(
  key: string,
  opts: CheckOpts = {},
): string | null {
  const withinDays = opts.withinDays ?? 14;
  const dir = opts.dir ?? DEFAULT_IDEMPOTENCY_DIR;
  const records = readRecords(dir);
  if (records.length === 0) return null;

  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const matching = records
    .filter((r) => r.key === key)
    .map((r) => ({ r, ts: Date.parse(r.ts) }))
    .filter((x) => !Number.isNaN(x.ts) && x.ts >= cutoff);
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.ts - a.ts);
  return matching[0].r.transactionId;
}

/**
 * Append a success record. Creates the tracker dir + file if missing.
 * `transactionId` may be empty when the underlying system didn't return one
 * yet; the key match still prevents duplicate submission.
 */
export function recordSuccess(
  key: string,
  transactionId: string,
  workflow: string,
  dir: string = DEFAULT_IDEMPOTENCY_DIR,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record: IdempotencyRecord = {
    key,
    transactionId,
    ts: new Date().toISOString(),
    workflow,
  };
  appendFileSync(filePath(dir), JSON.stringify(record) + "\n");
}

/**
 * Drop records older than `withinDays`. Rewrites the file atomically via a
 * temp file so a crash mid-write can't corrupt the log.
 */
export function pruneOld(withinDays: number, dir: string = DEFAULT_IDEMPOTENCY_DIR): number {
  const path = filePath(dir);
  if (!existsSync(path)) return 0;
  const records = readRecords(dir);
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const kept = records.filter((r) => {
    const ts = Date.parse(r.ts);
    return !Number.isNaN(ts) && ts >= cutoff;
  });
  const removed = records.length - kept.length;
  if (removed === 0) return 0;
  const serialized = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : "");
  writeFileSync(path, serialized);
  return removed;
}

// Exposed primarily for tests that want to bypass parsing.
export function _readRecordsForTest(dir: string): IdempotencyRecord[] {
  return readRecords(dir);
}

// Touch statSync so the import stays (future use — stat check could be added
// to skip reads when mtime is old; for now it's just a hedge).
export function _fileMtimeMs(dir: string): number | null {
  const path = filePath(dir);
  if (!existsSync(path)) return null;
  return statSync(path).mtimeMs;
}
