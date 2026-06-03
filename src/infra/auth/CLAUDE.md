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

Six UCSD Shibboleth SSO flows, all gated by Duo MFA and all sharing one auth
path: `fillSsoCredentials` → `clickSsoSubmit` → `pollDuoApproval` /
`requestDuoApproval`. They land on the same `a5.ucsd.edu` Duo prompt, so the
hands-off WebAuthn path (below) covers every one of them identically.

| Function | System | Duo? | Session Persistence? | Timeout |
|----------|--------|------|---------------------|---------|
| `loginToUCPath` | UCPath PeopleSoft | Yes (180s) | No | 10-15s nav |
| `loginToACTCrm` | Salesforce CRM | Yes (60s) | No | 15s nav |
| `loginToUKG` | UKG Kronos (OldKronos) | Yes (180s) | Yes (sessionDir) | 60s nav |
| `loginToKuali` | Kuali Build | Yes (180s) | No | 10s nav |
| `loginToNewKronos` | WFD Kronos | Yes (180s) | No | 10s nav |
| `loginToServiceNow` | ServiceNow HR (support.ucsd.edu) | Yes (300s) | No | 15s nav |

**Not Duo:** `loginToI9` (`src/systems/i9/login.ts`) authenticates to i9 Complete
(third-party Mitratech vendor) with plain email/password — no Shibboleth, no Duo,
so the WebAuthn path does not apply to it.

**Smoke test:** `npm run test-login` (default UCPath + CRM). Add `--all` to sweep
every Duo flow, or `--systems ucpath,kuali,ukg,…` for a subset; each runs in a
fresh browser with a per-system pass/fail table. Prefix with
`HR_AUTOMATION_DUO_WEBAUTHN=1` to verify hands-off approval across all of them.

## Hands-off Duo via WebAuthn (opt-in)

`HR_AUTOMATION_DUO_WEBAUTHN=1` makes every login approve Duo automatically with
no phone push, using credentials enrolled once as independent Duo security keys.
**Chromium-only**, entirely opt-in, and always falls back to manual Duo on any
failure.

- **Module:** `duo-webauthn.ts`. Split into three exported steps:
  `armDuoWebAuthn(page)` (set up authenticators+shim), `beginDuoWebAuthn(page)`
  (select the factor, returns a handle), and `finishDuoWebAuthn(page)` (persist
  signCount + tear down). The page's armed state is cached in a `WeakMap`.
- **Arm BEFORE the prompt — at `clickSsoSubmit`, not in `pollDuoApproval`.** ACT
  CRM auto-fires a discoverable passkey request the instant its prompt renders;
  if no virtual authenticator exists yet, Chrome shows a native "insert your
  security key" dialog that **can't be dismissed from the page and blocks the DOM
  click path**, and a later-added authenticator won't answer the already-pending
  request. So `clickSsoSubmit` (the universal step right before the Duo prompt
  for every flow) calls `armDuoWebAuthn` when the flag is on. `pollDuoApproval`'s
  WebAuthn block then *reuses* that armed authenticator (idempotent) for factor
  selection, and `finishDuoWebAuthn` runs on every exit path (cached-trust
  pre-check success, WebAuthn success/fail, manual success, timeout).
- **Two factors, because apps differ.** UCPath (and most apps) offer an
  `internal`/"Touch ID" platform factor; **ACT CRM offers only the `usb`/"Security
  key" factor.** `.auth/duo-webauthn.json` holds `{ credentials: [...] }` with one
  entry per device. Arming loads **all** of them and sets up one CDP virtual
  authenticator **per transport** (`internal` first — Chrome allows only one
  internal authenticator per environment). Factor preference is **Touch ID first,
  Security key fallback**: Touch ID is accepted hands-off across UCSD apps, and a
  security key registered at the Duo *account* level is **still rejected by some
  apps' policies** — UCPath returns a Duo `/error` page if the security key is
  chosen. So UCPath→Touch ID and CRM→Security key.
- **`selectDuoFactor` is two-phase — the auto-fire must NOT be interrupted.**
  Duo's v4 prompt **auto-fires** the WebAuthn ceremony on load; the pre-armed
  virtual authenticator answers it with **no click** and Duo redirects straight to
  the app (UCPath completes in ~3s). **Phase 1 (auto-fire grace, ~12s, no
  clicking):** wait for the authenticator to sign (`hasSigned`, a `getCredentials`
  signCount probe) or the "Yes, this is my device" trust screen, then return
  `"auto"`. Clicking "Other options" here **navigates away from the in-flight
  ceremony and aborts it** — UCPath then throws a Duo `/error` when a factor is
  picked on `all_methods`. Phase 1 bails to Phase 2 early **only** for CRM's
  roaming-key native dialog (it won't self-answer). **Phase 2 (explicit click
  path):** for CRM and any app whose auto-fire didn't land — Escape the native
  dialog → "Other options" → click the preferred factor (Touch ID first). Do
  **not** treat "not on `duosecurity.com`" as success inside the grace: the
  SSO→Duo redirect can still be in flight (page on `a5.ucsd.edu`, pre-prompt).
- **CTAP2 shim (required for CRM).** Duo only offers the security-key factor when
  `PublicKeyCredential.isExternalCTAP2SecurityKeySupported()` resolves true — and
  that method is **absent** in Playwright's bundled Chromium, so Duo greys it as
  "Not supported in this browser". `ctap2SupportShim` (injected via `addInitScript`
  + `evaluate` whenever a `usb` credential is loaded) forces it true.
- **CRM recovery path (no reload).** The `usb` credential is stored **resident**
  (discoverable, `hasResidentKey:true`) so the auto-fire *can* be answered; but
  when the native dialog is already up, `selectDuoFactor` presses **Escape** to
  cancel it, then clicks "Other options" → `all_methods` → "Security key" to fire
  a fresh in-session ceremony the authenticator answers, then waits for the
  "Yes, this is my device" trust click. A **1.5s settle after revealing the list**
  avoids the UCPath render race (clicking a factor mid-`all_methods`-navigation
  lands on a transitioning element → Duo `/error`). **Never reload** the prompt —
  reloading desyncs Duo's challenge (it signs but never completes).
- **Grace window:** `pollDuoApproval` waits `DUO_WEBAUTHN_GRACE_MS` (25s) for the
  success URL after the factor is selected; on timeout it falls through to the
  manual announce + poll (which still completes via phone).
- **Enrollment:** `npm run duo:webauthn:enroll` (`src/scripts/ops/duo-webauthn-enroll.ts`).
  Requires ONE manual Duo approval to reach the device portal, then drives
  "Add a device → Touch ID" against a virtual authenticator and **merges** the
  new credential into the file (keyed by transport, preserving the other device).
  `--security-key` enrolls a `usb` device (auto-injects the CTAP2 shim);
  `--name`/`--out` override.
- **signCount** is read back per credential after each assertion and persisted
  (monotonic max) so none ever appears to a verifier as a cloned key. After live
  experiments, bump the file's counters above what Duo last observed.
- **Secret:** `.auth/duo-webauthn.json` holds EC P-256 private keys — it is
  gitignored (`.auth/`). Never commit or log it.

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

- **2026-06-02: Hands-off Duo verified live across all six SSO flows — three fixes.** Swept every Duo flow with `HR_AUTOMATION_DUO_WEBAUTHN=1 npm run test-login --all`; all six (UCPath, CRM, UKG, Kuali, New Kronos, ServiceNow) approve hands-off, no phone push. Three issues found and fixed: **(1) UKG bypassed arming** — `ukgSubmitAndWaitForDuo` clicked `button[name="_eventId_proceed"]` directly instead of `clickSsoSubmit`, so it never early-armed (it still worked via `beginDuoWebAuthn`'s idempotent late-arm, but was the lone flow off the shared path). Routed through `clickSsoSubmit`. **(2) ServiceNow failed *before* Duo** — `loginToServiceNowFlow` did a one-shot `domcontentloaded` re-check and bailed on the `support.ucsd.edu/esc → auth_redirect.do → a5.ucsd.edu` SAML interstitial before the SSO form rendered (~1–2s later). Fixed with `waitForSsoForm` (polls for the submit button). **(3) UCPath was racy** — see the dedicated auto-fire lesson below. The CLAUDE.md table previously omitted **ServiceNow** (added). **i9 Complete is not a Duo flow** (`loginToI9` is plain email/password on third-party Mitratech), so the WebAuthn path never touches it. `test-login` now takes `--all` / `--systems <list>`.
- **2026-06-02: UCPath hands-off Duo — never interrupt the auto-fire, and keep signCount ahead.** UCPath's Duo v4 prompt **auto-fires** the platform (Touch ID) ceremony on load; the pre-armed virtual authenticator answers it with **no click** and Duo redirects to `UC_HOME` in ~3s (proven with an observe-only probe). The old `selectDuoFactor` clicked "Other options" eagerly, which **navigated away from the in-flight ceremony and aborted it** → `prompt → all_methods → /frame/v4/error` (UCPath rejects the security-key fallback). It only ever "worked" when the auto-fire happened to win the race — flaky (~1/3). Fix: split `selectDuoFactor` into **Phase 1 (auto-fire grace, ~12s, no clicking — wait for the authenticator to sign or the trust screen)** and **Phase 2 (click path, CRM only)**. Two traps hit while fixing it: **(a)** an early "if not on `duosecurity.com` → success" shortcut fired **pre-prompt** while the SSO→Duo redirect was still in flight (page on `a5.ucsd.edu`), returning a bogus success → 25s grace timeout. Gate on `hasSigned` (a `getCredentials` signCount probe), **not** the URL. **(b) signCount desync from force-killed test runs.** Each killed run signs (Duo observes counter+1) but `finishDuoWebAuthn` never persists, so the next run replays a counter Duo already saw → Duo silently **rejects the assertion as a clone** ("signs but never completes" — the ceremony hangs on "Use Touch ID"). This only happens when a run is `kill -9`'d mid-ceremony (production always exits cleanly via `finishDuoWebAuthn`). Remedy: bump every `signCount` in `.auth/duo-webauthn.json` well above anything Duo could have observed (e.g. to 1000), then re-test **without killing**. After resync + both Phase fixes, UCPath passed hands-off 4/4 solo and in two full `--all` sweeps.
- **2026-06-02: Hands-off Duo via a CDP WebAuthn virtual authenticator (`HR_AUTOMATION_DUO_WEBAUTHN=1`).** Replaces an abandoned attempt to read SMS passcodes from iMessage (UCPath's Duo prompt has no Text-message factor at app login). A virtual authenticator is enrolled once as an independent Duo security key (separate from the operator's 1Password/iCloud passkeys) and replayed at runtime so Duo approves with no phone push. Key gotchas discovered live: (1) **Chrome allows only one `internal` authenticator per environment** — must `WebAuthn.enable`→`disable`→`enable` to clear a dangling one before `addVirtualAuthenticator`, else it errors and you fall back to `usb`. (2) **Factor must match transport** — a `usb` authenticator cannot answer the platform "Touch ID" ceremony and vice-versa; the UCSD device enrolled as `internal`/Touch ID, so click "Touch ID". (3) If Duo auto-opens a "Use Touch ID" sub-screen before the authenticator is ready, the get() hangs — `selectDuoFactor` clicks **Back** to the factor list then re-clicks the factor to fire a fresh ceremony. (4) The virtual authenticator does **not** persist across separate processes/CDP sessions — setup + assert must be one session; the saved file holds only the exportable private key for re-seeding. Verified end-to-end: signed into the device-management portal hands-off; the device shows as "Touch ID (Chrome)". Integrated as a single opt-in block in `pollDuoApproval` with a 25s grace window and silent fallback to manual approval; flag-off behavior is byte-for-byte unchanged. **Extended 2026-06-02 to cover ACT CRM, which offers no Touch ID — only a security key.** Findings: (5) **Duo gates the security-key factor behind `PublicKeyCredential.isExternalCTAP2SecurityKeySupported()`, which is absent in Playwright Chromium** → Duo greys "Security key — Not supported in this browser". Fix: `ctap2SupportShim` forces it `true` (injected via `addInitScript` + `evaluate` whenever a `usb` credential is loaded). (6) A Touch ID (`internal`) credential **cannot** answer CRM's security-key request — it isn't in CRM's `allowCredentials`; a dedicated `usb` device must be enrolled (`--security-key`). (7) **CRM auto-fires a discoverable-passkey `get()` the instant its prompt loads** — *before* `pollDuoApproval` runs — so if the authenticator is set up there (after the prompt), Chrome has already shown a native "insert your security key" dialog that can't be dismissed from the page and **blocks the DOM click path**, and a late-added authenticator won't answer the pending request. Fix: **arm the authenticator at `clickSsoSubmit`** (the universal step right before the Duo prompt for every flow), not in `pollDuoApproval`. The module split into `armDuoWebAuthn` / `beginDuoWebAuthn` / `finishDuoWebAuthn` (page-keyed `WeakMap`) so `clickSsoSubmit` arms and `pollDuoApproval` reuses. The `usb` credential is stored **resident** (`hasResidentKey:true`) so the auto-fire *can* be answered; in practice the native dialog still appears, and `selectDuoFactor` recovers by pressing **Escape** to cancel it, then click-path "Other options" → `all_methods` → "Security key" + the "Yes, this is my device" trust click. **Never reload** the prompt — reloading desyncs Duo's challenge (signs but never completes). (8) The credential file is `{ credentials: [...] }` — arming sets up one authenticator **per transport** (`internal` first, since Chrome allows only one internal per environment). A **1.5s settle after revealing the options list** is required or `selectDuoFactor` clicks a factor mid-`all_methods`-navigation and Duo throws `/error` (the UCPath render race). (9) **A factor enrolled at the Duo account level is not accepted by every app's policy.** When the security key was made the *preferred* factor, a live `test-login` showed UCPath navigating `prompt → all_methods → /frame/v4/error` — UCPath rejects the security key — and the spent SAML challenge can't be recovered mid-flow (a Touch-ID retry needs a fresh navigation). So `selectDuoFactor` takes factors in **preference order, Touch ID first, security key only as the fallback**, and reveals the full options list before settling for the fallback so a default screen doesn't pre-empt the preferred factor. Net: UCPath → Touch ID, CRM → security key (its only factor). Do **not** force security-key-first; it breaks UCPath. **Verified end-to-end via `test-login` 2026-06-02: both hands-off, no phone push** — UCPath approved via Touch ID, CRM via Security key, signCounts advanced + persisted. signCounts are persisted per credential (monotonic max) on **every** `pollDuoApproval` exit path via `finishDuoWebAuthn`; after manual experiments (or an errored ceremony, which can advance the counter without persisting) bump the file above what Duo last observed or the next assert is rejected as a clone.
- **2026-04-10: Duo pollDuoApproval auto-retry on timeout** — Duo MFA can time out if the user doesn't approve in time (e.g. phone not nearby). `pollDuoApproval` now auto-retries on timeout by clicking the "Try Again" button in the Duo iframe. This avoids the entire workflow failing because of a single missed Duo prompt.
- **2026-04-28: Telegram bot for remote Duo approval.** Hooked into `pollDuoApproval` at four points (`duo-waiting` after `cueDuo`, `duo-resent` in the Try-Again branch, `duo-approved` in the success branch, `duo-timeout` after the loop exhausts) so every login flow benefits without per-flow opt-in. `notifyAuthEvent` reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` live from `process.env` on each call so dotenv reload mid-process picks up new values. Workflow + runId pulled from the log ALS via `getLogWorkflow()` / `getLogRunId()`. Auto-discovered `chat_id` via `/getUpdates` during the `npm run setup:telegram` wizard; phone number isn't stored in code or env — only the chat_id lives in `.env`. Token + chat_id required; missing either var → silent no-op (so unconfigured operators aren't blocked). Best-effort fire-and-forget — every error path swallowed; 5 s `AbortSignal.timeout` so a slow Telegram never blocks polling.
- **2026-04-29: Pre-announce grace window suppresses cached-trust false positives.** Original `pollDuoApproval` fired `cueDuo` + `emitTelegram("duo-waiting")` + `log.waiting` unconditionally at the top of the function, before checking page state. With Duo's "Yes, this is my device" trust token cached, the SAML chain redirects straight to the success URL without pushing to Duo Mobile — so the operator got a Telegram message claiming a Duo prompt that never actually went to their phone. Fix: a silent pre-check loop runs first (default `DUO_PRE_CHECK_MS = 2000ms`, sampled every `DUO_PRE_CHECK_INTERVAL_MS = 500ms`), checking only `urlMatches` + optional `successCheck`. If the URL transitions to success during that window, log `"Duo skipped (cached trust)"` and return — no voice cue, no Telegram, no waiting log. If the window elapses without auto-success, the announce phase fires and the main poll loop runs as before. Tunable via `preCheckMs` / `preCheckIntervalMs` on `DuoPollOptions`; set `preCheckMs: 0` to restore legacy "notify immediately" behavior. Tradeoff: real Duo notifications arrive ≤2 s later than before, which is well below the user-perceptible threshold for "phone buzzes vs. operator looks at dashboard." Slow networks (cached pass-through > 2 s) still produce a false-positive Telegram, but this is now rare instead of universal.
- **2026-05-15: SSO field selectors are inline in `fillSsoCredentials`.** The old selector getter was removed; keep the 3-level fallback chains directly beside the fill operations so the selector order and behavior stay obvious. If the selector set changes, test the login behavior or the fallback chain through `fillSsoCredentials`, not a detached getter.
- **2026-05-27: Global auth chain — `authChain` field deleted.** The kernel had three modes (`sequential`, `interleaved`, `parallel-staggered`) selectable per workflow. As of 2026-05-27 the field is gone and `Session.launch` always uses one strategy: 1-system fast path, ≥2-system parallel-staggered with cap=1 + settle=2s + stagger=5s. Migration was mechanical (`authChain: "sequential"` lines removed from every workflow file) — there is no path back. If a workflow legitimately needs strict serialization in the future, restore the field on `WorkflowConfig` + the `sequential` branch in `Session.launch` rather than working around it in the handler.
- **2026-05-27: Global auth queue cap reduced to one.** The default `LaunchOpts.maxConcurrentDuos` is now 1, so production multi-system auth keeps only one Duo prompt pending at a time. Tests may still pass `maxConcurrentDuos > 1` to exercise the semaphore path, but production callers should continue omitting the knob unless the operator intentionally wants concurrent phone prompts.
