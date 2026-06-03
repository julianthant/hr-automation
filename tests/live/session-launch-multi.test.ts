import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { Session } from "../../src/core/kernel/session.js";
import { launchBrowser } from "../../src/infra/browser/launch.js";
import { separationsWorkflow } from "../../src/workflows/separations/workflow.js";
import type { SystemConfig } from "../../src/core/kernel/types.js";

/**
 * LIVE multi-system auth (Rung 1, concurrency). Exercises the production
 * **parallel-staggered Duo** path that `Session.launch` uses for any ≥2-system
 * workflow — the one the dashboard/daemon actually run, and the one nothing else
 * live covers:
 *
 *   - parallel `prepareLogin` (navigate + fill every SSO form concurrently),
 *   - a `settleMs` pause before the first Submit,
 *   - `staggerMs`-spaced Submit clicks,
 *   - the `maxConcurrentDuos` semaphore (one phone prompt in flight at a time).
 *
 * `tests/live/auth.test.ts` logs into each SSO flow INDEPENDENTLY (one browser,
 * one flow at a time). `tests/integration/core/mock-workflow.test.ts` covers the
 * staggered ordering but with STUBBED logins. Neither hits the real concurrent
 * multi-system auth path — that is this test's unique value.
 *
 * System pair: **kuali + old-kronos** from `separationsWorkflow.config.systems`
 * — a representative ≥2-system pair, each with a real `prepareLogin` + Duo
 * `login`. We deliberately drop the workflow's `ucpath`/`new-kronos` systems to
 * keep wall time well under the 180s pool timeout (two Duos, not four) while
 * still proving the multi-system staggered path. old-kronos uses a persistent
 * `sessionDir`, so a warm UKG session may approve hands-off (cached trust) —
 * either way the staggered submit machinery is exercised.
 *
 * Duo is approved hands-off via the enrolled WebAuthn credential
 * (`HR_AUTOMATION_DUO_WEBAUTHN=1`, set in `_setup.ts`). READ-ONLY: lands on the
 * authenticated landing pages, performs no workflow action, emits no tracker
 * rows. Skips cleanly when preconditions are absent so a fresh clone / CI never
 * fails or hangs on a manual Duo prompt. Headless by default; HR_TEST_HEADED=1
 * to watch.
 */
const credsPresent = Boolean(process.env.UCPATH_USER_ID && process.env.UCPATH_PASSWORD);
const credentialFilePresent = existsSync(".auth/duo-webauthn.json");
const ready = credsPresent && credentialFilePresent;
const headless = process.env.HR_TEST_HEADED !== "1";

if (!ready) {
  // Visible reason in the runner output (this pool has no log-audit).
  console.log(
    `[live/session-launch-multi] SKIPPED — ${!credsPresent ? "UCPATH_USER_ID/PASSWORD missing in .env" : ".auth/duo-webauthn.json missing (run npm run duo:webauthn:enroll)"}`,
  );
}

// The kuali + old-kronos pair from separations — a clean ≥2-system set with a
// real prepareLogin + Duo login on each. Pulled straight from the production
// workflow config so this test stays faithful to what ships.
const SELECTED_SYSTEM_IDS = ["kuali", "old-kronos"] as const;
const systems: SystemConfig[] = separationsWorkflow.config.systems.filter((s) =>
  (SELECTED_SYSTEM_IDS as readonly string[]).includes(s.id),
);

// `Session.launch`'s built-in `defaultLaunchOne` always launches HEADED (it
// doesn't thread a headless flag into `launchBrowser`). Provide a launchFn that
// mirrors it but honors `headless` so this test runs unattended by default.
// Carries through each system's `sessionDir` / `acceptDownloads` so old-kronos's
// persistent UKG profile is reused exactly as in production.
const launchFn = async ({ system }: { system: SystemConfig }) => {
  const { browser, context, page } = await launchBrowser({
    headless,
    sessionDir: system.sessionDir,
    acceptDownloads: system.acceptDownloads,
  });
  return { page, context, browser };
};

describe.skipIf(!ready)(
  `live multi-system auth — parallel-staggered hands-off Duo across [${SELECTED_SYSTEM_IDS.join(", ")}] (${headless ? "headless" : "headed"})`,
  () => {
    it("authenticates ≥2 systems hands-off via the parallel-staggered path", async () => {
      assert.ok(
        systems.length >= 2,
        `expected ≥2 systems for the parallel-staggered path, resolved ${systems.length} from separations (${systems.map((s) => s.id).join(", ") || "<none>"})`,
      );

      // PRODUCTION DEFAULTS, stated explicitly: settle 2s, stagger 5s, one Duo
      // in flight at a time (the operator sees a single phone prompt). This is
      // exactly the staggered, one-Duo-at-a-time path the dashboard/daemon run.
      // With only 2 systems the wall time is ~settle + stagger + 2 sequential
      // Duos — comfortably under the 180s pool timeout, so we keep the real
      // defaults rather than lowering them.
      const session = await Session.launch(systems, {
        settleMs: 2_000,
        staggerMs: 5_000,
        maxConcurrentDuos: 1,
        launchFn,
      });

      try {
        // `session.page(id)` awaits each system's readyPromise (resolves only
        // after that system's auth completes; rejects if auth failed) and then
        // returns the authenticated Page. Awaiting BOTH proves the full
        // parallel-staggered chain cleared for every system.
        const pages = await Promise.all(systems.map((s) => session.page(s.id)));

        // Each page must have left the SSO/Duo gauntlet — assert it's NOT
        // parked on a Shibboleth/Duo URL. (A login function only resolves on
        // its authenticated landing page, but pin the URL too so a future
        // regression that resolves early on the Duo prompt is caught.)
        for (let i = 0; i < systems.length; i++) {
          const url = pages[i].url();
          assert.ok(
            !/a5\.ucsd\.edu|duosecurity\.com|shibboleth|\/idp\//i.test(url),
            `system '${systems[i].id}' did not reach an authenticated page — still on an SSO/Duo URL: ${url}`,
          );
        }
      } finally {
        // Clean teardown — graceful `session.close()` closes every context +
        // browser. NEVER force-kill (killChromeHard / SIGKILL) here: a hard
        // kill mid-ceremony desyncs the WebAuthn signCount and makes Duo reject
        // the next assertion as a clone (see tests/CLAUDE.md +
        // docs/engineering/hands-off-duo-webauthn.md §6). The pool's 180s
        // timeout gives close() ample headroom; by the time we reach here both
        // Duos have already cleared, so no ceremony is in flight.
        await session.close();
      }
    });
  },
);
