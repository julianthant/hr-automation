/**
 * Process-local approval / discard signaling for OCR.
 *
 * Replaces the prior "orchestrator emits `done step=awaiting-approval` and
 * returns" contract. Under the new contract the OCR row stays `running
 * step=awaiting-approval` until the operator approves (→ `done`) or
 * discards (→ `failed step=discarded`).
 *
 * The kernel-path OCR handler awaits `subscribeToApproval` so the kernel
 * only emits the terminal row when the operator acts. The dashboard-path
 * handler (no kernel wrapping) does not await — the approve/discard HTTP
 * routes write the terminal row directly. Both paths call
 * `emitApproved` / `emitDiscarded` so any in-process subscriber wakes up
 * regardless of which path produced the OCR prep row.
 *
 * Keying is `(workflow, sessionId)` — the OCR row's `id` is the
 * sessionId and remains stable across daemon restarts. The workflow key
 * is reserved for future use; today it is always `"ocr"`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dateLocal } from "../../tracker/jsonl.js";

export interface ApprovalKey {
  workflow: string;
  sessionId: string;
}

export interface ApprovedPayload {
  records: unknown[];
  fannedOutItemIds?: readonly string[];
}

export interface SubscribeOpts {
  /** AbortSignal that rejects the subscription with CancelledError when fired. */
  signal: AbortSignal;
  /** Tracker dir for the JSONL backstop poll. Default `.tracker`. */
  trackerDir?: string;
  /** JSONL polling cadence in ms. Default 10_000. */
  pollMs?: number;
  /** Initial JSONL poll delay (ms). Default 50 — catches an approve that
   * fires just before the subscribe registers. */
  initialPollMs?: number;
}

/** Distinct typed error so callers can branch on `instanceof`. */
export class OcrDiscardedError extends Error {
  readonly discarded = true as const;
  constructor(public readonly reason: string) {
    super(`OCR discarded by operator: ${reason}`);
    this.name = "OcrDiscardedError";
  }
}

/** AbortError-shaped error used when `signal.abort()` fires. */
export class OcrApprovalCancelledError extends Error {
  readonly cancelled = true as const;
  constructor() {
    super("OCR approval wait cancelled");
    this.name = "OcrApprovalCancelledError";
  }
}

interface Listener {
  resolve: (payload: ApprovedPayload) => void;
  reject: (err: Error) => void;
}

const listenersByKey = new Map<string, Set<Listener>>();

function keyOf(k: ApprovalKey): string {
  return `${k.workflow}\0${k.sessionId}`;
}

function ensureBucket(key: string): Set<Listener> {
  let bucket = listenersByKey.get(key);
  if (!bucket) {
    bucket = new Set();
    listenersByKey.set(key, bucket);
  }
  return bucket;
}

function dropListener(key: string, listener: Listener): void {
  const bucket = listenersByKey.get(key);
  if (!bucket) return;
  bucket.delete(listener);
  if (bucket.size === 0) listenersByKey.delete(key);
}

/**
 * Wait for the operator to approve or discard the OCR row keyed by
 * `(workflow, sessionId)`. Resolves with the approved payload, rejects
 * with `OcrDiscardedError` on discard, or `OcrApprovalCancelledError`
 * when the AbortSignal fires.
 *
 * JSONL polling backstop catches an approve/discard that landed before
 * the subscription registered (or that happened out-of-process for a
 * dashboard-driven prep that the kernel later picked up). The first
 * poll fires near-immediately; subsequent polls at `pollMs` cadence.
 *
 * All timers + signal listeners + in-memory listeners are cleaned up
 * on resolve / reject. No leaks.
 */
export function subscribeToApproval(
  key: ApprovalKey,
  opts: SubscribeOpts,
): Promise<ApprovedPayload> {
  const k = keyOf(key);
  const trackerDir = opts.trackerDir ?? ".tracker";
  const pollMs = opts.pollMs ?? 10_000;
  const initialPollMs = opts.initialPollMs ?? 50;

  return new Promise<ApprovedPayload>((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      opts.signal.removeEventListener("abort", onAbort);
      dropListener(k, listener);
    };

    const settleResolve = (payload: ApprovedPayload): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = (): void => {
      settleReject(new OcrApprovalCancelledError());
    };

    const listener: Listener = {
      resolve: settleResolve,
      reject: settleReject,
    };

    if (opts.signal.aborted) {
      // Aborted before registration — reject synchronously after cleanup.
      reject(new OcrApprovalCancelledError());
      return;
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
    ensureBucket(k).add(listener);

    const pollOnce = (): void => {
      if (settled) return;
      const latest = readLatestOcrApprovalState(trackerDir, key.sessionId);
      if (latest === null) {
        scheduleNextPoll();
        return;
      }
      if (latest.kind === "approved") {
        settleResolve(latest.payload);
        return;
      }
      // discarded
      settleReject(new OcrDiscardedError(latest.reason));
    };

    const scheduleNextPoll = (): void => {
      if (settled) return;
      pollTimer = setTimeout(pollOnce, pollMs);
      // Don't keep the process alive just for the OCR backstop poll —
      // the in-process signal is the primary wake-up.
      pollTimer.unref?.();
    };

    // First poll near-immediately so an approve that fired between
    // subscribe-call-site and our event listener registration is still
    // picked up. Subsequent polls at pollMs cadence.
    pollTimer = setTimeout(pollOnce, initialPollMs);
    pollTimer.unref?.();
  });
}

/**
 * Wake any pending `subscribeToApproval` for `(workflow, sessionId)` with
 * the approved payload. Throws when there is no subscriber AND no recent
 * in-flight context — fail-loud so misrouted approve calls surface
 * instead of silently dropping.
 *
 * Currently throws when the key has no subscriber. The HTTP approve
 * route may legitimately emit without a kernel-side listener (dashboard
 * path), so callers that don't need to wake a listener can pass
 * `{ requireListener: false }`.
 */
export function emitApproved(
  key: ApprovalKey,
  payload: ApprovedPayload,
  opts: { requireListener?: boolean } = {},
): void {
  const k = keyOf(key);
  const bucket = listenersByKey.get(k);
  if (!bucket || bucket.size === 0) {
    if (opts.requireListener) {
      throw new Error(
        `emitApproved: no subscriber registered for ${key.workflow}/${key.sessionId}`,
      );
    }
    return;
  }
  // Snapshot listeners — each resolve mutates the bucket via cleanup.
  for (const listener of [...bucket]) {
    listener.resolve(payload);
  }
}

/**
 * Reject any pending `subscribeToApproval` for `(workflow, sessionId)`
 * with an `OcrDiscardedError`. See `emitApproved` for the
 * `requireListener` contract.
 */
export function emitDiscarded(
  key: ApprovalKey,
  reason: string,
  opts: { requireListener?: boolean } = {},
): void {
  const k = keyOf(key);
  const bucket = listenersByKey.get(k);
  if (!bucket || bucket.size === 0) {
    if (opts.requireListener) {
      throw new Error(
        `emitDiscarded: no subscriber registered for ${key.workflow}/${key.sessionId}`,
      );
    }
    return;
  }
  for (const listener of [...bucket]) {
    listener.reject(new OcrDiscardedError(reason));
  }
}

/** Test-only: clear all subscribers + state. */
export function _resetApprovalSignalRegistryForTests(): void {
  for (const bucket of listenersByKey.values()) {
    for (const listener of bucket) {
      // Defensive: synthesize an error so any leaked promise rejects
      // instead of hanging the test runner.
      try { listener.reject(new Error("registry reset")); } catch { /* swallow */ }
    }
  }
  listenersByKey.clear();
}

// ─── JSONL backstop ─────────────────────────────────────────

interface JsonlLatestApprovalState {
  kind: "approved";
  payload: ApprovedPayload;
}
interface JsonlLatestDiscardState {
  kind: "discarded";
  reason: string;
}
type JsonlLatestApproval = JsonlLatestApprovalState | JsonlLatestDiscardState;

/**
 * Read the OCR JSONL for `sessionId` and return the latest terminal
 * approval state (approved | discarded), or null when no terminal row
 * exists yet. Looks at today's and yesterday's JSONL so a session that
 * crossed midnight is still picked up.
 */
function readLatestOcrApprovalState(
  trackerDir: string,
  sessionId: string,
): JsonlLatestApproval | null {
  const today = dateLocal();
  // Walk today + yesterday in newest-first order.
  const dates = [today, addDays(today, -1)];
  let latest: { ts: string; row: ApprovalRow } | null = null;
  for (const date of dates) {
    const path = join(trackerDir, `ocr-${date}.jsonl`);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const row = parsed as Partial<ApprovalRow> | null;
      if (!row || typeof row !== "object") continue;
      if (row.id !== sessionId) continue;
      if (typeof row.timestamp !== "string") continue;
      const kind = classifyApprovalRow(row);
      if (kind === null) continue;
      if (!latest || latest.ts < row.timestamp) {
        latest = { ts: row.timestamp, row: row as ApprovalRow };
      }
    }
  }
  if (!latest) return null;
  return interpretRow(latest.row);
}

interface ApprovalRow {
  id?: string;
  timestamp?: string;
  status?: string;
  step?: string;
  data?: Record<string, unknown>;
  error?: string;
}

function classifyApprovalRow(row: Partial<ApprovalRow>): "approved" | "discarded" | null {
  if (row.status === "done" && row.step === "approved") return "approved";
  if (row.status === "failed" && row.step === "discarded") return "discarded";
  return null;
}

function interpretRow(row: ApprovalRow): JsonlLatestApproval {
  if (row.status === "failed" && row.step === "discarded") {
    return { kind: "discarded", reason: row.error ?? "operator discarded OCR prep" };
  }
  // Approved — parse records / fannedOutItemIds from the row's data field.
  const data = row.data ?? {};
  const records = parseRecordsField(data.records);
  const fannedOutItemIds = parseStringArrayField(data.fannedOutItemIds);
  return {
    kind: "approved",
    payload: { records, ...(fannedOutItemIds ? { fannedOutItemIds } : {}) },
  };
}

function parseRecordsField(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArrayField(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
      ? (parsed as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
