import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { armDuoBeforeSsoNavigation } from "../../../../src/infra/auth/duo-webauthn.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * Regression pin for the 2026-08-05 SharePoint dead-end.
 *
 * A Duo prompt auto-fires a discoverable-passkey `get()` on load. If no virtual
 * authenticator exists at that moment, Chrome raises its NATIVE "insert your
 * security key" dialog — browser chrome that `keyboard.press("Escape")` cannot
 * dismiss (that key event goes to the renderer) and that swallows the DOM click
 * path `selectDuoFactor` needs. Arming afterwards cannot answer the pending
 * request either. So the arm MUST happen before the click that navigates to Duo.
 *
 * `clickSsoSubmit` (Shibboleth) always did this. The UCSD ADFS path used by
 * SharePoint / OneDrive did not, so every SharePoint login fell back to a manual
 * Duo that no push satisfies and timed out — while UCPath / CRM / Kuali stayed
 * hands-off, which is why it went unnoticed. These assertions are ordering
 * assertions on purpose: "calls it somewhere" is not the invariant.
 */

test("ADFS submit arms the Duo authenticator BEFORE clicking submit", () => {
  const src = read("src/workflows/sharepoint-download/download.ts");
  const body = src.slice(
    src.indexOf("async function handleAdfsLogin"),
    src.indexOf("export async function loginToSharePoint"),
  );
  assert.ok(body.length > 0, "handleAdfsLogin not found — did it get renamed?");

  const armAt = body.indexOf("armDuoBeforeSsoNavigation(");
  const clickAt = body.indexOf("adfs.submitButton(");

  assert.notEqual(armAt, -1, "handleAdfsLogin must arm Duo WebAuthn before submitting");
  assert.notEqual(clickAt, -1, "handleAdfsLogin no longer clicks adfs.submitButton");
  assert.ok(
    armAt < clickAt,
    "handleAdfsLogin must arm BEFORE the submit click — arming after it cannot answer "
      + "the Duo prompt's already-pending WebAuthn request",
  );
});

test("Shibboleth submit arms the Duo authenticator BEFORE clicking submit", () => {
  const src = read("src/infra/auth/sso-fields.ts");
  const body = src.slice(src.indexOf("export async function clickSsoSubmit"));

  const armAt = body.indexOf("armDuoBeforeSsoNavigation(");
  const clickAt = body.indexOf("SSO_SUBMIT_SELECTOR");

  assert.notEqual(armAt, -1, "clickSsoSubmit must arm Duo WebAuthn before submitting");
  assert.notEqual(clickAt, -1, "clickSsoSubmit no longer clicks SSO_SUBMIT_SELECTOR");
  assert.ok(armAt < clickAt, "clickSsoSubmit must arm BEFORE the submit click");
});

test("both SSO front-ends arm through the one shared helper", () => {
  // The helper exists so a new front-end cannot quietly reimplement (or omit)
  // the arming block the way the ADFS path did. Neither call site may go back
  // to calling armDuoWebAuthn directly.
  for (const rel of [
    "src/infra/auth/sso-fields.ts",
    "src/workflows/sharepoint-download/download.ts",
  ]) {
    const src = read(rel);
    assert.ok(
      src.includes("armDuoBeforeSsoNavigation("),
      `${rel} must arm via armDuoBeforeSsoNavigation`,
    );
    assert.ok(
      !src.includes("armDuoWebAuthn("),
      `${rel} must not call armDuoWebAuthn directly — use armDuoBeforeSsoNavigation`,
    );
  }
});

test("armDuoBeforeSsoNavigation is inert when hands-off Duo is disabled", async () => {
  const prev = process.env.HR_AUTOMATION_DUO_WEBAUTHN;
  process.env.HR_AUTOMATION_DUO_WEBAUTHN = "0";
  try {
    // Any property access on the page would throw — proving the disabled path
    // touches neither the page nor CDP before returning.
    const page = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`page.${String(prop)} must not be touched when Duo WebAuthn is off`);
        },
      },
    ) as never;

    await armDuoBeforeSsoNavigation(page, { label: "test" });
  } finally {
    if (prev === undefined) delete process.env.HR_AUTOMATION_DUO_WEBAUTHN;
    else process.env.HR_AUTOMATION_DUO_WEBAUTHN = prev;
  }
});
