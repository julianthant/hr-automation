import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { classifyI9LoginResult } from "../../../../src/systems/i9/login.js";

/**
 * Pins the i9 post-login outcome classification (i9 ISS-006). Before this,
 * `loginToI9` only `waitForURL`'d for the success host, so a rejected
 * credential surfaced as an opaque `page.waitForURL: Timeout 15000ms exceeded`
 * after three 15s waits — masking a stale `I9_PASSWORD` as a navigation bug.
 * The classifier makes a credential rejection fail loud with an actionable
 * message. Behaviour confirmed live 2026-06-24 (the page bounced to
 * `/Account/Login` showing "The username or password provided was incorrect.").
 */
describe("classifyI9LoginResult", () => {
  it("returns ok on the authenticated host (wwwe.i9complete.com)", () => {
    const r = classifyI9LoginResult({
      url: "https://wwwe.i9complete.com/Dashboard",
      errorText: null,
    });
    assert.deepStrictEqual(r, { ok: true });
  });

  it("fails loud with the on-page error text + .env hint when credentials are rejected", () => {
    const r = classifyI9LoginResult({
      url: "https://stse.i9complete.com/Account/Login",
      errorText: "The username or password provided was incorrect.",
    });
    assert.equal(r.ok, false);
    assert.ok(
      !r.ok && r.message.includes("The username or password provided was incorrect."),
      `expected the on-page error in the message, got: ${!r.ok ? r.message : "(ok)"}`,
    );
    assert.ok(!r.ok && r.message.includes("I9_PASSWORD"), "expected the .env credential hint");
  });

  it("fails loud on a bounce back to /Account/Login even without error text", () => {
    const r = classifyI9LoginResult({
      url: "https://stse.i9complete.com/Account/Login",
      errorText: null,
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /returned to the sign-in page/i.test(r.message));
    assert.ok(!r.ok && r.message.includes("I9_PASSWORD"));
  });

  it("reports a navigation timeout when neither success nor a login error is seen", () => {
    const r = classifyI9LoginResult({
      url: "https://stse.i9complete.com/",
      errorText: null,
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /did not reach wwwe\.i9complete\.com/i.test(r.message));
    assert.ok(!r.ok && r.message.includes("https://stse.i9complete.com/"));
  });

  it("treats a malformed URL as a non-success (does not throw on URL parse)", () => {
    const r = classifyI9LoginResult({ url: "not-a-url", errorText: null });
    assert.equal(r.ok, false);
  });
});
