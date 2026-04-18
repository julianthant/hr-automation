import type { TrackerEntry } from "./jsonl.js";

/**
 * Input options for `detectFailurePattern`. All have defaults tuned for the
 * current batch-scale workflows — tweak via opts rather than editing here.
 */
export interface DetectOptions {
  /** Minimum consecutive failures needed to raise an alert. Default: 3. */
  thresholdN?: number;
  /** Failures must land inside a rolling window of this many ms. Default: 10 min. */
  windowMs?: number;
  /** Minimum ms between alerts for the same (workflow, error). Default: 1 hour. */
  cooldownMs?: number;
  /**
   * Caller-owned cooldown state. Keyed by `${workflow}:${error}`. The detector
   * mutates this map to record `lastAlertTs` for each fired alert — callers
   * keep the same Map across polling cycles to honor the cooldown.
   *
   * If omitted, cooldown is effectively disabled (every call starts fresh).
   */
  cooldownState?: Map<string, number>;
  /**
   * Injection seam for "now" — tests use this to fix time. Defaults to Date.now().
   */
  now?: () => number;
}

/**
 * A pattern worth alerting on. One entry per (workflow, errorMessage) pair
 * that crossed the threshold inside the window and wasn't recently alerted.
 */
export interface FailurePattern {
  workflow: string;
  error: string;
  count: number;
  /** Earliest qualifying failure ts (ISO). */
  firstTs: string;
  /** Latest qualifying failure ts (ISO). */
  lastTs: string;
}

/**
 * Scan tracker entries for repeated-failure patterns.
 *
 * Semantics:
 *   1. Filter `entries` to `status === "failed"` with a non-empty `error`.
 *   2. Group by (workflow, error).
 *   3. Within each group, look at the most recent `windowMs` from `now()`.
 *   4. If the count inside that window >= threshold, it's a candidate.
 *   5. Candidates are suppressed if the cooldown map shows a recent alert
 *      for the same key.
 *   6. When a candidate IS alerted, we write `now()` into the cooldown map.
 *
 * Pure over the entries + the mutable cooldown map. The detector doesn't
 * do any I/O — the caller decides what to do with the returned patterns
 * (log, notify, push to dashboard, etc.).
 */
export function detectFailurePattern(
  entries: readonly TrackerEntry[],
  opts: DetectOptions = {},
): FailurePattern[] {
  const thresholdN = opts.thresholdN ?? 3;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const cooldownMs = opts.cooldownMs ?? 60 * 60_000;
  const cooldown = opts.cooldownState;
  const nowFn = opts.now ?? (() => Date.now());
  const now = nowFn();
  const windowStart = now - windowMs;

  // Bucket failures by (workflow, error). We only care about failed entries
  // with a truthy error message; skipped/done/running/pending are ignored.
  const buckets = new Map<string, TrackerEntry[]>();
  for (const e of entries) {
    if (e.status !== "failed") continue;
    if (!e.error) continue;
    const key = `${e.workflow}:${e.error}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }

  const out: FailurePattern[] = [];
  for (const [key, bucket] of buckets) {
    // Keep only failures inside the rolling window.
    const inWindow = bucket.filter((e) => {
      const ts = Date.parse(e.timestamp);
      return Number.isFinite(ts) && ts >= windowStart && ts <= now;
    });
    if (inWindow.length < thresholdN) continue;

    // Cooldown — if we alerted on this key recently, skip.
    if (cooldown) {
      const last = cooldown.get(key);
      if (last !== undefined && now - last < cooldownMs) continue;
    }

    // Sort by ts so firstTs/lastTs are accurate even if inputs were unsorted.
    inWindow.sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
    // Grab workflow + error from the first entry (all entries in this bucket
    // share both fields, per the bucketing key).
    const { workflow, error } = inWindow[0];

    out.push({
      workflow,
      error: error!,
      count: inWindow.length,
      firstTs: inWindow[0].timestamp,
      lastTs: inWindow[inWindow.length - 1].timestamp,
    });

    // Stamp the cooldown so the caller doesn't re-alert for an hour.
    if (cooldown) cooldown.set(key, now);
  }

  return out;
}
