/**
 * Leaf type module for session events (ZERO imports). Split out of
 * `session-events.ts` (2026-07-16) so the projection modules reachable FROM
 * `session-events.ts` (`state/runtime.ts` → `state/apply.ts` / `state/
 * rebuild.ts`, and `jsonl-io.ts`) can consume the event shapes without an
 * import edge back into their own caller. Type-only imports are erased at
 * runtime, but keeping the graph clean under type-aware tools (madge) makes
 * real regressions visible. `session-events.ts` re-exports everything here,
 * so its public surface is unchanged.
 */

/**
 * Structured events emitted by the kernel during workflow execution.
 * Session/browser/auth/item lifecycle + per-step step_change + screenshot.
 */
export type SessionEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "browser_health"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete" | "item_cancelled"
  | "step_change"
  | "screenshot"
  | "idle_signal"
  | "daemon_phase"
  | "daemon_log";

export interface ScreenshotSessionEvent {
  type: "screenshot";
  runId: string;
  /** ISO-8601 timestamp. Mirrors SessionEvent.timestamp so the dashboard
   * doesn't see "Invalid Date" when it renders screenshot events alongside
   * other session events (which use `timestamp`). Populated from the same
   * clock as `ts`. */
  timestamp: string;
  /** Numeric ms since epoch. Kept for back-compat with existing readers
   * and to uniquely identify the capture alongside `label` + `system`
   * inside filenames. */
  ts: number;
  kind: "form" | "error" | "manual" | "step";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string }>;
}

export interface SessionEvent {
  type: SessionEventType;
  timestamp: string;
  pid: number;
  workflowInstance: string;
  sessionId?: string;
  browserId?: string;
  system?: string;
  currentItemId?: string;
  currentStep?: string;
  finalStatus?: "done" | "failed";
  duoRequestId?: string;
  data?: Record<string, string>;
  /** Workflow item runId, written when emitted inside a withLogContext + setLogRunId scope. */
  runId?: string;
  /** Frozen `data.__traceId` of the item's run, carried on `item_start` so the
   * session-drawer card can show the running run's trace id — identical to the
   * subtitle of that run's queue row. */
  traceId?: string;
  /** OS pid of the Chromium process for `browser_launch` events. Lets the
   * dashboard's force-stop path SIGKILL orphaned browsers when the Node
   * parent dies. Only populated for `type === "browser_launch"`. */
  chromiumPid?: number;
}
