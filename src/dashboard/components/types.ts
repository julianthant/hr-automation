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
  /** First log timestamp (enriched by backend SSE). */
  firstLogTs?: string;
  /** Last log timestamp (enriched by backend SSE). */
  lastLogTs?: string;
  /** Last log message (enriched by backend SSE, for queue display). */
  lastLogMessage?: string;
  /**
   * Per-step durations in milliseconds (enriched by backend SSE).
   * Key: step name declared by the workflow. Value: ms between that step's
   * first appearance and the next step (or the run's terminal status).
   * Only steps with a completed duration are present — a step that is
   * currently running has no entry yet.
   */
  stepDurations?: Record<string, number>;
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
  level: "step" | "success" | "error" | "waiting" | "warn";
  message: string;
  ts: string;
}

export interface RunInfo {
  runId: string;
  status: string;
  step?: string;
  timestamp: string;
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
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  currentItemId: string | null;
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

export type LogCategory = "fill" | "navigate" | "extract" | "search" | "select" | "auth" | "download" | "success" | "error" | "waiting" | "step";

export function getLogCategory(level: string, message: string): LogCategory {
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
