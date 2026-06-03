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

> **Full reference:** [`docs/engineering/hands-off-duo-webauthn.md`](../../../docs/engineering/hands-off-duo-webauthn.md)
> — enrollment, the two-phase factor model, the six Duo flows, testing, and a
> failure-modes table. Read it before debugging a hands-off Duo issue.

`HR_AUTOMATION_DUO_WEBAUTHN=1` makes every login approve Duo automatically with
no phone push, using credentials enrolled once as independent Duo security keys.
**Chromium-only**, entirely opt-in, and always falls back to manual Duo on any
failure.

Critical invariants (full detail + failure-modes table in the reference doc):

- **Three steps, armed early.** `armDuoWebAuthn` (one CDP authenticator per
  transport + CTAP2 shim for CRM) / `beginDuoWebAuthn` (factor select) /
  `finishDuoWebAuthn` (persist signCount + tear down). Armed at **`clickSsoSubmit`**
  (before the prompt — CRM auto-fires on load), reused in `pollDuoApproval`,
  finished on **every** exit path.
- **Two factors — UCPath rejects the security key.** Touch ID (`internal`) for most
  apps; ACT CRM offers **only** a security key (`usb`). Preference is Touch ID
  first, security key fallback (security-key-first makes UCPath `/error`).
- **⚠️ `selectDuoFactor` is two-phase — never click during the auto-fire.** Duo
  auto-fires the ceremony on load; the authenticator answers it with no click
  (**Phase 1** grace — wait for `hasSigned` / the trust screen, *don't touch the
  prompt*). Clicking "Other options" mid-ceremony **aborts it → UCPath `/error`**.
  **Phase 2** (Escape + "Other options" → factor) is for CRM. Gate "auto" on
  `hasSigned`, **not** the URL (pre-prompt the page is still on `a5.ucsd.edu`).
  Never reload the prompt (desyncs Duo's challenge).
- **signCount is load-bearing.** Persisted monotonically on every exit. A
  force-killed run desyncs it → Duo rejects the next assertion as a clone ("signs
  but never completes", prompt hangs on "Use Touch ID"). Resync by bumping every
  counter in `.auth/duo-webauthn.json` (e.g. to 1000). Production never hits this —
  only aggressive manual testing that `kill -9`s a run mid-ceremony does.
- **Enroll:** `npm run duo:webauthn:enroll` (`--security-key` for a usb device).
  **Secret:** `.auth/duo-webauthn.json` (EC P-256 private keys) is gitignored —
  never commit or log it.

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

- **2026-06-02: Hands-off Duo verified live across all six SSO flows — see the [reference doc](../../../docs/engineering/hands-off-duo-webauthn.md) §6 for the full failure-modes table.** `HR_AUTOMATION_DUO_WEBAUTHN=1 npm run test-login --all` confirmed all six (UCPath, CRM, UKG, Kuali, New Kronos, ServiceNow) approve hands-off. Three bugs found+fixed: UKG bypassed `clickSsoSubmit` (no early-arm) → routed through it; ServiceNow bailed on the `auth_redirect.do` SAML interstitial before the form rendered → `waitForSsoForm` polls for it; UCPath was racy (next lesson). i9 is **not** Duo (plain email/password). The handoff's "verified" was a single lucky run — **always sweep `--all` twice**.
- **2026-06-02: UCPath — never interrupt the Duo auto-fire; keep signCount ahead.** UCPath auto-fires the Touch ID ceremony on prompt load and the pre-armed authenticator answers it with **no click**. The old `selectDuoFactor` clicked "Other options" mid-ceremony, aborting it → `all_methods → /error` (UCPath rejects the security-key fallback); it only worked when the auto-fire won the race (~1/3). Fix = two-phase `selectDuoFactor` (Phase 1 grace waits, no clicking; Phase 2 click-path is CRM-only). Two traps: (a) don't treat "off `duosecurity.com`" as success — pre-prompt the page is on `a5.ucsd.edu`; gate on `hasSigned`. (b) **signCount desync from `kill -9`'d test runs** makes Duo reject the next assertion as a clone ("signs but never completes"); resync by bumping the counters in `.auth/duo-webauthn.json` to e.g. 1000. Production exits cleanly so never hits this. Detail: [reference doc](../../../docs/engineering/hands-off-duo-webauthn.md).
- **2026-06-02: Hands-off Duo via a CDP WebAuthn virtual authenticator (`HR_AUTOMATION_DUO_WEBAUTHN=1`).** Replaces an abandoned attempt to read SMS passcodes from iMessage (UCPath's Duo prompt has no Text-message factor at app login). A virtual authenticator is enrolled once as an independent Duo security key (separate from the operator's 1Password/iCloud passkeys) and replayed at runtime so Duo approves with no phone push. Key gotchas discovered live: (1) **Chrome allows only one `internal` authenticator per environment** — must `WebAuthn.enable`→`disable`→`enable` to clear a dangling one before `addVirtualAuthenticator`, else it errors and you fall back to `usb`. (2) **Factor must match transport** — a `usb` authenticator cannot answer the platform "Touch ID" ceremony and vice-versa; the UCSD device enrolled as `internal`/Touch ID, so click "Touch ID". (3) If Duo auto-opens a "Use Touch ID" sub-screen before the authenticator is ready, the get() hangs — `selectDuoFactor` clicks **Back** to the factor list then re-clicks the factor to fire a fresh ceremony. (4) The virtual authenticator does **not** persist across separate processes/CDP sessions — setup + assert must be one session; the saved file holds only the exportable private key for re-seeding. Verified end-to-end: signed into the device-management portal hands-off; the device shows as "Touch ID (Chrome)". Integrated as a single opt-in block in `pollDuoApproval` with a 25s grace window and silent fallback to manual approval; flag-off behavior is byte-for-byte unchanged. **Extended 2026-06-02 to cover ACT CRM, which offers no Touch ID — only a security key.** Findings: (5) **Duo gates the security-key factor behind `PublicKeyCredential.isExternalCTAP2SecurityKeySupported()`, which is absent in Playwright Chromium** → Duo greys "Security key — Not supported in this browser". Fix: `ctap2SupportShim` forces it `true` (injected via `addInitScript` + `evaluate` whenever a `usb` credential is loaded). (6) A Touch ID (`internal`) credential **cannot** answer CRM's security-key request — it isn't in CRM's `allowCredentials`; a dedicated `usb` device must be enrolled (`--security-key`). (7) **CRM auto-fires a discoverable-passkey `get()` the instant its prompt loads** — *before* `pollDuoApproval` runs — so if the authenticator is set up there (after the prompt), Chrome has already shown a native "insert your security key" dialog that can't be dismissed from the page and **blocks the DOM click path**, and a late-added authenticator won't answer the pending request. Fix: **arm the authenticator at `clickSsoSubmit`** (the universal step right before the Duo prompt for every flow), not in `pollDuoApproval`. The module split into `armDuoWebAuthn` / `beginDuoWebAuthn` / `finishDuoWebAuthn` (page-keyed `WeakMap`) so `clickSsoSubmit` arms and `pollDuoApproval` reuses. The `usb` credential is stored **resident** (`hasResidentKey:true`) so the auto-fire *can* be answered; in practice the native dialog still appears, and `selectDuoFactor` recovers by pressing **Escape** to cancel it, then click-path "Other options" → `all_methods` → "Security key" + the "Yes, this is my device" trust click. **Never reload** the prompt — reloading desyncs Duo's challenge (signs but never completes). (8) The credential file is `{ credentials: [...] }` — arming sets up one authenticator **per transport** (`internal` first, since Chrome allows only one internal per environment). A **1.5s settle after revealing the options list** is required or `selectDuoFactor` clicks a factor mid-`all_methods`-navigation and Duo throws `/error` (the UCPath render race). (9) **A factor enrolled at the Duo account level is not accepted by every app's policy.** When the security key was made the *preferred* factor, a live `test-login` showed UCPath navigating `prompt → all_methods → /frame/v4/error` — UCPath rejects the security key — and the spent SAML challenge can't be recovered mid-flow (a Touch-ID retry needs a fresh navigation). So `selectDuoFactor` takes factors in **preference order, Touch ID first, security key only as the fallback**, and reveals the full options list before settling for the fallback so a default screen doesn't pre-empt the preferred factor. Net: UCPath → Touch ID, CRM → security key (its only factor). Do **not** force security-key-first; it breaks UCPath. **Verified end-to-end via `test-login` 2026-06-02: both hands-off, no phone push** — UCPath approved via Touch ID, CRM via Security key, signCounts advanced + persisted. signCounts are persisted per credential (monotonic max) on **every** `pollDuoApproval` exit path via `finishDuoWebAuthn`; after manual experiments (or an errored ceremony, which can advance the counter without persisting) bump the file above what Duo last observed or the next assert is rejected as a clone.
- **2026-04-10: Duo pollDuoApproval auto-retry on timeout** — Duo MFA can time out if the user doesn't approve in time (e.g. phone not nearby). `pollDuoApproval` now auto-retries on timeout by clicking the "Try Again" button in the Duo iframe. This avoids the entire workflow failing because of a single missed Duo prompt.
- **2026-04-29: Pre-announce grace window suppresses cached-trust false positives.** `pollDuoApproval` runs a silent pre-check loop first (default `DUO_PRE_CHECK_MS = 2000ms`, sampled every `DUO_PRE_CHECK_INTERVAL_MS = 500ms`), checking only `urlMatches` + optional `successCheck`. If the URL transitions to success during that window, log `"Duo skipped (cached trust)"` and return — no voice cue, no waiting log. If the window elapses without auto-success, the announce phase fires and the main poll loop runs as before. Tunable via `preCheckMs` / `preCheckIntervalMs` on `DuoPollOptions`; set `preCheckMs: 0` to announce immediately.
- **2026-06-02: Bot auth-event notifier removed.** The opt-in bot notification channel (env vars `BOT_TOKEN` / `CHAT_ID`) was retired entirely. The four call sites in `pollDuoApproval` (`duo-waiting`, `duo-resent`, `duo-approved`, `duo-timeout`) were removed along with the bot transport module, the `bot_sent` session event type, and the dashboard toast hook. Voice cue (`cueDuo`) and queue-status display remain. The in-dashboard "Duo prompt sent to phone" toast went away with it. Operators see Duo status in the queue row and hear the voice cue.
- **2026-05-15: SSO field selectors are inline in `fillSsoCredentials`.** The old selector getter was removed; keep the 3-level fallback chains directly beside the fill operations so the selector order and behavior stay obvious. If the selector set changes, test the login behavior or the fallback chain through `fillSsoCredentials`, not a detached getter.
- **2026-05-27: Global auth chain — `authChain` field deleted.** The kernel had three modes (`sequential`, `interleaved`, `parallel-staggered`) selectable per workflow. As of 2026-05-27 the field is gone and `Session.launch` always uses one strategy: 1-system fast path, ≥2-system parallel-staggered with cap=1 + settle=2s + stagger=5s. Migration was mechanical (`authChain: "sequential"` lines removed from every workflow file) — there is no path back. If a workflow legitimately needs strict serialization in the future, restore the field on `WorkflowConfig` + the `sequential` branch in `Session.launch` rather than working around it in the handler.
- **2026-05-27: Global auth queue cap reduced to one.** The default `LaunchOpts.maxConcurrentDuos` is now 1, so production multi-system auth keeps only one Duo prompt pending at a time. Tests may still pass `maxConcurrentDuos > 1` to exercise the semaphore path, but production callers should continue omitting the knob unless the operator intentionally wants concurrent phone prompts.
