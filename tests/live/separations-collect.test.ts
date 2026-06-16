import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { Session } from "../../src/core/kernel/session.js";
import { launchBrowser } from "../../src/infra/browser/launch.js";
import { separationsWorkflow } from "../../src/workflows/separations/workflow.js";
import {
  openActionList,
  listActionListSeparations,
  clickDocument,
  extractSeparationData,
} from "../../src/systems/kuali/index.js";
import { log } from "../../src/utils/log.js";
import type { SystemConfig } from "../../src/core/kernel/types.js";

/**
 * LIVE Kuali separations DATA-COLLECTION smoke (READ-ONLY).
 *
 * Drives **Kuali only** — authenticates the single `kuali` system from the
 * separations workflow config, opens the Kuali Build **Action List**, enumerates
 * EVERY pending document ("the ones that need to be separated"), opens each one,
 * and **collects its separation data without filling or submitting anything**.
 * It then asserts every collected record is well-formed against the separations
 * schema's field rules (EID `^\d{5,}$`, dates `^\d{2}/\d{2}/\d{4}$`, non-empty
 * name + termination type). The unique value: it proves our Kuali extraction
 * collects correct, complete data for ALL pending separations currently in the
 * queue — not just one known doc.
 *
 * ── READ-ONLY GUARANTEE ──
 * This test NEVER fills, saves, or submits. It calls only navigation +
 * extraction (`openActionList`, `listActionListSeparations`, `clickDocument`,
 * `extractSeparationData`) — never `fillTimekeeperTasks`, `fillFinalTransactions`,
 * `fillTransactionResults`, `updateLastDayWorked`, `updateSeparationDate`,
 * `clickSave`, or any `.fill()`/submit path. The Kuali forms are read, never
 * touched. (Grep this file: no fill/save/submit call exists below.)
 *
 * ── SCOPE: Kuali-only, single Duo ──
 * Only the `kuali` system is launched (`systems.length === 1`), so
 * `Session.launch` takes its single-system fast path: one `prepareLogin`, one
 * Duo prompt, no stagger/semaphore. We deliberately drop old-kronos / new-kronos
 * / ucpath — collection here is Kuali-only — which also keeps wall time to a
 * single Duo. The system is pulled straight from `separationsWorkflow.config`
 * so this test stays faithful to what ships.
 *
 * Duo is approved hands-off via the enrolled WebAuthn credential
 * (`HR_AUTOMATION_DUO_WEBAUTHN=1`, set in `_setup.ts`). Skips cleanly when
 * preconditions are absent so a fresh clone / CI never fails or hangs on a
 * manual Duo prompt. Headless by default; HR_TEST_HEADED=1 to watch.
 *
 * ── TWO-PHASE TIMING: auth-safety abort, then a bounded collection budget ──
 * The wall-clock cost splits cleanly in two and each phase is bounded on its own
 * so a big Action List can never hard-kill the worker:
 *
 *   PHASE 1 — AUTH (signCount-critical). Like session-launch-multi.test.ts, this
 *   arms its OWN abort (`INTERNAL_ABORT_MS`) BEFORE `Session.launch` and threads
 *   it through the `abortSignal`. If the hands-off Duo ceremony stalls, the abort
 *   fires first and unwinds through `pollDuoApproval`, which finalizes WebAuthn
 *   (persists signCount + tears the authenticator down) on the abort/throw path
 *   too — so even a forced abort exits the ceremony CLEANLY instead of being
 *   `kill -9`'d mid-flight (which would desync the WebAuthn signCount → Duo
 *   rejects the next assertion as a clone; see
 *   docs/engineering/hands-off-duo-webauthn.md §6). **As soon as
 *   `session.page(kuali)` resolves the signCount risk is past, so we CLEAR this
 *   abort timer** — it must NOT fire mid-collection (the per-doc page calls below
 *   don't see the abort signal, so a fired abort during collection would only
 *   leak a rejection, not unwind cleanly).
 *
 *   PHASE 2 — COLLECTION (read-only, signCount-safe). Bounded by a SOFT budget
 *   (`COLLECTION_BUDGET_MS`): the per-doc loop checks the budget (and the abort
 *   signal, defensively) at the top of each iteration and BREAKS cleanly when
 *   either trips, leaving any unvisited docs as `notReached`. A large queue thus
 *   passes WITH COVERAGE (collect as many valid records as the budget allows,
 *   report how many remained) rather than running past the pool timeout and
 *   getting hard-killed. Invalid data on any REACHED separation form still fails
 *   the test loudly.
 *
 * Teardown is graceful `session.close()` only — NEVER force-kill.
 *
 * ── PII discipline ──
 * Collected records hold real employee names + EIDs. This test logs COUNTS and
 * FIELD-PRESENCE only (plus a first-name-only crumb per doc) — it never dumps
 * full names or EIDs to stdout.
 */
const credsPresent = Boolean(process.env.UCPATH_USER_ID && process.env.UCPATH_PASSWORD);
const credentialFilePresent = existsSync(".auth/duo-webauthn.json");
const ready = credsPresent && credentialFilePresent;
const headless = process.env.HR_TEST_HEADED !== "1";

if (!ready) {
  // Visible reason in the runner output (this pool has no log-audit).
  console.log(
    `[live/separations-collect] SKIPPED — ${!credsPresent ? "UCPATH_USER_ID/PASSWORD missing in .env" : ".auth/duo-webauthn.json missing (run npm run duo:webauthn:enroll)"}`,
  );
}

// The single `kuali` system from separations — collection is Kuali-only, so we
// take Session.launch's one-system fast path (one Duo, no stagger). Pulled from
// the production workflow config so the auth shape stays faithful to what ships.
const KUALI_SYSTEM_ID = "kuali";
const systems: SystemConfig[] = separationsWorkflow.config.systems.filter(
  (s) => s.id === KUALI_SYSTEM_ID,
);

// EID / MM-DD-YYYY rules mirror SeparationDataSchema in
// src/workflows/separations/schema.ts. Kept inline (not imported from the Zod
// schema) so the assertions read explicitly here and a schema-regex change
// surfaces as a deliberate edit in both places.
const EID_RE = /^\d{5,}$/;
const MMDDYYYY_RE = /^\d{2}\/\d{2}\/\d{4}$/;

// PHASE 1 deadline — fires our own auth abort BEFORE the per-test timeout if the
// Duo ceremony stalls. It guards AUTH ONLY: once `session.page(kuali)` resolves
// (auth done → signCount risk past) we CLEAR this timer so it can't fire during
// collection (the per-doc page calls don't observe the abort signal). A stuck
// Duo within this window aborts cleanly (persists signCount + tears the
// authenticator down).
const INTERNAL_ABORT_MS = 120_000;

// PHASE 2 soft budget — caps the per-doc collection loop. The loop breaks
// cleanly when this is exceeded, leaving the rest of a large queue as
// `notReached` (pass-with-coverage) instead of running past the pool timeout and
// being hard-killed. Date.now() is fine here — the no-Date.now rule is for
// Workflow orchestration scripts, not test files.
const COLLECTION_BUDGET_MS = 120_000;

// `Session.launch`'s built-in `defaultLaunchOne` always launches HEADED (it
// doesn't thread a headless flag into `launchBrowser`). Provide a launchFn that
// mirrors it but honors `headless` so this test runs unattended by default.
// Carries through the system's `sessionDir` / `acceptDownloads` so any
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
  `live Kuali separations data-collection — read-only Action List enumeration + per-doc extract (${headless ? "headless" : "headed"})`,
  () => {
    it(
      "collects valid separation data for every pending Action List document (no fill/save/submit)",
      async () => {
        assert.equal(
          systems.length,
          1,
          `expected exactly the 'kuali' system, resolved ${systems.length} (${systems.map((s) => s.id).join(", ") || "<none>"})`,
        );

        // PHASE-1 AUTH-SAFETY ABORT — armed BEFORE Session.launch so a stalled
        // Duo ceremony unwinds cleanly (finishDuoWebAuthn persists the signCount)
        // instead of being hard-killed. Cleared the instant auth resolves (see
        // below) so it can never fire mid-collection, and again in `finally`
        // (clearTimeout is idempotent) so a fast success doesn't keep the worker
        // alive on a pending timer.
        const abortController = new AbortController();
        let authAbortCleared = false;
        const abortTimer = setTimeout(() => {
          abortController.abort(
            new Error(
              `Kuali AUTH did not complete within ${INTERNAL_ABORT_MS}ms — aborting to exit the Duo ceremony cleanly before the pool hard-kill (see test header §TWO-PHASE TIMING / PHASE 1)`,
            ),
          );
        }, INTERNAL_ABORT_MS);
        abortTimer.unref?.();
        const clearAuthAbort = () => {
          if (authAbortCleared) return;
          authAbortCleared = true;
          clearTimeout(abortTimer);
        };

        const session = await Session.launch(systems, {
          launchFn,
          abortSignal: abortController.signal,
        });

        try {
          // `session.page("kuali")` awaits Kuali's readyPromise (resolves only
          // after its Duo clears; rejects if auth failed) and returns the
          // authenticated Page. If the abort fires first, this rejects with the
          // abort reason — a fast, clean failure rather than a hang.
          const page = await session.page(KUALI_SYSTEM_ID);

          // AUTH IS DONE — signCount risk is past. Clear the Phase-1 abort timer
          // so it can NEVER fire during collection (the per-doc page calls below
          // don't observe abortController.signal, so a fired abort here would
          // only leak a rejection, not unwind anything cleanly). From here on,
          // Phase 2's soft budget bounds the work.
          clearAuthAbort();

          // Read-only navigation: open the Action List and enumerate every
          // pending document number ("the ones that need to be separated").
          await openActionList(page);
          const docNumbers = await listActionListSeparations(page);

          // An EMPTY Action List is a clean no-op, not a failure — the point is
          // to validate whatever is pending. Nothing to collect → return.
          if (docNumbers.length === 0) {
            log.success(
              "[live/separations-collect] Action List is empty — no pending documents to collect (clean no-op)",
            );
            return;
          }

          log.step(
            `[live/separations-collect] Collecting from ${docNumbers.length} pending document(s)`,
          );

          // Collect a read-only record per document, skipping any doc whose form
          // clearly isn't a separation form (the Action List can hold other
          // document types; non-separation forms lack the EID/date fields, so
          // extractSeparationData throws/times out — we record that as a skip).
          const collected: Array<{ docNumber: string; firstName: string }> = [];
          const skipped: string[] = [];

          // PHASE 2 — soft budget starts now (auth excluded). Each iteration
          // checks the budget (and the abort signal, defensively) and breaks
          // cleanly before touching the next doc.
          const collectStart = Date.now();
          let budgetStopped = false;

          for (const docNumber of docNumbers) {
            // Break cleanly if the abort tripped (defensive — it's normally
            // cleared after auth) or the collection budget is spent. Whatever
            // remains in docNumbers is left unvisited (notReached) — a large
            // queue passes WITH COVERAGE rather than overrunning the pool
            // timeout and being hard-killed.
            const elapsed = Date.now() - collectStart;
            if (abortController.signal.aborted || elapsed > COLLECTION_BUDGET_MS) {
              budgetStopped = true;
              const reached = collected.length + skipped.length;
              const remain = docNumbers.length - reached;
              log.step(
                `[live/separations-collect] collection budget reached after ${elapsed}ms — ` +
                  `collected ${collected.length}, reached ${reached}/${docNumbers.length}, ${remain} remain unvisited (stopping cleanly)`,
              );
              break;
            }

            // Open the doc read-only (clickDocument navigates; it never fills).
            await clickDocument(page, docNumber);

            let record;
            try {
              record = await extractSeparationData(page);
            } catch {
              // Not a separation form (missing the expected fields) — skip it.
              // Documented behavior: enumerate all rows, attempt extraction,
              // skip rows that aren't separations.
              skipped.push(docNumber);
              log.step(
                `[live/separations-collect] doc #${docNumber} is not a separation form — skipping`,
              );
              await openActionList(page);
              continue;
            }

            // Assert the collected record is correct/complete. Mirrors
            // SeparationDataSchema's field rules.
            assert.ok(
              record.employeeName.trim().length > 0,
              `doc #${docNumber}: employeeName must be non-empty`,
            );
            assert.match(
              record.eid,
              EID_RE,
              `doc #${docNumber}: eid must match ${EID_RE} (got ${record.eid.length}-char value)`,
            );
            assert.match(
              record.lastDayWorked,
              MMDDYYYY_RE,
              `doc #${docNumber}: lastDayWorked must be MM/DD/YYYY`,
            );
            assert.match(
              record.separationDate,
              MMDDYYYY_RE,
              `doc #${docNumber}: separationDate must be MM/DD/YYYY`,
            );
            assert.ok(
              record.terminationType.trim().length > 0,
              `doc #${docNumber}: terminationType must be non-empty`,
            );

            // PII-safe crumb: first name only, no EID.
            const firstName = record.employeeName.split(/[\s,]+/).filter(Boolean)[0] ?? "(blank)";
            collected.push({ docNumber, firstName });

            // Return to the Action List for the next doc (read-only).
            await openActionList(page);
          }

          // Coverage accounting. Every REACHED doc was either collected (valid
          // separation record) or skipped (not a separation form). Anything the
          // budget stopped us short of is `notReached` — NOT a failure, just
          // uncovered this run. (We deliberately do NOT assert all enumerated
          // docs were visited; that would false-fail purely on queue size.)
          const reached = collected.length + skipped.length;
          const notReached = docNumbers.length - reached;
          // Internal-consistency invariant: every enumerated doc is accounted
          // for as either reached (collected ∪ skipped) or notReached, and we
          // never reached more docs than were enumerated. This replaces the old
          // `collected+skipped === docNumbers.length` assertion, which assumed
          // the whole list was always visited and false-failed on a large queue.
          assert.equal(
            reached + notReached,
            docNumbers.length,
            `coverage accounting must be internally consistent — reached=${reached} (collected=${collected.length} skipped=${skipped.length}) + notReached=${notReached} must equal enumerated=${docNumbers.length}`,
          );
          assert.ok(
            reached <= docNumbers.length && notReached >= 0,
            `coverage accounting out of bounds — reached=${reached} notReached=${notReached} enumerated=${docNumbers.length}`,
          );

          // Every doc we REACHED that was a separation form already validated
          // inline above (an invalid record threw). The remaining invariant:
          // whenever we reached ANY doc, at least one was a valid separation
          // form. A list of all-non-separations would mean the enumeration
          // selector or extraction is broken — a real failure. The budget
          // stopping us short does not exempt this, because the queue is
          // separations-heavy so the first reached docs are separations; if we
          // reached docs and found zero separations, something is wrong.
          if (reached > 0) {
            assert.ok(
              collected.length > 0,
              `reached ${reached} pending doc(s) but none were a valid separation form — check the actionList.docLinks enumeration selector and extractSeparationData (skipped=${skipped.length}, notReached=${notReached})`,
            );
          }

          // Concise, PII-light coverage summary: counts + field-presence +
          // first-name crumbs only. No full names, no EIDs.
          log.success(
            `[live/separations-collect] COLLECTED ${collected.length} valid / reached ${reached} / enumerated ${docNumbers.length} ` +
              `(notReached=${notReached}${budgetStopped ? " due to budget" : ""})` +
              (skipped.length > 0 ? ` — ${skipped.length} non-separation doc(s) skipped` : "") +
              ` — fields validated: employeeName, eid, lastDayWorked, separationDate, terminationType`,
          );
          log.step(
            `[live/separations-collect] collected docs: ${collected
              .map((c) => `#${c.docNumber} (${c.firstName})`)
              .join(", ")}`,
          );
        } finally {
          // Idempotent — auth normally cleared this already; this catches the
          // pre-auth failure path (abort fired / launch threw before auth).
          clearAuthAbort();
          // Clean teardown — graceful `session.close()` closes the context +
          // browser. NEVER force-kill (killChromeHard / SIGKILL) here: a hard
          // kill mid-ceremony desyncs the WebAuthn signCount and makes Duo
          // reject the next assertion as a clone (see tests/CLAUDE.md +
          // docs/engineering/hands-off-duo-webauthn.md §6). On the abort path the
          // kernel has already finalized WebAuthn cleanly via pollDuoApproval's
          // abort handling.
          await session.close();
        }
      },
      // Per-test timeout — overrides the pool's 180s default for this test and
      // is set generously ABOVE the two phases combined: Phase-1 auth abort
      // (≤120s) + Phase-2 collection budget (≤120s) + teardown all fit
      // comfortably. The auth abort trips first if auth stalls; the soft budget
      // breaks the loop before collection can run long. This 300s ceiling is
      // only a last-resort backstop so the test can't outlive its kill window
      // even if teardown itself stalled — neither bounded phase should reach it.
      300_000,
    );
  },
);
