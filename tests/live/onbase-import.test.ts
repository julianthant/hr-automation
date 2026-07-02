import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../../src/infra/browser/launch.js";
import { loginToOnBase } from "../../src/infra/auth/login.js";
import {
  openImportDocument,
  onbaseSelectors,
  classifyOnbasePage,
} from "../../src/systems/onbase/index.js";

/**
 * LIVE onbase — proves the hardened auth + Import-Document navigation reaches
 * the real import form end-to-end against the production OnBase tenant.
 *
 * These are exactly the two steps that were failing intermittently (per the
 * daemon's own error captures + `.tracker/logs/onbase-2026-07-01.jsonl`):
 *   - `authenticate`   → `loginToOnBase` landing on a bad page ("SSO form did
 *                        not render") when NavPanel served a ViewState-MAC /
 *                        403 / logout page instead of the app.
 *   - `prepare-import` → `openImportDocument` blind-timing-out on the Main Menu
 *                        because the page had reset / errored.
 *
 * The fix classifies the landing (`classifyOnbasePage`) and recovers with a
 * fresh re-nav (transient error) or a clear throw (session death → kernel
 * re-auth). This test asserts the HAPPY path still lands the import form (no
 * regression); the intermittent recovery branches are pinned deterministically
 * by `tests/unit/systems/onbase/{page-state,navigate}.test.ts` +
 * `tests/unit/infra/auth/onbase-login.test.ts` (a live ViewState-MAC error
 * can't be summoned on demand — it's a server-side farm-affinity event).
 *
 * READ-ONLY: opens the import form and screenshots it — never types a UCPath ID,
 * never clicks Import. Nothing is filed. Skips cleanly without creds / the
 * enrolled WebAuthn credential.
 */
const credsPresent = Boolean(process.env.UCPATH_USER_ID && process.env.UCPATH_PASSWORD);
const credentialFilePresent = existsSync(".auth/duo-webauthn.json");
const ready = credsPresent && credentialFilePresent;
const headless = process.env.HR_TEST_HEADED !== "1";

if (!ready) {
  console.log(
    `[live/onbase-import] SKIPPED — ${!credsPresent ? "UCPATH_USER_ID/PASSWORD missing in .env" : ".auth/duo-webauthn.json missing (run npm run duo:webauthn:enroll)"}`,
  );
}

// Auth-safety abort: unwind a stalled Duo cleanly (preserves signCount) instead
// of a hard timeout kill. Cleared the moment login resolves so it can't fire
// during navigation.
const INTERNAL_ABORT_MS = 150_000;

describe.skipIf(!ready)(`live onbase import-form (${headless ? "headless" : "headed"})`, () => {
  it(
    "authenticates and opens the Import Document form (no regression in the hardened nav)",
    async () => {
      const { browser, page } = await launchBrowser({ headless });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), INTERNAL_ABORT_MS);
      try {
        const ok = await loginToOnBase(page, undefined, abort.signal);
        clearTimeout(timer);
        assert.ok(ok, "loginToOnBase returned falsy — did not reach the authenticated NavPanel");

        const state = await classifyOnbasePage(page);
        assert.equal(
          state,
          "authenticated",
          `expected an authenticated NavPanel after login, got "${state}" (URL: ${page.url()})`,
        );

        // The hardened prepare-import path: classify-and-recover into the form.
        await openImportDocument(page);

        // Proof the form actually rendered — the UCPath ID keyword field is
        // inside the import iframe.
        const frame = onbaseSelectors.importForm.frame(page);
        const ucpathIdVisible = await onbaseSelectors.importForm
          .ucpathIdInput(frame)
          .isVisible({ timeout: 10_000 })
          .catch(() => false);
        assert.ok(
          ucpathIdVisible,
          "Import Document form opened but the UCPath ID field was not visible",
        );

        const dir = resolve(".screenshots/onbase");
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: resolve(dir, "live-import-form.png") });
      } finally {
        clearTimeout(timer);
        await browser?.close();
      }
    },
    300_000,
  );
});
