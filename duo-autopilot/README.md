# Duo Autopilot

Hands-off **UCSD Duo MFA in your own everyday browser** — a Manifest V3 Chrome
extension. When Duo asks for a security key or Touch ID, the extension answers
the WebAuthn ceremony itself, in pure JavaScript. **No phone push. No fingerprint
touch. No native dialog. No debugger banner.** The Duo prompt just clears.

It's a tiny **software FIDO2 authenticator** that lives in the page: it intercepts
`navigator.credentials.get()` on `*.duosecurity.com`, signs Duo's challenge with a
P-256 key you already enrolled, and hands back a synthetic `PublicKeyCredential`.
Because the ceremony never reaches Chrome's real WebAuthn stack, there's no OS
prompt and none of the factor-selection dance.

---

## ⚠️ Read this first

This tool **deliberately answers your own MFA without you**. That is the whole
point, and it is also why you must be careful:

- **Only for your own account, on your own machine.** This is a personal
  convenience tool, not an automation product and not something to point at an
  account you don't own. Using it against someone else's account is account
  compromise — don't.
- **It weakens a second factor by design.** Anyone with access to your unlocked
  browser profile can now pass Duo as you. Treat your OS login and your Chrome
  profile as the real second factor now.
- **Your private key lives in `chrome.storage.local`.** It never leaves your
  machine and is never committed (`credentials/` is gitignored), but it is on
  disk in your browser profile. Clearing it (see the kill switch) removes it.
- **Check your institution's policy.** Bypassing the interactive step of MFA may
  violate acceptable-use rules even on your own account. That's on you.

The credential the extension uses is a **real WebAuthn credential you enrolled
with Duo yourself** — the same kind a hardware key would create. You are replaying
your own enrolled key from a more convenient place, not forging anything.

---

## How it works (30-second version)

```
Duo page (MAIN world)        content.js (ISOLATED)        background.js (service worker)
  navigator.credentials.get  ──►  bridge  ──►  sign(): load key from storage,
  / .create() intercepted                       bump signCount, build authData,
        ▲                                        import P-256 key, sign, DER-encode
        └──────── assertion / attestation ◄──────────── (key NEVER enters the page)
```

The private key is used **only** in the service worker (`background.js` →
`crypto.js`). The in-page shim (`inpage.js`) only sees the public, single-use
result, so Duo's own JavaScript on the page can never read your key.

Anything that isn't a Duo ceremony falls through to the browser's real
`get()` / `create()`, so your other passkeys keep working normally.

---

## Install (load unpacked)

No build step — it's plain MV3 JavaScript.

1. Clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. Open the extension's **Options** page (the ⚙️ / "Extension options").

You'll see the status hero: **No credential** until you set one up.

## Headless / automated use (playwright-cli)

This extension is part of the **hr-automation** repo so it can clear Duo inside an
automated browser — specifically the `playwright-cli` session used for headless
selector mapping against UCSD's auth-gated systems. There is no Options UI to
click in that browser, so the extension **self-arms**: on service-worker startup,
when storage holds no credential, it imports the one packaged at
`credentials/duo-webauthn.json` (the same file the Options "Import from packaged
file" button reads). Gated so it never overwrites a human-loaded credential, and a
silent no-op when the file is absent (it's gitignored) or `autoImport` is off.

On auto-import the `signCount` is stamped to the current unix time (seconds) if
the packaged value is lower. This is the automated equivalent of "Resync
signCount": the packaged counter is usually far behind Duo's server-observed
value, so without it Duo rejects the first assertion as a cloned key and the
prompt hangs. A unix timestamp is monotonic across fresh browser profiles (a
fixed bump like 1,000,000 would collide on the second headless session) and stays
ahead of Duo's view. Verified end-to-end against a live UCPath login 2026-06-25.

From the repo root:

```bash
playwright-cli install-browser chromium      # one-time: full Chromium (supports --load-extension)
npm run sel:browser -- <login-url>           # opens session 'sel' headless with the extension loaded
# …fill SSO username/password (e.g. from .env); the extension answers the Duo prompt itself…
playwright-cli -s=sel snapshot               # map selectors on deep, auth-gated pages
playwright-cli -s=sel close
```

`npm run sel:browser` (→ `launch-selector-browser.mjs`) generates a gitignored
`.playwright/duo-autopilot.config.json` that loads this folder via
`--load-extension`, then opens a persistent-context session (extensions require a
persistent context). It uses Playwright's **full** bundled Chromium
(`channel: chromium`, new headless) because Google Chrome stable disabled
`--load-extension` in 2024 and the lightweight `headless-shell` can't run
extensions. The extension only answers the **Duo MFA** step — you still fill the
SSO username/password yourself.

> **Chromium install under Node 26:** `playwright-cli install-browser chromium`
> hangs in Playwright's zip extractor right before the ~230MB framework. Workaround:
> `curl` the CfT zip (URL is printed by the install command) and extract with macOS
> `ditto -x -k <zip> ~/Library/Caches/ms-playwright/chromium-<rev>/`, then
> `touch …/INSTALLATION_COMPLETE …/DEPENDENCIES_VALIDATED`.

---

## Getting a credential

You need a Duo credential in storage before autopilot can do anything. There are
two ways.

### Option A — Enroll a fresh one through Duo (recommended)

This is the "set it up for me" path: the extension acts as a full software
authenticator and **captures a brand-new credential straight from Duo's own
"Add a device" page**. You never touch JSON.

1. On the Options page, open **Set up a credential → Enroll via Duo**.
2. Pick the factor you'll add: **Touch ID** (most systems) or **Security key**
   (needed for ACT CRM). This *arms* a one-shot capture.
3. In another tab, start any UCSD login and reach the Duo prompt. Choose
   **Other options → Manage devices**, and approve once with your phone (Duo
   requires an existing factor to add a new one — this is the only time you'll
   need it).
4. Click **Add a device → Security key / Touch ID**. When Chrome would normally
   pop a registration dialog, Autopilot intercepts it instead: it mints a P-256
   keypair, hands Duo the public key, and saves the private credential itself.
5. The Options page updates the moment it's captured. You're armed.

> The capture only fires while you've explicitly armed it — a normal security-key
> registration on Duo (when you haven't armed) passes straight through to your
> real authenticator, untouched.

Repeat for the second factor type if you use ACT CRM (which only offers a
security key). Touch ID covers the other five systems.

### Option B — Import existing credential JSON

If you already have a `duo-webauthn.json` (e.g. exported from another tool), use
**Credential → Paste JSON…** and paste it, or drop the file at
`credentials/duo-webauthn.json` in the unpacked folder and click **Import from
packaged file**. Shape:

```json
{
  "credentials": [
    {
      "rpId": "duosecurity.com",
      "credentialId": "<base64>",
      "privateKey": "<base64 PKCS#8 EC P-256>",
      "userHandle": "<base64 | null>",
      "signCount": 100220,
      "isResidentCredential": false,
      "transport": "internal"
    }
  ]
}
```

`credentials/` is **gitignored** — the key never gets committed.

---

## If Duo "signs but never completes" — Resync signCount

WebAuthn servers treat a counter that doesn't advance as a cloned-key signal. If
the stored `signCount` falls *behind* what Duo has already observed (e.g. an
imported file went stale), the first assertion is rejected and the prompt just
hangs.

Fix: Options → **Credential → Resync signCount**. It bumps every stored counter
to at least **1,000,000**, safely ahead of Duo's view. Then retry the login.
(Freshly *enrolled* credentials start at 0 and never hit this — Duo just saw 0.)

---

## Controls (Options page)

| Control | What it does |
|---|---|
| **Autopilot** | Master kill switch. Off → Duo falls back to your phone. |
| **Trust this device** | Auto-clicks "Yes, this is my device" so Duo prompts less often. |
| **Show toast** | Brief on-page "Duo Autopilot approved / enrolled" confirmation. |
| **Resync signCount** | Bumps counters ahead of Duo if a login stalls (see above). |
| **Clear credentials** | Wipes the stored key from this browser. Two-tap confirm. |

---

## The systems it covers

All UCSD logins land on the same Duo Universal Prompt, so one credential set
covers them all:

| System | Factor used |
|---|---|
| UCPath, UKG (old Kronos), Kuali Build, New Kronos (WFD), ServiceNow (HR ESC) | Touch ID (`internal`) |
| ACT CRM (Salesforce) | Security key (`usb`) |

---

## Repo layout

```
duo-autopilot/
  manifest.json          MV3 manifest (storage perm + duosecurity.com scope)
  src/
    inpage.js            MAIN world — overrides navigator.credentials.get/.create
    content.js           ISOLATED — message bridge + "trust this device" auto-click
    background.js        service worker — holds the key, signs, mints credentials,
                         and auto-imports the packaged credential when storage is empty
    crypto.js            byte-exact WebAuthn helpers (assertion + registration + CBOR)
    options.html / .js   status, toggles, and the enrollment / import flow
  credentials/           GITIGNORED — your private key, never committed
  launch-selector-browser.mjs  opens a headless playwright-cli session with the
                         extension loaded (npm run sel:browser, from the repo root)
  test/crypto.test.mjs   offline self-test (run: npm test)
  BUILD_PLAN.md          the full design spec
```

## Develop / test

```bash
npm test   # offline crypto self-test: base64, DER, assertion + registration round-trips
```

The test generates throwaway keys (never your real one) and proves the byte-exact
path Duo's server checks: that a freshly *registered* key produces an *assertion*
its own public key verifies.

---

## Security model, in full

1. The private key **never enters the page's MAIN world** — only the service
   worker imports and signs with it.
2. Content scripts are scoped to `*.duosecurity.com` only — never `<all_urls>`.
3. The shim only answers a ceremony whose `rpId` is `duosecurity.com`; everything
   else defers to the real authenticator.
4. Enrollment capture is **opt-in and one-shot** — it must be armed from Options
   and disarms itself after a single capture.
5. `signCount` advances monotonically and is persisted *before* the assertion is
   returned, so it stays at or ahead of Duo's view.
6. The key file is gitignored and never logged.

---

*Personal tool. No warranty. Use it on your own account and nobody else's.*
