# Hands-off Duo MFA via CDP WebAuthn

Reference for the opt-in feature that approves UCSD Duo MFA **with no phone push**
during Playwright logins, by replaying enrolled WebAuthn credentials through a
Chrome DevTools Protocol (CDP) **virtual authenticator**.

Enable with `HR_AUTOMATION_DUO_WEBAUTHN=1`. **Chromium-only**, entirely opt-in,
and it **always falls back to manual phone Duo** on any failure — flag-off
behavior is byte-for-byte unchanged.

> Source: `src/infra/auth/duo-webauthn.ts` (runtime), `src/infra/auth/duo-poll.ts`
> (integration), `src/infra/auth/sso-fields.ts` (arming), `src/scripts/ops/duo-webauthn-enroll.ts`
> (enrollment). Module-level gotchas + dated lessons live in `src/infra/auth/CLAUDE.md`.

---

## 1. The Duo surface — what this covers

Six UCSD Shibboleth SSO logins are gated by Duo MFA. They all land on the same
`a5.ucsd.edu` → `*.duosecurity.com` Duo Universal Prompt (v4 frameless), so one
shared WebAuthn path covers all of them:

| Login fn (`src/infra/auth/login.ts`) | System | App-offered factor | Verified hands-off |
|---|---|---|---|
| `loginToUCPath` | UCPath PeopleSoft | Touch ID (platform) | ✅ |
| `loginToACTCrm` | ACT CRM (Salesforce) | **Security key only** | ✅ |
| `loginToUKG` | UKG / OldKronos | Touch ID / security key | ✅ |
| `loginToKuali` | Kuali Build | Touch ID / security key | ✅ |
| `loginToNewKronos` | WFD / New Kronos | Touch ID / security key | ✅ |
| `loginToServiceNow` | ServiceNow HR (`support.ucsd.edu`) | Touch ID / security key | ✅ |

**Not in scope:** `loginToI9` (`src/systems/i9/login.ts`) authenticates to i9
Complete (third-party Mitratech) with **plain email/password — no Shibboleth, no
Duo**. The WebAuthn path never touches it.

All six route through the same steps: `fillSsoCredentials` → `clickSsoSubmit`
→ `pollDuoApproval` / `requestDuoApproval`.

---

## 2. Enrollment (one-time per device)

```bash
npm run duo:webauthn:enroll                 # enroll a Touch ID (internal) device
npm run duo:webauthn:enroll -- --security-key   # enroll a security key (usb) device
```

The script signs into `duo.ucsd.edu`, requires **one manual Duo approval** to
reach the device portal, then drives "Add a device → Touch ID" (or "Security
key") against a CDP virtual authenticator and **merges** the new credential into
`.auth/duo-webauthn.json`, keyed by transport (enrolling a 2nd device preserves
the 1st). Flags: `--security-key`, `--name "<label>"`, `--out <path>`.

**Two devices are required** because apps differ (see §4): UCPath accepts only
Touch ID; ACT CRM offers only a security key. `.auth/duo-webauthn.json` holds
`{ credentials: [ <internal>, <usb> ] }`.

> **Secret file.** `.auth/duo-webauthn.json` contains EC P-256 **private keys**.
> It is gitignored (`.auth/`). Never commit or log it. Verify with
> `git check-ignore .auth/duo-webauthn.json`.

---

## 3. How it works at runtime

```
clickSsoSubmit(page)            -> armDuoWebAuthn(page)   (if flag on; idempotent, WeakMap-cached)
   |                                 - one CDP virtual authenticator PER TRANSPORT
   |                                 - internal first (Chrome allows one internal authenticator/env)
   |                                 - inject CTAP2 shim if a usb cred is loaded
   v
(Duo prompt loads at *.duosecurity.com)
   v
pollDuoApproval(page, opts)
   - 2s pre-check: catch cached-trust pass-through silently
   - beginDuoWebAuthn -> selectDuoFactor (two phases, see §4) -> returns a handle
   - waitForApproval: up to DUO_WEBAUTHN_GRACE_MS (25s) for the success URL
   - on any miss -> manual phone Duo (cue + Telegram + poll), unchanged
   - finishDuoWebAuthn on EVERY exit path: persist signCount + tear down
```

**Arm at `clickSsoSubmit`, not in `pollDuoApproval`.** ACT CRM auto-fires a
discoverable passkey request the instant its prompt renders; if no authenticator
exists yet, Chrome shows a native "insert your security key" dialog that can't be
dismissed from the page and blocks the DOM click path. `clickSsoSubmit` is the
universal step right before the Duo prompt for **all six** flows, so it is the
arming point. `beginDuoWebAuthn` also late-arms (idempotent) as a safety net.

---

## 4. Factor selection — the two-phase model (`selectDuoFactor`)

Duo's v4 prompt **auto-fires** the WebAuthn ceremony on load. The behavior splits
the apps into two cases, and the selector has two phases to match:

### Phase 1 — auto-fire grace (NO clicking, ~12s)
For **platform / Touch ID** apps (UCPath, and the others when they offer Touch ID):
Duo auto-fires the platform `get()`; the pre-armed virtual authenticator answers
it **with no click** and Duo redirects to the app in ~3s. Phase 1 simply **waits**
for the authenticator to sign (a `WebAuthn.getCredentials` signCount probe) or for
the "Yes, this is my device" trust screen, then returns `"auto"`.

> ⚠️ **Do NOT click during Phase 1.** Clicking "Other options" navigates away from
> the in-flight ceremony and **aborts** it; UCPath then throws a Duo `/error` when
> a factor is picked on `all_methods` (UCPath rejects the security-key fallback).
> This was the single biggest source of UCPath flakiness — see §6.

### Phase 2 — explicit click path (CRM, or an auto-fire that didn't land)
For **security-key-only** apps (ACT CRM): the roaming-key auto-fire surfaces a
native dialog that won't self-answer. Phase 1 detects the "insert/use your
security key" text and bails to Phase 2, which presses **Escape** to cancel the
native dialog, clicks "Other options" → `all_methods` → the preferred factor
(Touch ID first, security key as fallback), then waits for the trust click.

Factor preference is **Touch ID first, security key fallback**: a security key
registered at the Duo *account* level is still **rejected by UCPath's policy**
(→ `/error`), so it must never pre-empt a working Touch ID.

### CTAP2 shim (required for CRM)
Duo only offers the security-key factor when
`PublicKeyCredential.isExternalCTAP2SecurityKeySupported()` resolves true — absent
in Playwright's Chromium. `ctap2SupportShim` (injected via `addInitScript` +
`evaluate` when a usb cred is loaded) forces it true.

---

## 5. Testing

```bash
# Default smoke test (UCPath + ACT CRM), MANUAL Duo:
npm run test-login

# Sweep EVERY Duo flow, each in a fresh browser, with a pass/fail table:
HR_AUTOMATION_DUO_WEBAUTHN=1 npm run test-login -- --all

# A subset:
HR_AUTOMATION_DUO_WEBAUTHN=1 npm run test-login -- --systems ucpath,kuali,servicenow
```

Valid system keys: `ucpath, crm, ukg, kuali, newkronos, servicenow`.

**Test all sites, multiple times.** The handoff that introduced this feature
"verified" it on a single lucky run that masked UCPath's auto-fire race and two
other flows that had never been exercised. Always run `--all` at least twice and
re-run the previously-flaky flow (UCPath) a few times solo.

---

## 6. Failure modes & fixes (don't repeat these)

| Symptom | Root cause | Fix / avoid |
|---|---|---|
| UCPath `prompt → all_methods → /frame/v4/error`, then manual fallback | `selectDuoFactor` clicked "Other options" **during** the platform auto-fire, aborting it; the security-key fallback is then rejected by UCPath | **Never click during Phase 1.** Wait for the auto-fire (signCount probe / trust screen). |
| "asserting via WebAuthn (auto)" then "did not complete within grace window" while the page is still on `a5.ucsd.edu` | A premature "not on `duosecurity.com` ⇒ success" check fired **pre-prompt**, while the SSO→Duo redirect was still in flight | Gate "auto" on `hasSigned` (the authenticator actually signed), **never** on the URL not being the Duo host. |
| Ceremony "signs but never completes" — prompt hangs on "Use Touch ID" | **signCount desync.** A run that is `kill -9`'d mid-ceremony signs (Duo observes counter+1) but `finishDuoWebAuthn` never persists, so the next run replays a counter Duo already saw → Duo **rejects the assertion as a cloned key** | Bump every `signCount` in `.auth/duo-webauthn.json` well above anything Duo could have observed (e.g. to 1000), then re-test **without force-killing**. Production exits cleanly via `finishDuoWebAuthn`, so this only bites during aggressive manual testing. |
| ServiceNow fails before reaching Duo: "SSO form not ready" on `support.ucsd.edu/auth_redirect.do` | The `support.ucsd.edu/esc → auth_redirect.do → a5.ucsd.edu` SAML chain is client-side; a one-shot `domcontentloaded` check resolves on the interstitial before the form renders | `waitForSsoForm` polls for the submit button (`src/infra/auth/sso-fields.ts`). |
| Duo greys "Security key — Not supported in this browser" (CRM) | Playwright Chromium lacks `isExternalCTAP2SecurityKeySupported` | `ctap2SupportShim` forces it true (auto-injected when a usb cred is loaded). |
| Chrome native "insert your security key" dialog blocks the page (CRM) | Authenticator armed **after** the prompt; CRM auto-fires on load | Arm at `clickSsoSubmit` (before the prompt). Phase 2 also presses Escape to recover. |
| A flow approves on the phone unexpectedly even with the flag on | The flow didn't reach the shared arming path | All six flows must go through `clickSsoSubmit`. (UKG previously clicked the submit button directly — fixed.) |
| Reloading the Duo prompt makes it "sign but never complete" | Reload desyncs Duo's challenge | **Never reload** the prompt; use the in-session click path. |

### signCount resync one-liner
```bash
node -e "const p='./.auth/duo-webauthn.json';const f=require(p);f.credentials.forEach(c=>c.signCount=1000);require('fs').writeFileSync(p,JSON.stringify(f,null,2));console.log('resynced')"
```

---

## 7. Key constants & symbols

| Symbol | File | Meaning |
|---|---|---|
| `HR_AUTOMATION_DUO_WEBAUTHN` | env | Opt-in flag (`=1`) |
| `armDuoWebAuthn` / `beginDuoWebAuthn` / `finishDuoWebAuthn` | `duo-webauthn.ts` | Arm authenticators / select factor / persist+teardown |
| `selectDuoFactor` | `duo-webauthn.ts` | Two-phase factor resolver (§4) |
| `ctap2SupportShim` | `duo-webauthn.ts` | Forces the CRM security-key factor visible |
| `DUO_WEBAUTHN_GRACE_MS` (25s) | `duo-poll.ts` | Post-factor wait for the success URL before manual fallback |
| `waitForSsoForm` | `sso-fields.ts` | Polls for the SSO submit button across redirect chains |
| `DUO_WEBAUTHN_CREDENTIAL_PATH` | `duo-webauthn.ts` | `.auth/duo-webauthn.json` (gitignored secret) |

---

## 8. Quick troubleshooting checklist

1. Flag set? `HR_AUTOMATION_DUO_WEBAUTHN=1`. Chromium (not Firefox/WebKit)?
2. Credential file present with **both** devices? `node -e "require('./.auth/duo-webauthn.json').credentials.forEach(c=>console.log(c.transport))"` → `internal` + `usb`.
3. UCPath hanging on "Use Touch ID" / "signs but never completes"? **Resync signCount** (§6).
4. UCPath `/error`? Something is clicking during the auto-fire — keep Phase 1 click-free.
5. ServiceNow "SSO form not ready"? Confirm `waitForSsoForm` is in the flow.
6. Always validate with `npm run test-login -- --all`, run twice.
