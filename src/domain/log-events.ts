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
  | "ocr:review-complete"
  | "cancel:requested"
  | "run:terminal"
  // Operation-coordinator lifecycle (oath-signature / emergency-contact PDF
  // runs). These fire on the COORDINATOR's run log — the OCR run + member runs
  // have almost no activity on the coordinator's own runId, so without these
  // the coordinator row's Logs panel shows only the synthetic tracker-state
  // fallback. They are NOT tailed by the Tier-1 harness (which keys on the OCR
  // run's runId), but they share the closed-set contract: additive + stable.
  | "operation:created"
  | "operation:ocr-status"
  | "operation:approved"
  | "operation:discarded"
  // Data-provenance point — one value a workflow read from a system or wrote
  // into one. Emitted by `ctx.recordData` (see `src/domain/data-point.ts`) and
  // consumed by the dashboard's "View Data" log-panel tab, which groups these
  // by `step` into read/write lanes. Additive + stable like every other name
  // here; NOT tailed by the Tier-1 harness.
  | "data:point";

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
  /**
   * Data-provenance fields — present only on `event: "data:point"` lines
   * emitted by `ctx.recordData`. `dataDirection` is `read` (extracted FROM a
   * system) or `write` (inputted INTO one); `dataField` is the stable key,
   * `dataLabel` the human label, `dataValue` the stringified value, `dataNote`
   * an optional provenance qualifier. The source/destination system rides the
   * shared `system` field and the originating step rides `step`. See
   * `src/domain/data-point.ts`.
   */
  dataDirection?: "read" | "write";
  dataField?: string;
  dataLabel?: string;
  dataValue?: string;
  dataNote?: string;
}

export function normalizeLogEvent(event: StructuredLogEvent): StructuredLogEvent {
  return { ...event };
}
