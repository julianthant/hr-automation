export type LogCategory =
  | "auth"
  | "navigation"
  | "selector"
  | "delegation"
  | "queue"
  | "worker"
  | "operator"
  | "retry"
  | "ocr"
  | "validation"
  | "debug";

export type LogOccasion =
  | "started"
  | "waiting"
  | "retried"
  | "skipped"
  | "recovered"
  | "cancelled"
  | "failed"
  | "completed"
  | "recorded";

/**
 * Stable, closed set of structured log-EVENT names.
 *
 * **This is a contract.** These names are emitted on the run-scope log path
 * (they persist to `logs/<workflow>-<date>.jsonl` via the `...extra` spread in
 * `appendFromContext`) and are the synchronization primitive the Tier-1
 * delegation harness tails for. The harness's `waitForEvent` matches on
 * `event` + `runId` (+ optionally `step` / `childWorkflow`), so:
 *
 *   - Renaming any value here is a BREAKING change — update every harness
 *     `waitForEvent("...")` call and any other tailer in lockstep.
 *   - Adding a new value is additive and safe.
 *   - Removing a value breaks any harness wait that referenced it.
 *
 * Each name + where it fires + which fields it carries is documented in
 * `docs/engineering/structured-log-events.md`.
 */
export type LogEventName =
  | "delegation:children-spawned"
  | "step:start"
  | "step:done"
  | "ocr:awaiting-approval"
  | "cancel:requested"
  | "run:terminal";

export interface StructuredLogEvent {
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  category?: LogCategory;
  occasion?: LogOccasion;
  subject?: string;
  system?: string;
  step?: string;
  attempt?: number;
  childWorkflow?: string;
  durationMs?: number;
  /**
   * Stable lifecycle/delegation/cancel event name (closed set — see
   * `LogEventName`). When set, this line is a load-bearing event the Tier-1
   * harness can `waitForEvent` on. Optional — most log lines carry no `event`.
   */
  event?: LogEventName;
  /**
   * Count of subjects a single event spans — e.g. the number of children a
   * delegation fan-out spawned (`delegation:children-spawned`). Optional;
   * present only on events where a cardinality is meaningful.
   */
  count?: number;
}

export function normalizeLogEvent(event: StructuredLogEvent): StructuredLogEvent {
  return { ...event };
}
