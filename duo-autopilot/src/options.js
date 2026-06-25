// Options page logic. Imports the Duo credential into chrome.storage.local,
// renders the at-a-glance armed status, and exposes the autopilot toggles.
//
// Storage contracts (read by src/background.js — do NOT rename):
//   "duoCredentials" : validated credentials ARRAY
//   "settings"       : { enabled, trustClick, toast }, every field defaults TRUE
//
// The packaged-file import is a dev convenience: an extension page may fetch
// files inside its own unpacked folder. The key lives only in storage afterward.

const STORAGE_KEY = "duoCredentials";
const SETTINGS_KEY = "settings";
const ENROLL_KEY = "enroll";
const RESYNC_TARGET = 1000000;

const $ = (id) => document.getElementById(id);

// ── inline SVG icons (single family, 1.8 stroke) for JS-rendered rows ──
const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const SHIELD = '<path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/>';
const ICONS = {
  shieldCheck: svg(SHIELD + '<path d="m9 12 2 2 4-4"/>'),
  shieldSlash: svg(SHIELD + '<path d="m9.5 9.5 5 5"/><path d="m14.5 9.5-5 5"/>'),
  shieldAlert: svg(SHIELD + '<path d="M12 8v3.5"/><path d="M12 15h.01"/>'),
  fingerprint: svg(
    '<path d="M12 10a2 2 0 0 0-2 2c0 1.5-.2 3.4-.6 4.8"/>' +
      '<path d="M8.5 7.5A5 5 0 0 1 16 12c0 1 .1 2.2.3 3.2"/>' +
      '<path d="M6.5 12a5.5 5.5 0 0 1 .8-3"/>' +
      '<path d="M12 6a6 6 0 0 1 6 6c0 .8 0 2 .2 3"/>' +
      '<path d="M13.5 19c.3-1.2.5-2.8.5-4"/>',
  ),
  key: svg('<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9.5 9.5"/><path d="m16.5 16.5 2-2"/><path d="m19 19 1.5-1.5"/>'),
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]),
  );
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
  if (kind === "err") el.setAttribute("role", "alert");
  else el.removeAttribute("role");
}

// ── credential validation + extraction (unchanged contract) ──
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
  if (!arr) throw new Error('Expected { "credentials": [ … ] } or an array.');
  const valid = arr.filter(isValidCredential);
  if (valid.length === 0) {
    throw new Error("No valid credentials found (need rpId, credentialId, privateKey, signCount, transport).");
  }
  return valid;
}

// ── storage helpers ──
async function loadStored() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}
async function storeCredentials(creds) {
  await chrome.storage.local.set({ [STORAGE_KEY]: creds });
}
async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const s = data[SETTINGS_KEY] || {};
  return { enabled: s.enabled !== false, trustClick: s.trustClick !== false, toast: s.toast !== false };
}
async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
async function loadEnroll() {
  const data = await chrome.storage.local.get(ENROLL_KEY);
  const e = data[ENROLL_KEY];
  return e && typeof e === "object" ? e : { armed: false };
}

// ── rendering ──
function renderHero(creds, settings) {
  const hero = $("hero");
  hero.classList.remove("armed", "off", "empty");
  if (creds.length === 0) {
    hero.classList.add("empty");
    $("heroGlyph").innerHTML = ICONS.shieldAlert;
    $("heroState").textContent = "No credential";
    $("heroReason").textContent = "Import a credential to arm autopilot.";
  } else if (!settings.enabled) {
    hero.classList.add("off");
    $("heroGlyph").innerHTML = ICONS.shieldSlash;
    $("heroState").textContent = "Autopilot off";
    $("heroReason").textContent = "Duo prompts fall back to your phone.";
  } else {
    hero.classList.add("armed");
    $("heroGlyph").innerHTML = ICONS.shieldCheck;
    $("heroState").textContent = "Armed";
    $("heroReason").textContent = `${creds.length} credential${creds.length > 1 ? "s" : ""} ready — no phone, no touch.`;
  }
}

function renderCreds(creds) {
  const block = $("credBlock");
  const group = $("credGroup");
  if (creds.length === 0) {
    block.hidden = true;
    group.innerHTML = "";
    return;
  }
  block.hidden = false;
  group.innerHTML = creds
    .map((c) => {
      const isUsb = c.transport === "usb";
      const icon = isUsb ? ICONS.key : ICONS.fingerprint;
      const factor = isUsb ? "Security key" : "Touch ID";
      const count = Number(c.signCount).toLocaleString();
      return `<div class="row">
        <span class="ico">${icon}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(factor)}</div>
          <div class="row-desc">${escapeHtml(c.transport)} · ${escapeHtml(c.rpId)}</div>
        </div>
        <span class="val">${count}</span>
      </div>`;
    })
    .join("");
}

function setSwitch(el, on) {
  el.setAttribute("aria-checked", on ? "true" : "false");
}
function renderToggles(s) {
  setSwitch($("tgEnabled"), s.enabled);
  setSwitch($("tgTrust"), s.trustClick);
  setSwitch($("tgToast"), s.toast);
}

function renderEnroll(enroll) {
  const armed = !!enroll.armed;
  $("enrollChoose").hidden = armed;
  $("enrollArmed").hidden = !armed;
  if (armed) {
    $("enrollPanel").hidden = false; // keep the armed state visible across reloads
    $("enrollFactorName").textContent = enroll.transport === "usb" ? "security key" : "Touch ID";
  }
}

async function refresh() {
  const [creds, settings, enroll] = await Promise.all([loadStored(), loadSettings(), loadEnroll()]);
  renderHero(creds, settings);
  renderCreds(creds);
  renderToggles(settings);
  renderEnroll(enroll);
}

// ── toggles ──
function bindToggle(el, key) {
  el.addEventListener("click", async () => {
    const on = el.getAttribute("aria-checked") !== "true";
    setSwitch(el, on); // optimistic
    await saveSettings({ [key]: on });
    if (key === "enabled") renderHero(await loadStored(), await loadSettings());
  });
}

// ── credential actions ──
async function importPackaged() {
  const msg = $("actMsg");
  try {
    const resp = await fetch(chrome.runtime.getURL("credentials/duo-webauthn.json"));
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
    const creds = extractCredentials(await resp.json());
    await storeCredentials(creds);
    await refresh();
    setMsg(msg, `Imported ${creds.length} credential${creds.length > 1 ? "s" : ""} from the packaged file.`, "ok");
  } catch (e) {
    setMsg(msg, `Couldn't import packaged file: ${e.message} — try Paste JSON instead.`, "err");
  }
}

function togglePasteEditor(show) {
  const ed = $("pasteEditor");
  ed.hidden = show === undefined ? !ed.hidden : !show;
  if (!ed.hidden) $("pasteArea").focus();
}

async function savePasted() {
  const msg = $("actMsg");
  const text = $("pasteArea").value.trim();
  if (!text) {
    setMsg(msg, "Paste the credential JSON first.", "warn");
    return;
  }
  try {
    const creds = extractCredentials(JSON.parse(text));
    await storeCredentials(creds);
    $("pasteArea").value = "";
    togglePasteEditor(false);
    await refresh();
    setMsg(msg, `Saved ${creds.length} credential${creds.length > 1 ? "s" : ""}.`, "ok");
  } catch (e) {
    setMsg(msg, `Invalid JSON: ${e.message}`, "err");
  }
}

async function resync() {
  const msg = $("actMsg");
  const creds = await loadStored();
  if (!creds.length) {
    setMsg(msg, "No credentials loaded to resync.", "warn");
    return;
  }
  for (const c of creds) {
    if ((Number(c.signCount) || 0) < RESYNC_TARGET) c.signCount = RESYNC_TARGET;
  }
  await storeCredentials(creds);
  await refresh();
  setMsg(msg, `Counters bumped to at least ${RESYNC_TARGET.toLocaleString()}. Retry your login.`, "ok");
}

// Two-step inline confirm — no native confirm() dialog.
let clearArmed = false;
let clearTimer = null;
function resetClear() {
  clearArmed = false;
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  $("clearLabel").textContent = "Clear credentials";
  $("actClear").classList.remove("confirming");
}
async function clearCreds() {
  if (!clearArmed) {
    clearArmed = true;
    $("clearLabel").textContent = "Tap again to confirm";
    $("actClear").classList.add("confirming");
    clearTimer = setTimeout(resetClear, 3000);
    return;
  }
  resetClear();
  await chrome.storage.local.remove(STORAGE_KEY);
  await refresh();
  setMsg($("actMsg"), "Cleared stored credentials.", "warn");
}

// ── enrollment (one-shot capture of a Duo create() ceremony) ──
async function armEnroll(transport) {
  await chrome.storage.local.set({ [ENROLL_KEY]: { armed: true, transport } });
  await refresh();
  $("enrollPanel").hidden = false;
  setMsg($("enrollMsg"), "Armed — add the factor in Duo now. This page updates the moment it’s captured.", "ok");
}
async function cancelEnroll() {
  await chrome.storage.local.set({ [ENROLL_KEY]: { armed: false } });
  await refresh();
  setMsg($("enrollMsg"), "Enrollment cancelled.", "warn");
}

// ── wire up ──
bindToggle($("tgEnabled"), "enabled");
bindToggle($("tgTrust"), "trustClick");
bindToggle($("tgToast"), "toast");

$("actImport").addEventListener("click", importPackaged);
$("actPaste").addEventListener("click", () => togglePasteEditor());
$("pasteSave").addEventListener("click", savePasted);
$("pasteCancel").addEventListener("click", () => {
  $("pasteArea").value = "";
  togglePasteEditor(false);
});
$("actResync").addEventListener("click", resync);
$("actClear").addEventListener("click", clearCreds);

$("actEnroll").addEventListener("click", () => {
  const p = $("enrollPanel");
  p.hidden = !p.hidden;
});
$("enrollInternal").addEventListener("click", () => armEnroll("internal"));
$("enrollUsb").addEventListener("click", () => armEnroll("usb"));
$("enrollCancel").addEventListener("click", cancelEnroll);

// The capture happens in another tab (on duosecurity.com), so reflect storage
// writes live: refresh on any change, and celebrate when an armed enrollment
// flips off with a newly-saved credential.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const e = changes[ENROLL_KEY];
  const captured =
    e &&
    e.oldValue &&
    e.oldValue.armed === true &&
    (!e.newValue || e.newValue.armed === false) &&
    !!changes[STORAGE_KEY];
  if (changes[STORAGE_KEY] || changes[SETTINGS_KEY] || e) refresh();
  if (captured) {
    $("enrollPanel").hidden = true;
    setMsg($("enrollMsg"), "Credential captured and saved — autopilot is armed.", "ok");
  }
});

refresh();
