// Best-effort Telegram bot notifier for auth events.
//
// When a workflow waits on Duo MFA, the operator may be away from their
// computer. A short message via Telegram tells them which website / workflow
// is waiting so they can approve from their phone.
//
// Activation: BOTH `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars must
// be set. Either missing → silent no-op (so unconfigured operators aren't
// blocked).
//
// On a successful POST to Telegram, emits a `telegram_sent` session event
// so the dashboard can surface a toast in the operator's browser. This
// event is fire-and-forget too — failure to write to sessions.jsonl
// doesn't fail the notification.
//
// Design constraints:
//   * MUST NOT throw. Any error path is swallowed.
//   * MUST NOT block the caller meaningfully. Hard 5s fetch timeout.
//   * Fire-and-forget — caller doesn't await.

import { emitSessionEvent, workflowNameFromInstance } from "../../tracker/session-events.js";
import { getLogWorkflow, log } from "../../utils/log.js";
import { renderTelegramNotification } from "./render.js";

export type AuthEventKind =
  | "duo-waiting"
  | "duo-approved"
  | "duo-timeout"
  | "duo-resent";

export interface AuthEvent {
  kind: AuthEventKind;
  /** Human label of the website being authenticated, e.g. "UCPath", "CRM". */
  systemLabel: string;
  /** Workflow name from the kernel registry, e.g. "oath-signature". */
  workflow: string;
  /** Optional runId for cross-referencing the dashboard. */
  runId?: string;
  /** Optional free-form line appended after the standard fields. */
  detail?: string;
  /** Optional workflow instance label (e.g. "Oath Signature 1"). When set,
   * recorded as the `telegram_sent` session event's `workflowInstance`;
   * otherwise falls back to the workflow name. */
  instance?: string;
  /** Human subject such as "Separation 3930" or "Oath Signature EID 00123456". */
  subject?: string;
}

export type FetchFn = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const TELEGRAM_API = "https://api.telegram.org";
const FETCH_TIMEOUT_MS = 5_000;

export interface CreateTelegramNotifierOptions {
  fetchFn?: FetchFn;
  /** Env value for TELEGRAM_BOT_TOKEN — falsy disables the notifier. */
  tokenValue?: string;
  /** Env value for TELEGRAM_CHAT_ID — falsy disables the notifier. */
  chatIdValue?: string;
  /** Override the directory for `telegram_sent` session-event writes.
   * Defaults to the tracker DEFAULT_DIR. Tests pass a tmpdir so a 200-OK
   * recorder fetchFn doesn't pollute `.tracker/sessions.jsonl`. */
  dir?: string;
}

/**
 * Factory: build a `notifyAuthEvent` function with injectable env + fetch.
 * Tests use this with a recording `fetchFn`; production uses the default
 * instance below (which reads `process.env` live on each call).
 */
export function createTelegramNotifier(
  opts: CreateTelegramNotifierOptions = {},
): (ev: AuthEvent) => Promise<void> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchFn);
  const tokenValue = opts.tokenValue;
  const chatIdValue = opts.chatIdValue;
  const dir = opts.dir;

  return async function notifyAuthEvent(ev: AuthEvent): Promise<void> {
    try {
      if (!tokenValue || !chatIdValue) return;

      const normalized = normalizeAuthEventForTelegram(ev);
      const text = formatAuthEventMessage(normalized);
      log.step(`Telegram notification send: ${JSON.stringify({
        kind: normalized.kind,
        systemLabel: normalized.systemLabel,
        workflow: normalized.workflow,
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.instance ? { instance: normalized.instance } : {}),
        ...(normalized.subject ? { subject: normalized.subject } : {}),
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        text,
      })}`);
      const url = `${TELEGRAM_API}/bot${tokenValue}/sendMessage`;
      const body = JSON.stringify({
        chat_id: chatIdValue,
        text,
        parse_mode: "HTML",
      });
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      });
      // Surface in the dashboard only on actual API success — a 4xx/5xx
      // means the operator did not get a message, so a toast claiming we
      // sent one would be misleading.
      if (res.ok) {
        try {
          emitSessionEvent(
            {
              type: "telegram_sent",
              workflowInstance:
                normalized.instance || normalized.workflow || getLogWorkflow() || "unknown",
              data: {
                kind: normalized.kind,
                systemLabel: normalized.systemLabel,
                workflow: normalized.workflow,
                ...(normalized.detail ? { detail: normalized.detail } : {}),
                ...(normalized.subject ? { subject: normalized.subject } : {}),
              },
            },
            dir,
          );
        } catch {
          // Telemetry is best-effort.
        }
      }
    } catch {
      // Swallow — auth notification failure must never fail a workflow.
    }
  };
}

export function normalizeAuthEventForTelegram(ev: AuthEvent): AuthEvent {
  if (ev.workflow && ev.workflow !== "(unknown)") return ev;
  const workflow = ev.instance ? workflowNameFromInstance(ev.instance) : null;
  return workflow ? { ...ev, workflow } : ev;
}

const KIND_HEADER: Record<AuthEventKind, string> = {
  "duo-waiting": "🔐  Duo prompt",
  "duo-approved": "✅  Duo approved",
  "duo-timeout": "⌛  Duo timed out",
  "duo-resent": "🔄  Duo push resent",
};

/**
 * Render an AuthEvent into a short HTML-formatted Telegram message. Pure
 * function — exported for unit-test access. The HTML escaping covers the
 * three chars Telegram's HTML parse_mode treats specially (`& < >`); other
 * Unicode passes through.
 */
export function formatAuthEventMessage(ev: AuthEvent): string {
  return renderTelegramNotification({
    title: KIND_HEADER[ev.kind],
    subject: ev.subject,
    workflow: ev.workflow,
    systemLabel: ev.systemLabel,
    detail: ev.detail,
    runId: ev.runId,
    includeDebugIds: false,
  });
}

/**
 * Public entry point. Reads `process.env` live on each call so changes to
 * env vars (tests, dotenv reload) take effect without re-importing.
 */
export async function notifyAuthEvent(ev: AuthEvent): Promise<void> {
  return createTelegramNotifier({
    tokenValue: process.env.TELEGRAM_BOT_TOKEN,
    chatIdValue: process.env.TELEGRAM_CHAT_ID,
  })(ev);
}
