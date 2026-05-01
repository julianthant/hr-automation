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

import { emitSessionEvent } from "../tracker/session-events.js";
import { getLogWorkflow } from "../utils/log.js";

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

      const text = formatAuthEventMessage(ev);
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
                ev.instance || ev.workflow || getLogWorkflow() || "unknown",
              data: {
                kind: ev.kind,
                systemLabel: ev.systemLabel,
                workflow: ev.workflow,
                ...(ev.detail ? { detail: ev.detail } : {}),
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

const KIND_HEADER: Record<AuthEventKind, string> = {
  "duo-waiting": "🔐  Duo prompt",
  "duo-approved": "✅  Duo approved",
  "duo-timeout": "⌛  Duo timed out",
  "duo-resent": "🔄  Duo push resent",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render an AuthEvent into a short HTML-formatted Telegram message. Pure
 * function — exported for unit-test access. The HTML escaping covers the
 * three chars Telegram's HTML parse_mode treats specially (`& < >`); other
 * Unicode passes through.
 */
export function formatAuthEventMessage(ev: AuthEvent): string {
  const lines: string[] = [];
  lines.push(`${KIND_HEADER[ev.kind]} — <b>${escapeHtml(ev.systemLabel)}</b>`);
  lines.push(`Workflow: <code>${escapeHtml(ev.workflow)}</code>`);
  if (ev.detail) lines.push(escapeHtml(ev.detail));
  if (ev.runId) lines.push(`Run: <code>${escapeHtml(ev.runId)}</code>`);
  return lines.join("\n");
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
