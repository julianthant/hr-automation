export type TypedValue =
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: string }
  | { type: "date"; value: string }
  | { type: "null"; value: "" };

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  /** Rich-typed mirror of `data` — absent on legacy pre-subsystem-D records. */
  typedData?: Record<string, TypedValue>;
  error?: string;
  /** First-seen timestamp for this entry (computed by useEntries, not from backend). */
  startTimestamp?: string;
  /**
   * Run start — the earliest timestamp the dashboard knows about for this
   * run, across both the tracker JSONL and the log JSONL. For batch items
   * this is the synthetic auth `running` entry injected at `onAuthStart`
   * (so the timer includes auth); for single-run items it's the `pending`
   * entry. Anchors the header Elapsed + queue-row elapsed so they tile
   * the step pipeline exactly.
   */
  firstLogTs?: string;
  /** Run end — latest timestamp across tracker + log JSONL (enriched by backend SSE). */
  lastLogTs?: string;
  /** Last log message (enriched by backend SSE, for queue display). */
  lastLogMessage?: string;
  /**
   * 1-indexed chronological run number for this item (enriched by backend
   * SSE + /api/runs). Derived from the earliest tracker entry timestamp, so
   * works consistently for both legacy `{id}#N` runIds and UUID-format
   * runIds emitted by batch/pool runners. Prefer this over parsing the
   * runId string — that path only works for the `{id}#N` shape.
   */
  runOrdinal?: number;
  /**
   * Per-step durations in milliseconds (enriched by backend SSE).
   * Key: step name declared by the workflow. Value: ms between that step's
   * first appearance and the next step (or the run's terminal status).
   * Only steps with a completed duration are present — a step that is
   * currently running has no entry yet.
   */
  stepDurations?: Record<string, number>;
  /**
   * Count of screenshot PNGs saved for this failed entry (enriched by
   * backend SSE). Always undefined unless `status === "failed"`.
   */
  screenshotCount?: number;
}

/** Metadata for a single failure screenshot, as returned by /api/screenshots. */
export interface ScreenshotListEntry {
  filename: string;
  ts: string;
  sizeBytes: number;
  step: string;
}

/**
 * One search hit returned by `/api/search`. Thin shape — the dropdown only
 * needs enough to render a result row and deep-link into the tracker view.
 */
export interface SearchResultRow {
  workflow: string;
  id: string;
  runId: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** Latest timestamp for this (workflow, id, runId). */
  lastTs: string;
  /** YYYY-MM-DD the match lives in — used by the UI to navigate. */
  date: string;
  /** Compact one-line summary (name / doc id / email). Never empty. */
  summary: string;
}

/**
 * One row in the navbar approval inbox. The inbox surfaces preview-row
 * tracker entries that are "ready for review" — see
 * docs/superpowers/specs/2026-04-29-navbar-add-ons-design.md for the
 * universal discriminator rule.
 */
export interface PreviewInboxRow {
  workflow: string;
  id: string;
  runId: string;
  /** Display name — typically the original PDF filename. */
  summary: string;
  /** ISO timestamp of the latest tracker entry for this row. */
  ts: string;
  /** Tracker date (YYYY-MM-DD) so the dashboard can deep-link. */
  date: string;
  /** Optional record-count hint (emergency-contact prep parent rows have it). */
  recordCount?: number;
}

/**
 * One row in the failure-bell popover. Returned by GET /api/failures.
 */
export interface FailureRow {
  workflow: string;
  id: string;
  runId: string;
  summary: string;
  error: string;
  ts: string;
  date: string;
}

/**
 * Augment the existing /events SSE payload with failureCounts.
 * The field is optional so older backends still parse cleanly during dev.
 */
export interface EntriesEventPayloadFailureCounts {
  failureCounts?: Record<string, number>;
}

/**
 * Format a millisecond count as a short, dashboard-friendly label.
 * `<1s` when under a second, `Ns` under a minute, `Nm Ss` under an hour, else `Nh Mm`.
 */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  ts: string;
}

export interface RunInfo {
  runId: string;
  status: string;
  step?: string;
  timestamp: string;
  /** Per-step durations in ms for THIS run, computed server-side from the
   *  run's own JSONL history. Use this (not the deduped entry's field) when
   *  rendering the timeline, so that picking an older run via RunSelector
   *  shows that run's actual timing instead of the latest run's. */
  stepDurations?: Record<string, number>;
  /** Run start — earliest timestamp across tracker + log JSONL for THIS
   *  run. Anchors the "Started" cell and Elapsed so the header timing
   *  switches with the run selector. Includes the synthetic auth tracker
   *  entries for batch items (so the timer covers auth). See
   *  `RunTimeline` in src/tracker/dashboard.ts for the single source of
   *  truth on run-span semantics. */
  firstLogTs?: string;
  /** Run end — latest timestamp across tracker + log JSONL for THIS run.
   *  Used for Elapsed when the run is no longer live (done/failed). */
  lastLogTs?: string;
  /** 1-indexed chronological run number assigned server-side. Prefer this
   *  over parsing `runId.split('#')[1]` — UUID runIds have no trailing
   *  `#N`. See `buildRunTimelines` in src/tracker/dashboard.ts. */
  runOrdinal?: number;
}

// ── Detail-value formatting ──────────────────────────────
//
// Generic, type-aware renderer that reads a TrackerEntry's data for a given
// key. Prefers `typedData[key]` (new-shape records) and falls back to
// `data[key]` (legacy records). Returns an em-dash for missing values so the
// dashboard's detail grid never shows empty cells.

const NUMBER_FMT = new Intl.NumberFormat();
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatTrackerValue(entry: TrackerEntry, key: string): string {
  const typed = entry.typedData?.[key];
  if (typed) {
    switch (typed.type) {
      case "string":
        return typed.value || "\u2014";
      case "number": {
        const n = Number(typed.value);
        return Number.isFinite(n) ? NUMBER_FMT.format(n) : typed.value;
      }
      case "boolean":
        return typed.value === "true" ? "Yes" : "No";
      case "date": {
        const d = new Date(typed.value);
        return isNaN(d.getTime()) ? typed.value : DATE_FMT.format(d);
      }
      case "null":
        return "\u2014";
    }
  }
  const fallback = entry.data?.[key];
  if (fallback === undefined || fallback === "") return "\u2014";
  return fallback;
}

/** Does this key carry a monospace/identifier feel (emplId, email, etc.)? */
export function isMonospaceKey(key: string): boolean {
  return /id$|number$|email|empl|wage|ssn|date|count$/i.test(key);
}

// ── Session Panel Types ────────────────────────────────

export type AuthState = "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";

export interface BrowserState {
  browserId: string;
  system: string;
  authState: AuthState;
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  /** Kebab-case workflow name resolved from the instance label (e.g. "Separation 1" → "separations"). null when unrecognised. */
  workflow: string | null;
  /** ISO-8601 timestamp of the latest workflow_start event for this instance.
   * Used by the terminal-drawer cards to render a live elapsed counter via
   * `useElapsed`. Re-runs under the same instance overwrite this with the
   * newest start so the timer reflects the current run, not the original. */
  startedAt?: string;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  crashedOnLaunch?: boolean;
  currentItemId: string | null;
  /** True between item_start and item_complete — i.e. a real item is currently being processed. */
  itemInFlight: boolean;
  currentStep: string | null;
  finalStatus: "done" | "failed" | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}

// ── Run Event Types ────────────────────────────────────

/** Mirror of backend SessionEventType for frontend consumption. */
export type RunEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete"
  | "step_change"
  | "screenshot";

export interface RunEvent {
  type: RunEventType;
  /** ISO-8601 timestamp. Missing on legacy screenshot events written before
   * 2026-04-23 — those only carry `ts` (numeric ms). Consumers should use
   * `resolveRunEventTimestamp(event)` to get a valid Date regardless. */
  timestamp?: string;
  /** Numeric ms since epoch. Populated on screenshot events; absent on
   * everything else. */
  ts?: number;
  pid?: number;
  workflowInstance?: string;
  runId?: string;
  step?: string;
  system?: string;
  currentItemId?: string;
  currentStep?: string;
  finalStatus?: "done" | "failed";
  data?: Record<string, string>;
  /** screenshot event fields (populated when type === "screenshot") */
  screenshotKind?: "form" | "error" | "manual";
  screenshotLabel?: string;
  screenshotFileCount?: number;
}

/**
 * Return a Date for a RunEvent even when it lacks the ISO `timestamp`
 * field. Screenshot events emitted before 2026-04-23 only carried `ts`
 * (numeric ms); both new shape and legacy shape are supported here so the
 * Events tab doesn't render "Invalid Date" for historical rows.
 */
export function resolveRunEventTimestamp(event: RunEvent): Date {
  if (event.timestamp) {
    const d = new Date(event.timestamp);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof event.ts === "number") return new Date(event.ts);
  return new Date(NaN);
}

// ── Step name formatting (stable — used by StepPipeline + WorkflowBox) ──

const STEP_ABBREVIATIONS: Record<string, string> = {
  ucpath: "UCPath",
  kuali: "Kuali",
  kronos: "Kronos",
  crm: "CRM",
  sso: "SSO",
  ukg: "UKG",
  pdf: "PDF",
  i9: "I-9",
};

export function formatStepName(step: string): string {
  return step
    .replace(/-/g, " ")
    .replace(/\b\w+/g, (w) => STEP_ABBREVIATIONS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1));
}

export type LogCategory = "fill" | "navigate" | "extract" | "search" | "select" | "auth" | "download" | "success" | "error" | "waiting" | "step" | "debug";

export function getLogCategory(level: string, message: string): LogCategory {
  if (level === "debug") return "debug";
  if (level === "success") return "success";
  if (level === "error") return "error";
  if (level === "waiting") return "waiting";
  const msg = (message || "").toLowerCase();
  if (msg.includes("fill") || msg.includes("comp rate") || msg.includes("compensation")) return "fill";
  if (msg.includes("click") || msg.includes("navigat")) return "navigate";
  if (msg.includes("crm field") || msg.includes("extract") || msg.includes("matched label")) return "extract";
  if (msg.includes("search") || msg.includes("found") || msg.includes("result") || msg.includes("person search")) return "search";
  if (msg.includes("select") || msg.includes("dropdown") || msg.includes("template") || msg.includes("reason")) return "select";
  if (msg.includes("sso") || msg.includes("duo") || msg.includes("auth") || msg.includes("credential") || msg.includes("login")) return "auth";
  if (msg.includes("download") || msg.includes("pdf") || msg.includes("report")) return "download";
  return "step";
}
