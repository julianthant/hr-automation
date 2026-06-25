# Duo Autopilot — Build Plan

> **Read this whole file before writing code.** It is a self-contained spec for a
> fresh session with no prior context. It tells you *what* to build, *why* the
> approach is what it is, the *exact* technical shape of the hard parts, and a
> *phased* build order so you get a working "no phone" demo before generalizing.

---

## 1. Goal

A Chrome (MV3) extension that makes UCSD Duo MFA **hands-off in the user's own
daily browser**. When the user logs into any of the 6 UCSD systems below, the
extension answers the Duo WebAuthn ceremony automatically — **no phone push, no
fingerprint touch**. Optionally it also fills the SSO username/password and
clicks submit, so the whole login is one click.

This is a **personal convenience tool** for the user's own account on their own
machine. It is *not* part of any automation pipeline.

### The 6 target systems

| System | Entry URL | SSO form host | Duo prompt host |
|---|---|---|---|
| UCPath | `https://ucpath.ucsd.edu` (→ campus discovery → SSO) | `a5.ucsd.edu` | `*.duosecurity.com` |
| ACT CRM (Salesforce) | `https://crm.ucsd.edu/hr` | `a5.ucsd.edu` | `*.duosecurity.com` |
| UKG (Old Kronos) | `https://ucsd.kronos.net/wfcstatic/applications/navigator/html5/dist/container/index.html` | `ucsd.kronos.net` SSO (`#ssousername` / `#ssopassword`) — **not a5** | `*.duosecurity.com` |
| Kuali Build | `https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb` | `a5.ucsd.edu` | `*.duosecurity.com` |
| New Kronos (WFD) | `https://ucsd-sso.prd.mykronos.com/wfd/home` | `a5.ucsd.edu` | `*.duosecurity.com` |
| ServiceNow (HR ESC) | `https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf` (→ `auth_redirect.do` → SSO) | `a5.ucsd.edu` | `*.duosecurity.com` |

> **The hosts in the last two columns are the load-bearing fact.** All 6 land on
> the **same** UCSD Shibboleth form (`a5.ucsd.edu`, except UKG's own SSO page) and
> the **same** Duo Universal Prompt on `*.duosecurity.com`. The WebAuthn ceremony
> the extension must answer happens **on `*.duosecurity.com`**. Verify these hosts
> live in Phase 0 before trusting the table.

---

## 2. The core idea (and why it's the right one)

There are two ways to replay a WebAuthn credential from an extension:

- **(A) `chrome.debugger` + CDP virtual authenticator.** Reuses the exact CDP
  `WebAuthn.addVirtualAuthenticator` mechanism the user's existing automation uses.
  **Rejected** because it shows a persistent yellow *"… is debugging this browser"*
  banner the whole time — unacceptable for an always-on daily tool — and still goes
  through Chrome's real WebAuthn pipeline (native dialogs, factor-selection dance).

- **(B) Override `navigator.credentials.get` in the page (MAIN world) and answer
  the ceremony in pure JavaScript.** ← **THIS IS WHAT WE BUILD.**

### Why (B) is both cooler and simpler

You are building a tiny **software FIDO2 authenticator** that lives in the page.
When Duo calls `navigator.credentials.get({publicKey})`, your shim intercepts it,
signs Duo's challenge with WebCrypto using the **already-enrolled** P-256 private
key, and returns a synthetic `PublicKeyCredential`. Because the ceremony **never
reaches Chrome's real WebAuthn stack**:

- **No native OS dialog** (no Touch ID prompt, no "insert your security key").
- **No debugger banner.**
- **None of the two-phase factor-selection choreography** the CDP approach needs
  (no Escape key, no "Other options" clicking, no race conditions). The auto-fired
  `get()` is simply answered.

### Reuse, don't re-enroll

The credential is **already enrolled with Duo** and copied to
`credentials/duo-webauthn.json` (see §4). Same `rpId` (`duosecurity.com`), same
`credentialId`, same `privateKey`, same `signCount`. You are **replaying an
existing credential from a nicer place** — not registering anything new.

---

## 3. Security model (do this, don't shortcut it)

This mechanism deliberately defeats the user's own MFA, so the design must contain
the blast radius:

1. **The private key NEVER enters the page's MAIN world.** The page is
   `duosecurity.com` — putting the private key there exposes it to Duo's own JS.
   Instead, **only the signing happens off-page**: the MAIN-world shim sends the
   challenge to the extension service worker, which holds the key, signs, bumps the
   counter, and returns only the (public, single-use) assertion. See §7.
2. **`credentials/` is gitignored.** Never commit the key. Never `console.log` it.
3. **Scope content scripts tightly** to only `*.duosecurity.com`, `a5.ucsd.edu`,
   and the specific SSO/entry origins in §1 — never `<all_urls>`.
4. **Within `duosecurity.com`, only answer a `get()` whose `rpId` is
   `duosecurity.com` and whose `allowCredentials` matches (or is empty and we hold a
   resident credential).** For anything else, call the **original**
   `navigator.credentials.get` so the user's other passkeys still work normally.
5. `signCount` is load-bearing — see §6.5. Persist it monotonically or Duo rejects
   the next assertion as a cloned key.

---

## 4. The credential file

Already copied to `./credentials/duo-webauthn.json`. Shape:

```json
{
  "credentials": [
    {
      "rpId": "duosecurity.com",
      "credentialId": "<base64>",          // 32 bytes; the WebAuthn key handle Duo stored
      "privateKey": "<base64 PKCS#8>",     // EC P-256 private key — SECRET
      "userHandle": "<base64>",            // returned as response.userHandle
      "signCount": 100220,                 // current counter; MUST stay ahead of Duo's view
      "isResidentCredential": false,
      "transport": "internal"              // "internal" = Touch ID factor; "usb" = security key (CRM)
    },
    { "...": "the second credential, transport: \"usb\"" }
  ]
}
```

There are **two** credentials: `internal` (used by UCPath/UKG/Kuali/Kronos, which
offer Touch ID) and `usb` (used by **ACT CRM**, which offers only a security key).
The shim picks by matching `allowCredentials`/`rpId`, not by transport guesswork.

**Loading:** the **options page** reads this JSON (user pastes it once, or you ship
a one-time import that `fetch`es the packaged file during dev) into
`chrome.storage.local`. The service worker reads it from there at sign time. Do
**not** hardcode the key into a committed source file.

> ⚠️ The `signCount` values in the copied file (≈100220 / 100230) were last
> advanced by the Playwright automation. They may be **behind** what Duo has since
> observed if that automation ran after the copy. If the first live test "signs but
> never completes", **bump both counters well above Duo's view** (e.g. to `1000000`)
> in `chrome.storage` and retry. This is the #1 first-run gotcha — see §6.5 + §11.

---

## 5. File layout

```
duo-autopilot/
  manifest.json          # MV3; host_permissions + content_scripts (MAIN + ISOLATED)
  src/
    inpage.js            # MAIN world — overrides navigator.credentials.get; assembles the
                         #   PublicKeyCredential; talks to content.js via window.postMessage
    content.js           # ISOLATED world — bridges inpage.js <-> service worker; also
                         #   does optional SSO autofill + "Yes, this is my device" auto-click
    background.js        # service worker — holds creds in chrome.storage, SIGNS, bumps signCount
    crypto.js            # pure helpers: base64<->bytes, raw-ECDSA-sig -> DER, authData builder
    options.html
    options.js           # paste/import duo-webauthn.json + SSO creds into chrome.storage.local
  credentials/
    duo-webauthn.json    # GITIGNORED secret (already copied here)
  .gitignore             # already present
  BUILD_PLAN.md          # this file
  README.md              # write a short one at the end
```

No build step is required (plain JS, MV3). Keep it buildless unless you have a
reason. `git init` the folder as its own repo at the start.

---

## 6. The hard part — implementing the WebAuthn assertion

This is the whole game. Get this byte-exact or Duo rejects the signature.

### 6.1 What the shim intercepts

`navigator.credentials.get(options)` where `options.publicKey` is a
`PublicKeyCredentialRequestOptions`:

```
publicKey = {
  challenge: ArrayBuffer,
  rpId: "duosecurity.com",
  allowCredentials: [{ type: "public-key", id: ArrayBuffer, transports?: [...] }],  // may be []
  userVerification: "discouraged" | "preferred" | "required",
  timeout, extensions
}
```

### 6.2 clientDataJSON

UTF-8 bytes of exactly this JSON (key order matters for some RPs; this order is safe):

```json
{"type":"webauthn.get","challenge":"<base64url(challenge, no padding)>","origin":"<page origin>","crossOrigin":false}
```

- `origin` = the page's real origin (e.g. `https://duo.example.duosecurity.com`) —
  read it from `location.origin` in the MAIN world and pass it to the signer.
- `challenge` = **base64url, no padding**, of the raw challenge bytes.

`clientDataHash = SHA-256(clientDataJSON_bytes)`.

### 6.3 authenticatorData (37 bytes for an assertion)

```
authenticatorData = rpIdHash(32) || flags(1) || signCount(4, big-endian)
```

- `rpIdHash = SHA-256(utf8("duosecurity.com"))`  — hash the **rpId string**, not the origin.
- `flags = 0x05`  → `UP` (0x01, user present) | `UV` (0x04, user verified). No AT/ED bits.
- `signCount` = the credential's **new** counter (old + 1), 4-byte big-endian.

### 6.4 signature

```
signature = ECDSA_P256_SHA256_sign( authenticatorData || clientDataHash )   // then DER-encode
```

- Import the PKCS#8 key:
  `crypto.subtle.importKey("pkcs8", pkcs8Bytes, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"])`
- Sign: `crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, dataToSign)`
- WebCrypto returns a **raw 64-byte** `r||s`. **WebAuthn requires DER/ASN.1.**
  Convert with the helper below.

**Reference: raw (r||s) → DER** (put in `crypto.js`):

```js
// raw: Uint8Array(64) = r(32) || s(32)  ->  DER SEQUENCE{ INTEGER r, INTEGER s }
export function rawEcdsaSigToDer(raw) {
  const r = raw.slice(0, 32), s = raw.slice(32, 64);
  const enc = (b) => {
    let i = 0; while (i < b.length - 1 && b[i] === 0) i++;     // trim leading zeros
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);            // prepend 0x00 if high bit set
    return Uint8Array.from([0x02, v.length, ...v]);             // INTEGER
  };
  const re = enc(r), se = enc(s);
  return Uint8Array.from([0x30, re.length + se.length, ...re, ...se]); // SEQUENCE
}
```

### 6.5 signCount — the load-bearing counter

WebAuthn servers treat a counter that does **not advance** as a cloned-authenticator
signal. So:

- Read current `signCount` from storage, use `old`, write back `old + 1` (or higher)
  **atomically in the service worker** before returning the assertion.
- The authenticatorData must carry the **new** value you persisted.
- If a sign attempt is started but the login fails, Duo may still have observed the
  advanced counter — persisting eagerly (before returning) is correct and safe.
- **First-run desync**: if the copied file's counter is behind Duo's view, the first
  assertion is rejected ("signs but never completes"). Fix by bumping the stored
  counters far ahead (e.g. `1000000`). See §11.

### 6.6 The returned object (must duck-type `PublicKeyCredential`)

Build this in the **MAIN world** (`inpage.js`), from the components the service
worker returns:

```js
const cred = {
  id: base64url(credentialIdBytes),
  rawId: credentialIdBytes.buffer,           // ArrayBuffer
  type: "public-key",
  authenticatorAttachment: transport === "usb" ? "cross-platform" : "platform",
  response: {
    clientDataJSON: clientDataJSONBytes.buffer,
    authenticatorData: authenticatorDataBytes.buffer,
    signature: derSignatureBytes.buffer,
    userHandle: userHandleBytes ? userHandleBytes.buffer : null,
  },
  getClientExtensionResults: () => ({}),
};
// Some RPs do `result instanceof PublicKeyCredential` — make it pass:
Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
// And the response prototype, defensively:
Object.setPrototypeOf(cred.response, AuthenticatorAssertionResponse.prototype);
return cred;
```

> If Duo reads `response.authenticatorData`/`signature`/`clientDataJSON` as
> `ArrayBuffer`s (it does), the `.buffer` views above are correct. Confirm Duo
> doesn't require the exact `ArrayBuffer` (not a `Uint8Array`) — it does, hence
> `.buffer`.

---

## 7. Messaging architecture (keeps the key off the page)

```
[MAIN world] inpage.js                         [ISOLATED] content.js        [SW] background.js
  override navigator.credentials.get
  ── window.postMessage({nonce, challenge,
        rpId, origin, allowCredentials}) ─────►  chrome.runtime.sendMessage ──►  sign():
                                                                                  - load creds from storage
                                                                                  - pick credential
                                                                                  - read+bump signCount
                                                                                  - build authData
                                                                                  - importKey + sign + DER
  ◄── window.postMessage({nonce, ok,        ◄── sendResponse({authenticatorData, ◄──  return components
        authenticatorData, signature,             signature, userHandle, credentialId,
        userHandle, credentialId}) ──             signCount})
  assemble PublicKeyCredential (§6.6)
  resolve the original get() Promise
```

- **Correlate** request/response with a `nonce` (e.g. a random string) so concurrent
  ceremonies don't cross.
- `inpage.js` is injected into the **MAIN world** (`world: "MAIN"` in manifest
  `content_scripts`, or programmatically) at `document_start` so it overrides
  `navigator.credentials.get` **before** Duo's bundle captures a reference.
- Encode the ArrayBuffers as base64 across `postMessage`/`sendMessage` boundaries
  (structured clone of ArrayBuffers across MAIN↔ISOLATED via `postMessage` works,
  but base64 is simplest and avoids transferable surprises).
- All crypto lives in `background.js`/`crypto.js`. `inpage.js` only assembles the
  final object and resolves the promise — it never sees the private key.

**Keep the original `get`:** at install time do
`const originalGet = navigator.credentials.get.bind(navigator.credentials);`
and call it for any non-matching ceremony (§3.4).

---

## 8. manifest.json (MV3) — starting point

```json
{
  "manifest_version": 3,
  "name": "Duo Autopilot",
  "version": "0.1.0",
  "description": "Hands-off UCSD Duo MFA in your own browser.",
  "permissions": ["storage", "scripting"],
  "host_permissions": [
    "https://*.duosecurity.com/*",
    "https://a5.ucsd.edu/*",
    "https://ucpath.ucsd.edu/*",
    "https://crm.ucsd.edu/*",
    "https://ucsd.kronos.net/*",
    "https://ucsd.kualibuild.com/*",
    "https://ucsd-sso.prd.mykronos.com/*",
    "https://support.ucsd.edu/*"
  ],
  "background": { "service_worker": "src/background.js" },
  "options_page": "src/options.html",
  "content_scripts": [
    {
      "matches": ["https://*.duosecurity.com/*"],
      "js": ["src/inpage.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://*.duosecurity.com/*"],
      "js": ["src/content.js"],
      "run_at": "document_start",
      "world": "ISOLATED"
    }
  ]
}
```

Phase 2 adds autofill content scripts for `a5.ucsd.edu`, `ucsd.kronos.net`, etc.

---

## 9. SSO autofill + trust-click (Phase 2 — selectors are known)

From the user's existing automation, the selectors are already mapped — **reuse
them, don't re-discover**:

**Shibboleth form (`a5.ucsd.edu`) — UCPath, CRM, Kuali, New Kronos, ServiceNow:**
- Username: `input[name="j_username"]` (a11y label fallbacks: "User name (or email address)", "Username")
- Password: `input[name="j_password"]` (label fallbacks: "Password:", "Password")
- Submit: `button[name="_eventId_proceed"]`  ← **use this exact name** (avoids the
  "Enroll in Two-Step Login" link which also has `role="button"` + "Login" text)

**UKG SSO (`ucsd.kronos.net`) — different form:**
- Username: `#ssousername`
- Password: `#ssopassword`

**Duo "remember this device" trust screen (on `*.duosecurity.com`, after the
assertion):**
- Click the element with text **"Yes, this is my device"** / **"Yes, trust browser"**
  if present, to set the remembered-device cookie (extends the no-MFA window).

**CRM factor nudge (only if Duo shows a chooser instead of auto-firing `get()`):**
- The shim answers `get()` directly, so usually no clicking is needed. If a factor
  list appears, click the **"Security key"** link for CRM / **"Touch ID"** for the
  others to trigger the ceremony. Far simpler than the old CDP `selectDuoFactor`
  because there is **no native dialog** to dismiss.

Store SSO username/password in `chrome.storage.local` via the options page. Autofill
is **opt-in per the user** — it's fine to ship Phase 1 (Duo only) and let the
browser's own password manager fill the form.

---

## 10. Build sequence (phased — get a "no phone" win fast)

> Commit after each phase. `git init` first; this is its own repo.

**Phase 0 — Recon (do this first, ~20 min).**
- Open each of the 6 entry URLs manually (or with `playwright-cli`) and **confirm**:
  the SSO form host, the Duo prompt host (`*.duosecurity.com` exact subdomain
  pattern), and that Duo calls `navigator.credentials.get` (check DevTools: set a
  breakpoint / `console.log` wrapper on `navigator.credentials.get` and watch the
  options). Record actual `rpId` and whether `allowCredentials` is populated or
  empty (CRM is expected empty/resident). **Update §1's table with reality.**

**Phase 1 — The MVP demo: hands-off Duo for UCPath only.** ← the "holy shit" moment.
- `manifest.json` (Duo host only), `background.js` (load cred from storage + sign),
  `crypto.js` (base64, DER, authData), `inpage.js` (override + assemble), `content.js`
  (bridge), `options.js` (import the credential JSON into storage).
- Success: navigate to UCPath, type username/password yourself, click login → Duo is
  approved with **no phone and no fingerprint**, lands in UCPath.
- This exercises the entire crypto path. Everything else is generalization.

**Phase 2 — Generalize to all 6 + SSO autofill.**
- Confirm the same Duo path covers CRM (the `usb` credential, possibly resident /
  auto-fired) and the other four. Add the trust-screen auto-click.
- Add autofill content scripts (`a5.ucsd.edu` + `ucsd.kronos.net`) using §9 selectors,
  reading SSO creds from storage. Add "Yes, this is my device" auto-click.

**Phase 3 — Polish.**
- Options page UX (status: credential loaded? counters? which sites enabled?).
- A toggle to disable autopilot per-site or globally (a kill switch).
- Optional: a tiny on-page badge/toast ("Duo Autopilot approved") so it's visible.
- Write `README.md` (load-unpacked instructions, how to import the credential, the
  signCount-desync fix, security note).

---

## 11. Risks & mitigations (named so you don't hit them blind)

1. **Override timing.** `inpage.js` must replace `navigator.credentials.get` before
   Duo's script grabs it. → MAIN world + `run_at: document_start`. Verify in Phase 0
   that your override is the one Duo calls (log on entry).
2. **`instanceof PublicKeyCredential`.** A plain object fails it. →
   `Object.setPrototypeOf(cred, PublicKeyCredential.prototype)` (§6.6).
3. **signCount desync** ("signs but never completes" / prompt hangs on "Use Touch
   ID"). → bump stored counters far ahead (e.g. `1000000`) and retry (§4, §6.5).
4. **ArrayBuffer vs Uint8Array.** Duo expects `ArrayBuffer`s on the response. → use
   `.buffer` (§6.6). Across `postMessage`, base64-encode then rebuild typed arrays.
5. **clientDataJSON exactness.** `challenge` must be **base64url no padding** of the
   raw challenge; `origin` must be `location.origin`. A mismatch fails server-side
   signature verification silently. → unit-test the encoder against a known vector.
6. **CRM resident/auto-fired `get()`.** CRM auto-fires a discoverable request with
   empty `allowCredentials`. → when `allowCredentials` is empty, select the credential
   by `rpId` (and prefer the `usb` one for CRM). Confirm live in Phase 2.
7. **CSP on duosecurity.com.** A MAIN-world content script is injected by the
   browser, not the page, so page CSP does not block it. But avoid `eval`/inline
   string execution in `inpage.js` to be safe.
8. **Duo Universal Prompt updates.** Duo may change its prompt/markup. The crypto is
   stable (standard WebAuthn); only the optional DOM nudges (§9) are fragile. Keep
   them best-effort and non-fatal.

---

## 12. Definition of done

- [ ] Phase 1: UCPath Duo approved hands-off (no phone, no touch), key never in page.
- [ ] Phase 2: all 6 systems approve hands-off; SSO autofill + submit works; trust
      screen auto-clicked.
- [ ] `credentials/` gitignored; no key in any committed file or log.
- [ ] Per-site / global kill switch in options.
- [ ] `README.md` written (install, import credential, signCount fix, security note).
- [ ] One-line note of any §1 table corrections found in Phase 0.

---

## 13. Provenance / reference (where these facts came from)

All selectors, URLs, success conditions, and the WebAuthn/Duo behavior were lifted
from the user's existing Playwright automation at
`~/Documents/hr-automation`, specifically:

- `src/infra/auth/duo-webauthn.ts` — the CDP virtual-authenticator approach this
  extension replaces; the credential-file format; the two-factor (internal/usb) model.
- `src/infra/auth/login.ts` — the 6 login flows, entry URLs, success-URL checks.
- `src/infra/auth/sso-fields.ts` — the Shibboleth form selectors (`j_username`,
  `j_password`, `_eventId_proceed`).
- `src/infra/auth/duo-poll.ts` — the "Yes, this is my device" trust click; grace windows.
- `src/infra/auth/CLAUDE.md` + `docs/engineering/hands-off-duo-webauthn.md` — the
  full failure-modes writeup (signCount desync, CRM's auto-fire, UCPath rejecting the
  security key, etc.). **Read that doc if you get stuck** — it documents every live
  failure mode the user already hit and fixed.

You do **not** need the hr-automation repo to build this extension, but it is the
authoritative reference if a UCSD-side behavior surprises you.
