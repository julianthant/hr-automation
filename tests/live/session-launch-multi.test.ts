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
 * System pair: **kuali + new-kronos** from `separationsWorkflow.config.systems`
 * — a representative ≥2-system pair, each with a real `prepareLogin` + Duo
 * `login`. We deliberately drop the workflow's `ucpath` system to keep wall time
 * well under the pool timeout (two Duos, not three) while still proving the
 * multi-system staggered path. (Old Kronos was removed from separations on
 * 2026-06-18 — separations is now a 3-system New-Kronos-only workflow.)
 *
 * Duo is approved hands-off via the enrolled WebAuthn credential
 * (`HR_AUTOMATION_DUO_WEBAUTHN=1`, set in `_setup.ts`). READ-ONLY: lands on the
 * authenticated landing pages, performs no workflow action, emits no tracker
 * rows. Skips cleanly when preconditions are absent so a fresh clone / CI never
 * fails or hangs on a manual Duo prompt. Headless by default; HR_TEST_HEADED=1
 * to watch.
 *
 * ── SAFETY: fail-fast-and-CLEAN, never hard-killed mid-ceremony ──
 * The hands-off WebAuthn path drives a CDP virtual authenticator per browser.
 * If anything stalls (e.g. a Duo prompt that never auto-fires, or two concurrent
 * browsers contending for shared WebAuthn state), a poll could otherwise hang to
 * the pool's 180s `testTimeout`, which `kill -9`s the worker MID-CEREMONY and
 * **desyncs the WebAuthn signCount** — Duo then rejects the next assertion as a
 * cloned key (see docs/engineering/hands-off-duo-webauthn.md §6). To make that
 * impossible, this test arms its OWN abort well under the pool timeout
 * (`INTERNAL_ABORT_MS`) and threads it through `Session.launch`'s `abortSignal`.
 * On abort, the kernel's Duo wait unwinds through `pollDuoApproval`, which now
 * finalizes WebAuthn (persists signCount + tears the authenticator down) on the
 * abort/throw path too — so even a forced abort exits the ceremony CLEANLY. The
 * test then fails fast with a precise message instead of hanging.
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

// The kuali + new-kronos pair from separations — a clean ≥2-system set with a
// real prepareLogin + Duo login on each. Pulled straight from the production
// workflow config so this test stays faithful to what ships.
const SELECTED_SYSTEM_IDS = ["kuali", "new-kronos"] as const;
const systems: SystemConfig[] = separationsWorkflow.config.systems.filter((s) =>
  (SELECTED_SYSTEM_IDS as readonly string[]).includes(s.id),
);

// Internal safety deadline — fires our own abort BEFORE the pool's 180s
// testTimeout so a stalled hands-off ceremony fails fast and exits cleanly
// (signCount persisted) instead of being hard-killed mid-flight. Two staggered
// Duos that both auto-fire complete in well under this; if we hit it, auth is
// genuinely stuck and aborting is the correct, safe outcome.
const INTERNAL_ABORT_MS = 90_000;

// `Session.launch`'s built-in `defaultLaunchOne` always launches HEADED (it
// doesn't thread a headless flag into `launchBrowser`). Provide a launchFn that
// mirrors it but honors `headless` so this test runs unattended by default.
// Carries through each system's `sessionDir` / `acceptDownloads` so any
// persistent profile is reused exactly as in production.
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
    it(
      "authenticates ≥2 systems hands-off via the parallel-staggered path",
      async () => {
        assert.ok(
          systems.length >= 2,
          `expected ≥2 systems for the parallel-staggered path, resolved ${systems.length} from separations (${systems.map((s) => s.id).join(", ") || "<none>"})`,
        );

        // SAFETY ABORT — fires under the pool timeout so a stalled ceremony
        // unwinds cleanly (finishDuoWebAuthn persists the signCount) instead of
        // being hard-killed. Cleared in `finally` so a fast success doesn't keep
        // the worker alive on a pending timer.
        const abortController = new AbortController();
        const abortTimer = setTimeout(() => {
          abortController.abort(
            new Error(
              `multi-system hands-off auth did not complete within ${INTERNAL_ABORT_MS}ms — aborting to exit the Duo ceremony cleanly before the pool hard-kill (see test header §SAFETY)`,
            ),
          );
        }, INTERNAL_ABORT_MS);
        abortTimer.unref?.();

        // PRODUCTION DEFAULTS, stated explicitly: settle 2s, stagger 5s, one Duo
        // in flight at a time (the operator sees a single phone prompt). This is
        // exactly the staggered, one-Duo-at-a-time path the dashboard/daemon run.
        const session = await Session.launch(systems, {
          settleMs: 2_000,
          staggerMs: 5_000,
          maxConcurrentDuos: 1,
          launchFn,
          abortSignal: abortController.signal,
        });

        try {
          // `session.page(id)` awaits each system's readyPromise (resolves only
          // after that system's auth completes; rejects if auth failed) and then
          // returns the authenticated Page. Awaiting BOTH proves the full
          // parallel-staggered chain cleared for every system. If the abort
          // fires first, these reject with the abort reason — a fast, clean
          // failure rather than a hang.
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
          clearTimeout(abortTimer);
          // Clean teardown — graceful `session.close()` closes every context +
          // browser. NEVER force-kill (killChromeHard / SIGKILL) here: a hard
          // kill mid-ceremony desyncs the WebAuthn signCount and makes Duo reject
          // the next assertion as a clone (see tests/CLAUDE.md +
          // docs/engineering/hands-off-duo-webauthn.md §6). On the abort path the
          // kernel has already finalized WebAuthn cleanly via pollDuoApproval's
          // abort handling, and `Session.launch` returned a Session whose
          // browsers we still own and must close.
          await session.close();
        }
      },
      // Per-test timeout — a hair under the pool's 180s default but ABOVE our
      // internal abort. The internal abort always trips first and unwinds the
      // ceremony cleanly; this is only a backstop so the test can't outlive the
      // pool's own kill window even if teardown itself stalled.
      INTERNAL_ABORT_MS + 30_000,
    );
  },
);
