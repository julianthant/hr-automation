// ISOLATED-world content script on *.duosecurity.com. Two jobs:
//   1. Bridge — relay the MAIN-world shim's sign requests to the service worker.
//   2. Trust-click — after Duo approves, click "Yes, this is my device" so the
//      remembered-device cookie is set and Duo prompts less often.
// Carries only opaque base64 strings; no key material, no crypto.

(() => {
  // ── 1. Bridge ──
  // Relay a MAIN-world request type to the service worker and post the reply back
  // on the matching response type. Used for both assertions (sign) and the
  // enrollment ceremony (create) — only opaque base64 crosses here.
  function bridge(reqType, resType, runtimeType) {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.type !== reqType || typeof d.nonce !== "number") return;

      chrome.runtime.sendMessage({ type: runtimeType, request: d.request }, (response) => {
        const err = chrome.runtime.lastError;
        window.postMessage(
          {
            type: resType,
            nonce: d.nonce,
            response: err ? { ok: false, reason: err.message } : response,
          },
          window.location.origin,
        );
      });
    });
  }
  bridge("DUO_AUTOPILOT_REQ", "DUO_AUTOPILOT_RES", "DUO_AUTOPILOT_SIGN");
  bridge("DUO_AUTOPILOT_ENROLL_REQ", "DUO_AUTOPILOT_ENROLL_RES", "DUO_AUTOPILOT_ENROLL");

  // ── 2. Trust-screen auto-click ──
  // Match only the affirmative control ("Yes, this is my device" / "Yes, trust
  // browser"), never the "No, other people use this device" one.
  const TRUST_RE = /yes,\s*(this is my device|trust)/i;
  let trustClicked = false;
  let observer = null;

  function findTrustControl() {
    const sel = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
    for (const el of document.querySelectorAll(sel)) {
      const text = (el.innerText || el.textContent || el.value || "").trim();
      if (TRUST_RE.test(text)) return el;
    }
    return null;
  }

  function tryTrustClick() {
    if (trustClicked) return;
    const el = findTrustControl();
    if (!el) return;
    trustClicked = true;
    if (observer) observer.disconnect();
    try {
      el.click();
      console.debug("[Duo Autopilot] clicked trust screen (\"Yes, this is my device\")");
    } catch (_) {}
  }

  async function startTrustWatcher() {
    let settings = {};
    try {
      ({ settings = {} } = await chrome.storage.local.get("settings"));
    } catch (_) {}
    if (settings.enabled === false || settings.trustClick === false) return; // both default on

    const begin = () => {
      tryTrustClick(); // the screen may already be present
      observer = new MutationObserver(() => tryTrustClick());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // The trust screen is transient; stop watching after a minute regardless.
      setTimeout(() => observer && observer.disconnect(), 60000);
    };
    if (document.documentElement) begin();
    else document.addEventListener("DOMContentLoaded", begin, { once: true });
  }

  startTrustWatcher();
})();
