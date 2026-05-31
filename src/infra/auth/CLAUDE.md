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

`Session.launch` in `src/core/kernel/session.ts` calls each `login` with 3-attempt retry. There is one global auth strategy — no per-workflow `authChain` knob:

- **1 system** → fast path: `bringToFront` → `login` → done. No settle, no stagger.
- **≥2 systems** → **parallel-staggered with concurrency cap**:
  1. Every system's SSO form is navigated + filled in parallel via the optional `prepareLogin` hook (see `kualiNavigateAndFill`, `ucpathNavigateAndFill` etc.).
  2. After all forms are filled, a `settleMs` pause (default **2000 ms**) before the first Submit click — gives the operator a moment to look at the phone.
  3. Submit clicks fire with a `staggerMs` gap (default **5000 ms**) between each, so Duo push notifications arrive evenly spaced (avoids the cached multi-prompt collision documented below).
  4. At most `maxConcurrentDuos` (default **1**) Duo pends at any moment. With ≥2 systems, additional ones wait until a slot frees on approval — the operator never sees more than 1 queued prompt on their phone.

Tuning knobs live on `LaunchOpts` (`staggerMs`, `settleMs`, `maxConcurrentDuos`) and are primarily for tests. Production callers don't pass them.

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
- **Duo serialization** — historically all sessions submitted Duo prompts strictly sequentially because simultaneous prompts collided. The kernel now uses one global parallel-staggered chain for any ≥2-system workflow (5s submit gap, 2s pre-submit settle, 1-Duo concurrency cap). The legacy `authChain` field was removed on 2026-05-27 — there is no opt-out per workflow; tuning lives on `LaunchOpts` for tests.
- UCPath may redirect back to campus discovery page after Duo — retry loop (3x) handles this
- UKG `ukgNavigateAndFill` returns `true | false | "already_logged_in"` (string return for persistent session detection)
- UKG is the only flow with network error retry logic (5s backoff for transient errors)
- ACTCrm may land on `act-crm.my.site.com` OR `crm.ucsd.edu` after Duo — both are checked
- Debug screenshots saved to `.auth/debug-*.png` (ACTCrm flow only)
- "Enroll in Two-Step Login" nav link has `role="button"` containing "Login" — causes selector collisions if not using `button[name=...]`

## Lessons Learned

- **2026-04-10: Duo pollDuoApproval auto-retry on timeout** — Duo MFA can time out if the user doesn't approve in time (e.g. phone not nearby). `pollDuoApproval` now auto-retries on timeout by clicking the "Try Again" button in the Duo iframe. This avoids the entire workflow failing because of a single missed Duo prompt.
- **2026-04-28: Telegram bot for remote Duo approval.** Hooked into `pollDuoApproval` at four points (`duo-waiting` after `cueDuo`, `duo-resent` in the Try-Again branch, `duo-approved` in the success branch, `duo-timeout` after the loop exhausts) so every login flow benefits without per-flow opt-in. `notifyAuthEvent` reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` live from `process.env` on each call so dotenv reload mid-process picks up new values. Workflow + runId pulled from the log ALS via `getLogWorkflow()` / `getLogRunId()`. Auto-discovered `chat_id` via `/getUpdates` during the `npm run setup:telegram` wizard; phone number isn't stored in code or env — only the chat_id lives in `.env`. Token + chat_id required; missing either var → silent no-op (so unconfigured operators aren't blocked). Best-effort fire-and-forget — every error path swallowed; 5 s `AbortSignal.timeout` so a slow Telegram never blocks polling.
- **2026-04-29: Pre-announce grace window suppresses cached-trust false positives.** Original `pollDuoApproval` fired `cueDuo` + `emitTelegram("duo-waiting")` + `log.waiting` unconditionally at the top of the function, before checking page state. With Duo's "Yes, this is my device" trust token cached, the SAML chain redirects straight to the success URL without pushing to Duo Mobile — so the operator got a Telegram message claiming a Duo prompt that never actually went to their phone. Fix: a silent pre-check loop runs first (default `DUO_PRE_CHECK_MS = 2000ms`, sampled every `DUO_PRE_CHECK_INTERVAL_MS = 500ms`), checking only `urlMatches` + optional `successCheck`. If the URL transitions to success during that window, log `"Duo skipped (cached trust)"` and return — no voice cue, no Telegram, no waiting log. If the window elapses without auto-success, the announce phase fires and the main poll loop runs as before. Tunable via `preCheckMs` / `preCheckIntervalMs` on `DuoPollOptions`; set `preCheckMs: 0` to restore legacy "notify immediately" behavior. Tradeoff: real Duo notifications arrive ≤2 s later than before, which is well below the user-perceptible threshold for "phone buzzes vs. operator looks at dashboard." Slow networks (cached pass-through > 2 s) still produce a false-positive Telegram, but this is now rare instead of universal.
- **2026-05-15: SSO field selectors are inline in `fillSsoCredentials`.** The old selector getter was removed; keep the 3-level fallback chains directly beside the fill operations so the selector order and behavior stay obvious. If the selector set changes, test the login behavior or the fallback chain through `fillSsoCredentials`, not a detached getter.
- **2026-05-27: Global auth chain — `authChain` field deleted.** The kernel had three modes (`sequential`, `interleaved`, `parallel-staggered`) selectable per workflow. As of 2026-05-27 the field is gone and `Session.launch` always uses one strategy: 1-system fast path, ≥2-system parallel-staggered with cap=1 + settle=2s + stagger=5s. Migration was mechanical (`authChain: "sequential"` lines removed from every workflow file) — there is no path back. If a workflow legitimately needs strict serialization in the future, restore the field on `WorkflowConfig` + the `sequential` branch in `Session.launch` rather than working around it in the handler.
- **2026-05-27: Global auth queue cap reduced to one.** The default `LaunchOpts.maxConcurrentDuos` is now 1, so production multi-system auth keeps only one Duo prompt pending at a time. Tests may still pass `maxConcurrentDuos > 1` to exercise the semaphore path, but production callers should continue omitting the knob unless the operator intentionally wants concurrent phone prompts.
