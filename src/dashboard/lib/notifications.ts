import { useSyncExternalStore } from "react";
import type { ExternalToast } from "sonner";
import { toast } from "./notify";

/**
 * Notification model — the single, consistent structure every inbox-worthy
 * dashboard event follows, and the one place that both (a) fires a toast and
 * (b) records the event into the NotificationBell's center.
 *
 * ## When to use `notify()` vs `toast.*`
 *
 *   - **`notify({ kind, ... })`** — for events the operator would want to
 *     RECOVER if they missed the toast: terminal run outcomes, an OCR run
 *     reaching review, a capture finishing/failing. These show a toast AND
 *     land in the bell.
 *   - **`toast.*` directly** (`@/lib/notify`) — for transient ACKs that are
 *     pure UI feedback, never worth keeping: "Copied trace id", "Retrying…",
 *     "Saved". These do not belong in the bell.
 *
 * ## Naming + copy pattern (follow this for every new notification)
 *
 *   - **kind** — a stable `domain.event` key from `NOTIFY_KINDS` (e.g.
 *     `run.failed`). The kind drives the default `severity` via
 *     `KIND_SEVERITY`, so a call site only overrides severity for a genuine
 *     exception.
 *   - **title** — the OUTCOME, `subject + verb`: "Maria Lopez completed",
 *     "Capture complete", "Onboarding failed". Not "Error" / "Done".
 *   - **description** — the detail / why / next step: the error reason,
 *     "moves to another daemon", "ready for approval".
 *   - **entityRef** — `{ workflow, id, runId?, date? }` so the bell card can
 *     deep-link to the row. Also seeds the default `dedupeKey`.
 *   - **dedupeKey** — collapses repeats of the same event for the same row
 *     (a re-fired `run.failed` updates the existing card instead of stacking).
 *     Defaults to `<workflow>:<id>:<runId>:<kind>` when an `entityRef` is set.
 *
 * The visual treatment (toast accent bar, bell card tone/icon per severity)
 * is owned by the consumers — `<Toaster>`/`index.css` for toasts and
 * `NotificationBell.tsx` for the center. This module owns identity, copy, and
 * the store; never colours.
 */

/**
 * Severity aligned to the toast facade's types (`@/lib/notify`). `message` is
 * the neutral tone (sonner's `toast.message`, no accent) used for non-event
 * outcomes like "not found". `loading` is intentionally absent — progress
 * spinners are transient and belong on `toast.loading` directly, not the bell.
 */
export type NotificationSeverity = "success" | "info" | "warning" | "error" | "message";

/** Canonical `domain.event` kind catalog. Add a key here before using a new kind. */
export const NOTIFY_KINDS = {
  runCompleted: "run.completed",
  runFailed: "run.failed",
  runNotFound: "run.not_found",
  runCancelled: "run.cancelled",
  ocrAwaitingReview: "ocr.awaiting_review",
  capturePhotoAdded: "capture.photo_added",
  captureBlurry: "capture.blurry",
  captureCompleted: "capture.completed",
  captureFailed: "capture.failed",
  captureExpired: "capture.expired",
} as const;

/** A known catalog kind, or any `domain.event` string a future call site coins. */
export type NotificationKind = (typeof NOTIFY_KINDS)[keyof typeof NOTIFY_KINDS] | (string & {});

/** Default severity per kind. A call site can still override per-call. */
const KIND_SEVERITY: Record<string, NotificationSeverity> = {
  [NOTIFY_KINDS.runCompleted]: "success",
  [NOTIFY_KINDS.runFailed]: "error",
  [NOTIFY_KINDS.runNotFound]: "message",
  [NOTIFY_KINDS.runCancelled]: "warning",
  [NOTIFY_KINDS.ocrAwaitingReview]: "info",
  [NOTIFY_KINDS.capturePhotoAdded]: "info",
  [NOTIFY_KINDS.captureBlurry]: "warning",
  [NOTIFY_KINDS.captureCompleted]: "success",
  [NOTIFY_KINDS.captureFailed]: "error",
  [NOTIFY_KINDS.captureExpired]: "info",
};

/** Resolve a kind's severity, honouring an explicit per-call override. */
export function severityForKind(kind: string, override?: NotificationSeverity): NotificationSeverity {
  return override ?? KIND_SEVERITY[kind] ?? "info";
}

/** Locator for the row a notification is about — enables click-to-open. */
export interface NotificationEntityRef {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
}

/** A recorded notification as the bell consumes it. */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** Outcome line — `subject + verb`. */
  title: string;
  /** Detail / why / next step. */
  description?: string;
  /** Originating workflow name (for the label kicker). */
  source?: string;
  /** Operator subject (person name / filename), when distinct from the title. */
  subject?: string;
  /** Deep-link target for the card. */
  entityRef?: NotificationEntityRef;
  /** Greppable trace code for the card footer (`data.__traceId`). */
  traceId?: string;
  /** Collapses repeats of the same event for the same row. */
  dedupeKey?: string;
  /** Epoch ms the notification was recorded. */
  ts: number;
  /** When true (and `entityRef` set), the card offers an inline Re-run. */
  rerunnable?: boolean;
}

/** Default dedupe key: one card per (row, kind). */
export function defaultDedupeKey(kind: string, ref?: NotificationEntityRef): string | undefined {
  if (!ref) return undefined;
  return `${ref.workflow}:${ref.id}:${ref.runId ?? ""}:${kind}`;
}

// ── Pure list operations (unit-tested) ─────────────────────────────────────

/** Max notifications retained in the in-memory store. */
export const NOTIFICATION_CAP = 100;

/**
 * Insert `n` into `list`: drop any prior entry sharing its `dedupeKey`, prepend,
 * sort newest-first, and cap. Pure — the store calls this on every record.
 */
export function mergeNotification(
  list: AppNotification[],
  n: AppNotification,
  cap = NOTIFICATION_CAP,
): AppNotification[] {
  const withoutDup = n.dedupeKey ? list.filter((x) => x.dedupeKey !== n.dedupeKey) : list;
  const next = [n, ...withoutDup].sort((a, b) => b.ts - a.ts);
  return next.length > cap ? next.slice(0, cap) : next;
}

/**
 * Merge two lists (live store + `/api/failures` backfill) into one feed.
 * `primary` wins on a collision (same `dedupeKey`, else same `id`) so a live
 * record supersedes its backfilled twin. Newest-first, capped.
 */
export function mergeNotificationLists(
  primary: AppNotification[],
  secondary: AppNotification[],
  cap = NOTIFICATION_CAP,
): AppNotification[] {
  const seen = new Set<string>();
  const out: AppNotification[] = [];
  for (const n of [...primary, ...secondary]) {
    const key = n.dedupeKey ?? n.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.length > cap ? out.slice(0, cap) : out;
}

/** Count entries newer than the `lastSeenAt` watermark (epoch ms). */
export function countUnread(list: AppNotification[], lastSeenAt: number): number {
  return list.reduce((c, n) => (n.ts > lastSeenAt ? c + 1 : c), 0);
}

// ── In-memory store (module-scope; one global feed) ─────────────────────────

let store: AppNotification[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Subscribe to store changes (for `useSyncExternalStore`). */
export function subscribeNotifications(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Current store snapshot — referentially stable until the next record. */
export function getNotificationsSnapshot(): AppNotification[] {
  return store;
}

/** Append a fully-formed notification to the store. Prefer `notify()`. */
export function recordNotification(n: AppNotification): void {
  store = mergeNotification(store, n);
  emit();
}

/** Test helper — clear the store. */
export function __resetNotifications(): void {
  store = [];
  emit();
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `ntf-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function toastBySeverity(
  severity: NotificationSeverity,
  title: string,
  opts: ExternalToast,
): string | number {
  switch (severity) {
    case "success":
      return toast.success(title, opts);
    case "warning":
      return toast.warning(title, opts);
    case "error":
      return toast.error(title, opts);
    case "message":
      return toast.message(title, opts);
    case "info":
    default:
      return toast.info(title, opts);
  }
}

// ── The single entry point ──────────────────────────────────────────────────

export interface NotifySpec {
  kind: NotificationKind;
  /** Override the kind's default severity (rare). */
  severity?: NotificationSeverity;
  title: string;
  description?: string;
  source?: string;
  subject?: string;
  entityRef?: NotificationEntityRef;
  traceId?: string;
  /** Override the default `<workflow>:<id>:<runId>:<kind>` dedupe key. */
  dedupeKey?: string;
  rerunnable?: boolean;
  /** Show a transient toast. Default true. */
  toast?: boolean;
  /** Record in the notification center. Default true. */
  inbox?: boolean;
  /** Extra sonner options merged into the toast (icon, action, duration, id). */
  toastOptions?: ExternalToast;
}

/**
 * Record an inbox-worthy event: push it to the notification center AND fire a
 * toast. Returns the toast id (so a `loading → notify` resolve can reuse it via
 * `toastOptions.id`). Set `toast:false` to record silently or `inbox:false` to
 * toast without keeping it.
 */
export function notify(spec: NotifySpec): string | number | undefined {
  const severity = severityForKind(spec.kind, spec.severity);
  const dedupeKey = spec.dedupeKey ?? defaultDedupeKey(spec.kind, spec.entityRef);

  if (spec.inbox !== false) {
    recordNotification({
      id: makeId(),
      kind: spec.kind,
      severity,
      title: spec.title,
      description: spec.description,
      source: spec.source,
      subject: spec.subject,
      entityRef: spec.entityRef,
      traceId: spec.traceId,
      dedupeKey,
      ts: Date.now(),
      rerunnable: spec.rerunnable,
    });
  }

  if (spec.toast === false) return spec.toastOptions?.id;
  const opts: ExternalToast = { description: spec.description, ...spec.toastOptions };
  return toastBySeverity(severity, spec.title, opts);
}

/** Subscribe a component to the live notification feed. */
export function useNotificationFeed(): AppNotification[] {
  return useSyncExternalStore(
    subscribeNotifications,
    getNotificationsSnapshot,
    getNotificationsSnapshot,
  );
}
