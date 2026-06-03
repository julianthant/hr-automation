import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { launchBrowser } from "../../src/infra/browser/launch.js";
import { DUO_LOGIN_FLOWS } from "../../src/infra/auth/duo-login-flows.js";

/**
 * LIVE auth smoke (Rung 1). For each of the six UCSD Shibboleth/Duo SSO flows:
 * launch a fresh real Chromium, run the real login function, and assert it
 * reached the authenticated landing page. Duo is approved hands-off via the
 * enrolled WebAuthn credential (`HR_AUTOMATION_DUO_WEBAUTHN=1`, set in
 * `_setup.ts`). The login function's own logs are the evidence trail.
 *
 * This is the unique-value test the rest of the suite can't give: it catches
 * SSO/Duo DOM drift and verifies hands-off auth still works end to end on the
 * real sites. It hits live systems but is READ-ONLY (lands on a home/landing
 * page, performs no workflow action) and emits no tracker rows.
 *
 * Skips cleanly when preconditions are absent so a checkout without creds /
 * the WebAuthn key (e.g. CI, a fresh clone) doesn't fail or hang on manual Duo.
 *
 * Headless by default; set HR_TEST_HEADED=1 to watch it run.
 */
const credsPresent = Boolean(process.env.UCPATH_USER_ID && process.env.UCPATH_PASSWORD);
const credentialFilePresent = existsSync(".auth/duo-webauthn.json");
const ready = credsPresent && credentialFilePresent;
const headless = process.env.HR_TEST_HEADED !== "1";

if (!ready) {
  // Visible reason in the runner output (this pool has no log-audit).
  console.log(
    `[live/auth] SKIPPED — ${!credsPresent ? "UCPATH_USER_ID/PASSWORD missing in .env" : ".auth/duo-webauthn.json missing (run npm run duo:webauthn:enroll)"}`,
  );
}

describe.skipIf(!ready)(
  `live auth smoke — hands-off Duo across ${DUO_LOGIN_FLOWS.length} SSO flows (${headless ? "headless" : "headed"})`,
  () => {
    for (const flow of DUO_LOGIN_FLOWS) {
      it(`logs into ${flow.label} hands-off`, async () => {
        const session = await launchBrowser({ headless });
        try {
          const ok = await flow.run(session.page);
          assert.ok(
            ok,
            `${flow.label} login did not reach its authenticated landing page (returned falsy). ` +
              `Check the logs above for where the SSO/Duo flow stalled.`,
          );
        } finally {
          await session.browser?.close();
        }
      });
    }
  },
);
