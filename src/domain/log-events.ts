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
}

export function normalizeLogEvent(event: StructuredLogEvent): StructuredLogEvent {
  return { ...event };
}
