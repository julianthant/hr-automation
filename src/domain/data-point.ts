import type { LogOccasion, StructuredLogEvent } from "./log-events.js";

/**
 * Data-provenance primitive — the structured record behind `ctx.recordData`
 * and the dashboard's "View Data" log-panel tab.
 *
 * A workflow records two kinds of data movement: a `read` (a value it
 * EXTRACTED from a system) and a `write` (a value it INPUTTED into one). Each
 * point rides the existing structured-log channel as an `event: "data:point"`
 * line (see `buildDataPointLog`), so it persists to JSONL + SQLite and streams
 * to the client with no new transport. The client filters these lines back out
 * (`isDataPointLog`) and groups them by the originating step into read/write
 * lanes (`groupDataPointsByStep`).
 *
 * This module is pure + client-safe (types only — no node imports) so the
 * kernel emitter, the dashboard reader, and unit tests all share one shape.
 */

export const DATA_POINT_EVENT = "data:point" as const;

export type DataDirection = "read" | "write";

/**
 * Operator-supplied data point — the argument to `ctx.recordData`. Only
 * `direction`, `field`, and `value` are required; `label` defaults to a
 * humanized `field`, `system` names the source (read) or destination (write),
 * and `note` is an optional provenance qualifier (e.g. "overrides Kuali LDW").
 */
export interface DataPoint {
  direction: DataDirection;
  field: string;
  label?: string;
  value: unknown;
  system?: string;
  note?: string;
}

/** A data point resolved back from a log line, ready for rendering. */
export interface DataPointView {
  direction: DataDirection;
  field: string;
  label: string;
  value: string;
  step: string;
  system?: string;
  note?: string;
  ts: string;
}

/** Read + write points recorded within a single workflow step. */
export interface DataStepGroup {
  step: string;
  reads: DataPointView[];
  writes: DataPointView[];
}

/** Minimal shape shared by the server `StructuredLogEvent` and the client
 *  `LogEntry` — everything `readDataPointFromLog` needs, nothing more. */
export interface DataPointLogLike {
  event?: string;
  message?: string;
  step?: string;
  system?: string;
  ts?: string;
  dataDirection?: string;
  dataField?: string;
  dataLabel?: string;
  dataValue?: string;
  dataNote?: string;
}

const FALLBACK_STEP = "—";

/** Humanize a camelCase / kebab / snake field key into a Title Case label. */
function humanizeField(field: string): string {
  const spaced = field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return field;
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Stringify a recorded value with the project's logging conventions:
 * `<none>` for null/undefined, `<empty>` for a present-but-blank string.
 * Arrays join with ", "; objects fall back to JSON.
 */
export function coerceDataValue(value: unknown): string {
  if (value === null || value === undefined) return "<none>";
  if (typeof value === "string") return value === "" ? "<empty>" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => coerceDataValue(v)).join(", ") : "<none>";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build the structured log fields for one data point. The kernel passes the
 * result to `log.step(...)`, which spreads these onto the persisted
 * `StructuredLogEvent` (and thus through SQLite `raw_json` to the client).
 * `step` is the workflow's current step, auto-tagged by `makeCtx`.
 */
export function buildDataPointLog(
  point: DataPoint,
  step: string | null,
): Omit<StructuredLogEvent, "level"> {
  const label = point.label?.trim() || humanizeField(point.field);
  const value = coerceDataValue(point.value);
  const verb = point.direction === "read" ? "Read" : "Wrote";
  const systemSuffix = point.system ? ` (${point.system})` : "";
  const noteSuffix = point.note ? ` — ${point.note}` : "";
  const occasion: LogOccasion = "recorded";
  return {
    message: `${verb} · ${label} = ${value}${systemSuffix}${noteSuffix}`,
    event: DATA_POINT_EVENT,
    occasion,
    dataDirection: point.direction,
    dataField: point.field,
    dataLabel: label,
    dataValue: value,
    ...(point.note ? { dataNote: point.note } : {}),
    ...(point.system ? { system: point.system } : {}),
    ...(step ? { step } : {}),
  };
}

/** True when a log line is a well-formed `data:point` record. */
export function isDataPointLog(line: DataPointLogLike): boolean {
  return (
    line.event === DATA_POINT_EVENT &&
    (line.dataDirection === "read" || line.dataDirection === "write") &&
    typeof line.dataField === "string" &&
    line.dataField.length > 0
  );
}

/** Resolve a single data-point log line back into a render-ready view, or
 *  null if the line is not a valid data point. */
export function readDataPointFromLog(line: DataPointLogLike): DataPointView | null {
  if (!isDataPointLog(line)) return null;
  const direction = line.dataDirection as DataDirection;
  const field = line.dataField as string;
  return {
    direction,
    field,
    label: line.dataLabel?.trim() || humanizeField(field),
    value: line.dataValue ?? "<none>",
    step: line.step?.trim() || FALLBACK_STEP,
    ...(line.system ? { system: line.system } : {}),
    ...(line.dataNote ? { note: line.dataNote } : {}),
    ts: line.ts ?? "",
  };
}

/**
 * Group every data point in a chronological log stream by the step it was
 * recorded in, preserving first-seen step order (= run order, since logs
 * arrive timestamp-ascending). Within a step, reads and writes keep their
 * emission order. Non-data lines are ignored.
 */
export function groupDataPointsByStep(lines: DataPointLogLike[]): DataStepGroup[] {
  const order: string[] = [];
  const byStep = new Map<string, DataStepGroup>();
  for (const line of lines) {
    const point = readDataPointFromLog(line);
    if (!point) continue;
    let group = byStep.get(point.step);
    if (!group) {
      group = { step: point.step, reads: [], writes: [] };
      byStep.set(point.step, group);
      order.push(point.step);
    }
    if (point.direction === "read") group.reads.push(point);
    else group.writes.push(point);
  }
  return order.map((step) => byStep.get(step) as DataStepGroup);
}
