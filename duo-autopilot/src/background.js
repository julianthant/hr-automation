// Service worker — the ONLY place the Duo private key is used. The MAIN-world
// shim (inpage.js) never sees the key; it sends Duo's challenge here, this worker
// signs it, bumps the signCount, and returns only the (public, single-use)
// assertion components. See BUILD_PLAN.md §3 and §7.

import { base64ToBytes, bytesToBase64, bytesEqual, createAssertion, createRegistration } from "./crypto.js";

const STORAGE_KEY = "duoCredentials";
const ENROLL_KEY = "enroll";
const RP_ID = "duosecurity.com";
/** Credential shipped inside the unpacked folder; auto-imported when storage is empty. */
const PACKAGED_CRED_PATH = "credentials/duo-webauthn.json";

/** Read the enrolled credentials array from chrome.storage.local. */
async function loadCredentials() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const creds = data[STORAGE_KEY];
  return Array.isArray(creds) ? creds : [];
}

/** Read autopilot settings, with everything defaulting ON. */
async function loadSettings() {
  const data = await chrome.storage.local.get("settings");
  const s = data.settings || {};
  return {
    enabled: s.enabled !== false, // master kill switch
    trustClick: s.trustClick !== false,
    toast: s.toast !== false,
    autoImport: s.autoImport !== false, // headless self-arming (see ensureProvisioned)
  };
}

// ── Headless self-arming ──────────────────────────────────────────────────
// In an automated browser (e.g. the playwright-cli session used for selector
// mapping) there is no Options UI to click, so the extension provisions itself:
// when storage holds no credential yet, it imports the one packaged at
// credentials/duo-webauthn.json (the same file the Options "Import from packaged
// file" button reads). Best-effort and idempotent — it never overwrites a
// credential a human already loaded, and silently no-ops if the packaged file is
// absent (it's gitignored) or autoImport is disabled.

/** Minimal validator — mirrors options.js's isValidCredential (kept in sync). */
function isValidCredential(c) {
  return (
    c &&
    typeof c === "object" &&
    typeof c.rpId === "string" &&
    typeof c.credentialId === "string" &&
    typeof c.privateKey === "string" &&
    typeof c.signCount === "number" &&
    (c.transport === "internal" || c.transport === "usb")
  );
}

function extractCredentials(parsed) {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.credentials)
    ? parsed.credentials
    : null;
  return arr ? arr.filter(isValidCredential) : [];
}

async function autoImportPackagedCredential() {
  try {
    const settings = await loadSettings();
    if (settings.autoImport === false) return; // explicit opt-out
    if ((await loadCredentials()).length > 0) return; // already armed by a human
    const resp = await fetch(chrome.runtime.getURL(PACKAGED_CRED_PATH));
    if (!resp.ok) return; // no packaged file in this build
    const creds = extractCredentials(await resp.json());
    if (creds.length === 0) return;
    // Resync signCount ahead of Duo's server-observed value, or Duo rejects the
    // assertion as a cloned key and the prompt just hangs (README "signs but
    // never completes"). A FIXED bump (e.g. 1,000,000) would collide on the next
    // fresh profile — the counter must strictly increase across sessions. The
    // current unix time (seconds) is monotonic across fresh loads, always ahead
    // of Duo's view, and fits uint32 until 2106.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const c of creds) c.signCount = Math.max(Number(c.signCount) || 0, nowSec);
    await chrome.storage.local.set({ [STORAGE_KEY]: creds });
    console.debug("[Duo Autopilot SW] auto-imported %d packaged credential(s), signCount synced to %d", creds.length, nowSec);
  } catch (e) {
    console.debug("[Duo Autopilot SW] auto-import skipped:", (e && e.message) || e);
  }
}

// Run once per worker lifetime; sign handling awaits this so the first ceremony
// can't race an empty store. The SW may be torn down and restarted in MV3, so we
// also re-trigger on install/startup.
let provisionPromise = null;
function ensureProvisioned() {
  if (!provisionPromise) provisionPromise = autoImportPackagedCredential();
  return provisionPromise;
}
chrome.runtime.onInstalled.addListener(() => void ensureProvisioned());
chrome.runtime.onStartup.addListener(() => void ensureProvisioned());
void ensureProvisioned();

/**
 * Persist an advanced signCount monotonically. Re-reads storage so a concurrent
 * write isn't clobbered, and only ever raises the counter (never lowers it).
 */
async function persistSignCount(credentialId, newCount) {
  const creds = await loadCredentials();
  let changed = false;
  for (const c of creds) {
    if (c.credentialId === credentialId && newCount > (Number(c.signCount) || 0)) {
      c.signCount = newCount;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: creds });
}

/**
 * Pick which credential answers this ceremony (BUILD_PLAN §3.4, §11.6):
 *  - scoped to the request's rpId;
 *  - if `allowCredentials` is non-empty, the credential whose id is listed
 *    (preferring the platform/`internal` one — a security key is rejected by
 *    UCPath's policy, Touch ID is accepted everywhere);
 *  - if `allowCredentials` is empty (ACT CRM's discoverable auto-fire), the
 *    resident `usb` credential CRM expects, falling back to any for the rpId.
 * Returns undefined when nothing matches, so the shim defers to the real `get()`.
 */
function pickCredential(creds, rpId, allowCredentials) {
  const forRp = creds.filter((c) => c.rpId === rpId);
  if (forRp.length === 0) return undefined;

  if (Array.isArray(allowCredentials) && allowCredentials.length > 0) {
    const allow = allowCredentials.map((id) => base64ToBytes(id));
    const matches = forRp.filter((c) =>
      allow.some((a) => bytesEqual(a, base64ToBytes(c.credentialId))),
    );
    if (matches.length === 0) return undefined;
    return matches.find((c) => c.transport === "internal") || matches[0];
  }

  return forRp.find((c) => c.transport === "usb") || forRp[0];
}

/** Core sign handler. Returns base64-encoded assertion components or {ok:false}. */
async function handleSign(req) {
  await ensureProvisioned(); // headless self-arming completes before we read storage
  const settings = await loadSettings();
  if (!settings.enabled) {
    console.debug("[Duo Autopilot SW] autopilot disabled — deferring to normal Duo");
    return { ok: false, reason: "disabled" };
  }

  const creds = await loadCredentials();
  console.debug(
    "[Duo Autopilot SW] sign request rpId=%s allowCredentials=%d origin=%s; stored creds=%d [%s]",
    req && req.rpId,
    req && Array.isArray(req.allowCredentials) ? req.allowCredentials.length : 0,
    req && req.origin,
    creds.length,
    creds.map((c) => c.transport).join(","),
  );
  if (creds.length === 0) return { ok: false, reason: "no-credentials-loaded" };

  const rpId = (req && req.rpId) || RP_ID;
  if (rpId !== RP_ID) return { ok: false, reason: "rpId-not-duosecurity" };

  const cred = pickCredential(creds, rpId, req.allowCredentials);
  if (!cred) {
    console.debug(
      "[Duo Autopilot SW] no credential matched. allowCredentials=%o storedIds=%o",
      req.allowCredentials,
      creds.map((c) => c.credentialId),
    );
    return { ok: false, reason: "no-matching-credential" };
  }
  console.debug("[Duo Autopilot SW] signing with %s credential, signCount %d -> %d", cred.transport, Number(cred.signCount) || 0, (Number(cred.signCount) || 0) + 1);

  // Counter is load-bearing: advance and PERSIST before returning. Duo may
  // observe the new counter even if the login later fails, so persisting eagerly
  // keeps the file at-or-ahead of Duo's view (BUILD_PLAN §6.5).
  const oldCount = Number(cred.signCount) || 0;
  const newCount = oldCount + 1;
  await persistSignCount(cred.credentialId, newCount);

  const { authenticatorData, clientDataJSON, signature } = await createAssertion({
    privateKeyPkcs8: base64ToBytes(cred.privateKey),
    rpId,
    challenge: base64ToBytes(req.challenge),
    origin: req.origin,
    signCount: newCount,
  });

  return {
    ok: true,
    authenticatorData: bytesToBase64(authenticatorData),
    clientDataJSON: bytesToBase64(clientDataJSON),
    signature: bytesToBase64(signature),
    userHandle: cred.userHandle || null, // already base64, or null
    credentialId: cred.credentialId, // base64
    transport: cred.transport,
    signCount: newCount,
    toast: settings.toast, // let the shim show its on-page confirmation
  };
}

/** Read the one-shot enrollment arming flag set by the options page. */
async function loadEnroll() {
  const data = await chrome.storage.local.get(ENROLL_KEY);
  const e = data[ENROLL_KEY];
  return e && typeof e === "object" ? e : { armed: false };
}

/**
 * Registration handler. Only fires when the user has explicitly *armed*
 * enrollment from the options page — otherwise it returns {ok:false} and the
 * shim defers to the browser's real `create()`, so a genuine security-key
 * registration is never hijacked. When armed, it mints a fresh credential, saves
 * it, disarms, and returns the public attestation for the page to hand to Duo.
 */
async function handleEnroll(req) {
  const enroll = await loadEnroll();
  if (!enroll.armed) return { ok: false, reason: "not-armed" };

  const rpId = (req && req.rpId) || RP_ID;
  if (rpId !== RP_ID) return { ok: false, reason: "rpId-not-duosecurity" };

  // We can only mint ES256 (P-256). If Duo's page doesn't offer it, defer.
  const algs = Array.isArray(req.pubKeyCredParams) ? req.pubKeyCredParams.map((p) => p && p.alg) : [];
  if (algs.length > 0 && !algs.includes(-7)) return { ok: false, reason: "no-es256-offered" };

  // Prefer the transport Duo's ceremony asks for; fall back to the user's pick.
  const att = req.authenticatorAttachment;
  const transport =
    att === "cross-platform" ? "usb" : att === "platform" ? "internal" : enroll.transport === "usb" ? "usb" : "internal";

  const reg = await createRegistration({
    rpId,
    challenge: base64ToBytes(req.challenge),
    origin: req.origin,
    signCount: 0,
  });
  const credentialId = bytesToBase64(reg.credentialId);

  const newCred = {
    rpId,
    credentialId,
    privateKey: bytesToBase64(reg.privateKeyPkcs8),
    userHandle: req.userHandle || null, // base64 of Duo's user.id, or null
    signCount: 0,
    isResidentCredential: !!req.residentKey,
    transport,
    deviceName: enroll.deviceName || (transport === "usb" ? "Autopilot Security Key" : "Autopilot Touch ID"),
    enrolledAt: new Date().toISOString(),
  };

  // Append (dedupe by credentialId), then disarm so the next create() passes through.
  const creds = (await loadCredentials()).filter((c) => c.credentialId !== credentialId);
  creds.push(newCred);
  await chrome.storage.local.set({ [STORAGE_KEY]: creds });
  await chrome.storage.local.set({ [ENROLL_KEY]: { armed: false } });

  console.debug("[Duo Autopilot SW] enrolled new %s credential; %d total", transport, creds.length);
  const settings = await loadSettings();
  return {
    ok: true,
    credentialId,
    attestationObject: bytesToBase64(reg.attestationObject),
    clientDataJSON: bytesToBase64(reg.clientDataJSON),
    authData: bytesToBase64(reg.authData),
    publicKeySpki: bytesToBase64(reg.publicKeySpki),
    transport,
    toast: settings.toast,
  };
}

// Serialize signs so two concurrent ceremonies can't race the signCount
// read-modify-write. Each request waits for the previous to fully settle.
let signQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "DUO_AUTOPILOT_SIGN" && msg.type !== "DUO_AUTOPILOT_ENROLL")) return undefined;

  // Only honor requests from our content script running on the Duo host.
  const url = (sender && sender.url) || "";
  if (!/^https:\/\/([^/]+\.)?duosecurity\.com\//.test(url)) {
    sendResponse({ ok: false, reason: "bad-origin" });
    return false;
  }

  if (msg.type === "DUO_AUTOPILOT_ENROLL") {
    handleEnroll(msg.request)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true; // async sendResponse
  }

  // DUO_AUTOPILOT_SIGN — serialize through the signCount queue.
  const result = signQueue
    .then(() => handleSign(msg.request))
    .catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  // Next request waits for this one to settle (success or failure).
  signQueue = result.then(
    () => undefined,
    () => undefined,
  );
  result.then((res) => sendResponse(res));
  return true; // keep the message channel open for the async sendResponse
});
