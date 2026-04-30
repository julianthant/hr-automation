# Auth Module

Five independent login flows for UCSD systems. Each system uses different SSO/auth — never share browser sessions between them.

Kernel workflows invoke these via `SystemConfig.login` in `defineWorkflow({ systems: [...] })`:

```ts
systems: [{
  id: "ucpath",
  login: async (page) => {
    const ok = await loginToUCPath(page);
    if (!ok) throw new Error("UCPath authentication failed");
  },
}],
```

`Session.launch` in `src/core/session.ts` calls each `login` in the configured `authChain` order (sequential or interleaved) with 3-attempt retry.

## Files

- `login.ts` — All login flows: `loginToUCPath`, `loginToACTCrm`, `loginToUKG` (split into `ukgNavigateAndFill` + `ukgSubmitAndWaitForDuo`), `loginToKuali`, `loginToNewKronos`
- `duo-poll.ts` — `pollDuoApproval(page, options)` — unified Duo polling loop with URL match, successCheck, postApproval, recovery callbacks, and optional `systemLabel` for the voice-cue + Telegram hooks
- `voice-cue.ts` — `cueDuo(systemId)` — best-effort macOS voice cue ("Duo for UCPath") spoken via `say` when `HR_AUTOMATION_VOICE_CUES=1`. No-op on non-darwin or when the env var is unset. Per-systemId 30s cooldown prevents rapid duplicates across auth retries. Never throws. `pollDuoApproval` calls this once per auth attempt before the polling loop starts
- `telegram-notify.ts` — `notifyAuthEvent(ev)` — best-effort Telegram DM via Bot API on Duo `waiting` / `approved` / `timeout` / `resent`. Activated only when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are both in env; no-op otherwise. Mirrors `voice-cue.ts` (factory `createTelegramNotifier` + default instance, never throws). Workflow + runId pulled from `AsyncLocalStorage` log context so messages name the kernel item without per-call-site plumbing
- `session.ts` — `isOnAuthenticatedPage(page)` — URL-based check for ACT CRM auth state (not session persistence)
- `types.ts` — `LoginOptions` (fresh flag), `AuthResult` (ucpath/actCrm booleans)

## Login Flows

| Function | System | Duo? | Session Persistence? | Timeout |
|----------|--------|------|---------------------|---------|
| `loginToUCPath` | UCPath PeopleSoft | Yes (180s) | No | 10-15s nav |
| `loginToACTCrm` | Salesforce CRM | Yes (60s) | No | 15s nav |
| `loginToUKG` | UKG Kronos | Yes (180s) | Yes (sessionDir) | 60s nav |
| `loginToKuali` | Kuali Build | Yes (180s) | No | 10s nav |
| `loginToNewKronos` | WFD Kronos | Yes (180s) | No | 10s nav |

## Selector Pattern

All UCSD SSO forms use 3-level fallback selectors:
1. Accessibility label (e.g., `"User name (or email address)"`)
2. Alternate label (e.g., `"Username"`)
3. HTML attribute (e.g., `input[name="j_username"]`)

Submit button: always `button[name="_eventId_proceed"]` (avoids collision with "Enroll in Two-Step Login" nav link).

## Gotchas

- **Duo MFA is manual** — automation pauses and polls for user phone approval
- **Duo serialization** — historically all sessions submitted Duo prompts strictly sequentially because simultaneous prompts collided. As of 2026-04-27 the kernel supports `authChain: "parallel-staggered"` which spaces submits 5s apart and lets prompts overlap; separations uses this mode. If a workflow needs guaranteed serialization (slow Duo provider, customer-policy reason, regression on the staggered path), keep `authChain: "sequential"` or `"interleaved"`
- UCPath may redirect back to campus discovery page after Duo — retry loop (3x) handles this
- UKG `ukgNavigateAndFill` returns `true | false | "already_logged_in"` (string return for persistent session detection)
- UKG is the only flow with network error retry logic (5s backoff for transient errors)
- ACTCrm may land on `act-crm.my.site.com` OR `crm.ucsd.edu` after Duo — both are checked
- Debug screenshots saved to `.auth/debug-*.png` (ACTCrm flow only)
- "Enroll in Two-Step Login" nav link has `role="button"` containing "Login" — causes selector collisions if not using `button[name=...]`

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and system)*

## Lessons Learned

- **2026-04-10: Duo pollDuoApproval auto-retry on timeout** — Duo MFA can time out if the user doesn't approve in time (e.g. phone not nearby). `pollDuoApproval` now auto-retries on timeout by clicking the "Try Again" button in the Duo iframe. This avoids the entire workflow failing because of a single missed Duo prompt.
- **2026-04-28: Telegram bot for remote Duo approval.** Hooked into `pollDuoApproval` at four points (`duo-waiting` after `cueDuo`, `duo-resent` in the Try-Again branch, `duo-approved` in the success branch, `duo-timeout` after the loop exhausts) so every login flow benefits without per-flow opt-in. `notifyAuthEvent` reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` live from `process.env` on each call so dotenv reload mid-process picks up new values. Workflow + runId pulled from the log ALS via `getLogWorkflow()` / `getLogRunId()`. Auto-discovered `chat_id` via `/getUpdates` during the `npm run setup:telegram` wizard; phone number isn't stored in code or env — only the chat_id lives in `.env`. Token + chat_id required; missing either var → silent no-op (so unconfigured operators aren't blocked). Best-effort fire-and-forget — every error path swallowed; 5 s `AbortSignal.timeout` so a slow Telegram never blocks polling.
- **2026-04-29: Pre-announce grace window suppresses cached-trust false positives.** Original `pollDuoApproval` fired `cueDuo` + `emitTelegram("duo-waiting")` + `log.waiting` unconditionally at the top of the function, before checking page state. With Duo's "Yes, this is my device" trust token cached, the SAML chain redirects straight to the success URL without pushing to Duo Mobile — so the operator got a Telegram message claiming a Duo prompt that never actually went to their phone. Fix: a silent pre-check loop runs first (default `DUO_PRE_CHECK_MS = 2000ms`, sampled every `DUO_PRE_CHECK_INTERVAL_MS = 500ms`), checking only `urlMatches` + optional `successCheck`. If the URL transitions to success during that window, log `"Duo skipped (cached trust)"` and return — no voice cue, no Telegram, no waiting log. If the window elapses without auto-success, the announce phase fires and the main poll loop runs as before. Tunable via `preCheckMs` / `preCheckIntervalMs` on `DuoPollOptions`; set `preCheckMs: 0` to restore legacy "notify immediately" behavior. Tradeoff: real Duo notifications arrive ≤2 s later than before, which is well below the user-perceptible threshold for "phone buzzes vs. operator looks at dashboard." Slow networks (cached pass-through > 2 s) still produce a false-positive Telegram, but this is now rare instead of universal.
