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
// Design constraints:
//   * MUST NOT throw. Any error path is swallowed.
//   * MUST NOT block the caller meaningfully. Hard 5s fetch timeout.
//   * Fire-and-forget — caller doesn't await.

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
      await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch {
      // Swallow — auth notification failure must never fail a workflow.
    }
  };
}

/**
 * Render an AuthEvent into a short HTML-formatted Telegram message. Pure
 * function — exported for unit-test access. Real implementation lands in
 * the next task; this is the minimal stub the env-gating tests need.
 */
export function formatAuthEventMessage(ev: AuthEvent): string {
  return `${ev.kind} ${ev.systemLabel} ${ev.workflow}`;
}
