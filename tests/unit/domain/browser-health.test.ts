import { test } from "vitest";
import assert from "node:assert/strict";
import {
  classifyBrowserHealth,
  isLoginLikeUrl,
  isChromeErrorUrl,
  isBlankUrl,
  isRefreshable,
  isReopenable,
} from "../../../src/domain/browser-health.js";

test("classifyBrowserHealth: a closed page is `closed` (reopenable, not fatal)", () => {
  const v = classifyBrowserHealth({ closed: true, url: "", probed: false });
  assert.equal(v.kind, "closed");
  assert.equal(isReopenable(v.kind), true);
});

test("classifyBrowserHealth: an SSO/login url is `expired` (needs re-auth)", () => {
  assert.equal(classifyBrowserHealth({ closed: false, url: "https://a5.ucsd.edu/idp/profile/SAML2", probed: true }).kind, "expired");
  assert.equal(classifyBrowserHealth({ closed: false, url: "https://api-x.duosecurity.com/frame/prompt", probed: true }).kind, "expired");
  // A live JS context on the login page must NOT read as ok — url wins.
  assert.equal(isReopenable("expired"), false);
  assert.equal(isRefreshable("expired"), false);
});

test("classifyBrowserHealth: a chrome-error page is `soft` (refreshable)", () => {
  const v = classifyBrowserHealth({ closed: false, url: "chrome-error://chromewebdata/", probed: false });
  assert.equal(v.kind, "soft");
  assert.equal(isRefreshable(v.kind), true);
  assert.equal(isReopenable(v.kind), true);
});

test("classifyBrowserHealth: about:blank / empty url is `wedged` (reopen, not refresh)", () => {
  assert.equal(classifyBrowserHealth({ closed: false, url: "about:blank", probed: false }).kind, "wedged");
  assert.equal(classifyBrowserHealth({ closed: false, url: "", probed: false }).kind, "wedged");
  assert.equal(isRefreshable("wedged"), false);
  assert.equal(isReopenable("wedged"), true);
});

test("classifyBrowserHealth: an app url whose JS probe failed is `wedged` (dead iframe context)", () => {
  const v = classifyBrowserHealth({ closed: false, url: "https://ucpath.universityofcalifornia.edu/psp/UCPATHHM", probed: false });
  assert.equal(v.kind, "wedged");
});

test("classifyBrowserHealth: an app url with a live JS probe is `ok`", () => {
  const v = classifyBrowserHealth({ closed: false, url: "https://ucpath.universityofcalifornia.edu/psp/UCPATHHM", probed: true });
  assert.equal(v.kind, "ok");
});

test("isLoginLikeUrl: SSO/login hosts match; a normal authenticated UCPath url does not", () => {
  assert.equal(isLoginLikeUrl("https://a5.ucsd.edu/idp/"), true);
  assert.equal(isLoginLikeUrl("https://x.duosecurity.com/frame"), true);
  assert.equal(isLoginLikeUrl("https://idp.example.edu/cas/login"), true);
  // Must NOT false-positive on the authenticated app (the 'ok' health url).
  assert.equal(isLoginLikeUrl("https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/EMPLOYEE/HRMS"), false);
  assert.equal(isLoginLikeUrl(""), false);
});

test("isChromeErrorUrl / isBlankUrl helpers", () => {
  assert.equal(isChromeErrorUrl("chrome-error://chromewebdata/"), true);
  assert.equal(isChromeErrorUrl("https://x/"), false);
  assert.equal(isBlankUrl("about:blank"), true);
  assert.equal(isBlankUrl(""), true);
  assert.equal(isBlankUrl("https://x/"), false);
});
