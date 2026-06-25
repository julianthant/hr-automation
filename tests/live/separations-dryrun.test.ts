import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Session } from "../../src/core/kernel/session.js";
import { runOneItem } from "../../src/core/kernel/run-one-item.js";
import { launchBrowser } from "../../src/infra/browser/launch.js";
import { separationsWorkflow } from "../../src/workflows/separations/workflow.js";
import { rowsDir } from "../../src/tracker/paths.js";
import { log } from "../../src/utils/log.js";
import type { SystemConfig } from "../../src/core/kernel/types.js";

/**
 * LIVE separations DRY-RUN terminal proof — the "Workflow e2e" layer
 * `tests/CLAUDE.md` anticipates ("drives `runOneItem` with the tracker pointed
 * at a `mkdtemp` dir … runs in dry-run (no Save/Submit)").
 *
 * Drives the REAL separations workflow against a real, currently-pending Kuali
 * Action List document with `dryRun:true`, through the kernel single-item
 * runner `runOneItem` — NOT the daemon/dashboard. This is deliberately
 * control-plane-free: it bypasses the daemon claim loop / worker-command /
 * control-ops layer entirely (a real `Session` + `runOneItem` + a temp tracker
 * dir), so it proves the live READ path + dry-run write-gate without spawning a
 * daemon. It is the live companion to the deterministic unit coverage in
 * `tests/unit/workflows/separations/dry-run.test.ts`: the unit test pins the
 * guard logic with a hand-rolled ctx + mocked steps; THIS proves the same
 * terminal is reached when the steps are real (live Kuali extract + UCPath Job
 * Summary + New Kronos timecard + date reconciliation).
 *
 * ── SAFETY: dry-run halts BEFORE either irreversible write ──
 * Separations has two mutations — the UCPath Smart HR submit
 * (`runUcpathTransaction`) and the Kuali finalization save (`runKualiFinalize`).
 * `dryRun:true` stamps `data.status:"Dry Run Complete"` and `skipStep`s both,
 * so NO employee is terminated and NO Kuali document is finalized. The test
 * asserts BOTH steps emitted a `skipped` row — a regression that let either
 * write fire would fail here loudly.
 *
 * ── SCOPE: 3 systems, hands-off Duo ──
 * Launches all three separations systems (`kuali`, `new-kronos`, `ucpath`)
 * pulled straight from `separationsWorkflow.config.systems`, so the auth shape
 * matches production (parallel-staggered Duo). Duo is approved hands-off via the
 * enrolled WebAuthn credential (`HR_AUTOMATION_DUO_WEBAUTHN=1`, set in
 * `_setup.ts`). Skips cleanly when preconditions are absent.
 *
 * ── NOTE on the identity-check delegation ──
 * The separations handler runs `identity-check` (delegates to person-lookup)
 * ONLY when the Kuali employee name disagrees with the UCPath Job Summary name
 * for the EID. For a correctly-filed separation they match and the step is
 * skipped — the common case. If a chosen doc DOES mismatch, the delegation
 * surfaces in the run; pick a different `HR_DRYRUN_DOC_ID` (any currently-
 * pending doc — enumerate them read-only via `separations-collect.test.ts`).
 *
 * ── TWO-PHASE TIMING (mirrors separations-collect) ──
 * PHASE 1 — AUTH: an internal abort (`INTERNAL_ABORT_MS`) armed BEFORE
 * `Session.launch` unwinds a stalled Duo ceremony cleanly (persists signCount),
 * then is CLEARED the moment all three `session.page(id)` resolve so it can
 * never fire mid-dry-run. PHASE 2 — the read path + write-gate runs under the
 * per-`it` timeout. Teardown is graceful `session.close()` only — never
 * force-kill (signCount desync).
 */
const credsPresent = Boolean(process.env.UCPATH_USER_ID && process.env.UCPATH_PASSWORD);
const credentialFilePresent = existsSync(".auth/duo-webauthn.json");
const ready = credsPresent && credentialFilePresent;
const headless = process.env.HR_TEST_HEADED !== "1";

// The pending doc to dry-run. Override with HR_DRYRUN_DOC_ID. The default is a
// doc that was pending when this test was written; if it has since been acted
// on, pass a current one (enumerate via separations-collect).
const DOC_ID = process.env.HR_DRYRUN_DOC_ID ?? "4361";

if (!ready) {
  console.log(
    `[live/separations-dryrun] SKIPPED — ${!credsPresent ? "UCPATH_USER_ID/PASSWORD missing in .env" : ".auth/duo-webauthn.json missing (run npm run duo:webauthn:enroll)"}`,
  );
}

// All three separations systems, faithful to what ships.
const systems: SystemConfig[] = separationsWorkflow.config.systems;

// PHASE-1 auth abort deadline. 3 systems auth via parallel-staggered Duo
// (settle 2s + 5s stagger + per-system ceremony), so allow generous headroom
// ABOVE the worst-case 3-Duo auth but UNDER the per-`it` timeout.
const INTERNAL_ABORT_MS = 240_000;

// Mirror `Session.launch`'s `defaultLaunchOne` but honor `headless` so the test
// runs unattended (the built-in always launches headed).
const launchFn = async ({ system }: { system: SystemConfig }) => {
  const { browser, context, page } = await launchBrowser({
    headless,
    sessionDir: system.sessionDir,
    acceptDownloads: system.acceptDownloads,
  });
  return { page, context, browser };
};

interface TrackerRowLite {
  runId?: string;
  status?: string;
  step?: string;
  data?: Record<string, unknown>;
}

/** Read every `rows/separations-*.jsonl` row for one runId from a temp tracker. */
function readRunRows(trackerDir: string, workflow: string, runId: string): TrackerRowLite[] {
  const dir = rowsDir(trackerDir);
  if (!existsSync(dir)) return [];
  const out: TrackerRowLite[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(`${workflow}-`) || !file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as TrackerRowLite;
        if (row.runId === runId) out.push(row);
      } catch {
        /* skip a malformed line */
      }
    }
  }
  return out;
}

describe.skipIf(!ready)(
  `live separations DRY-RUN terminal — runOneItem({ dryRun:true }) for a pending doc (${headless ? "headless" : "headed"})`,
  () => {
    it(
      "runs the full read path against a real pending doc and halts at 'Dry Run Complete' with NO writes",
      async () => {
        assert.equal(
          systems.length,
          3,
          `expected the 3 separations systems, resolved ${systems.length} (${systems.map((s) => s.id).join(", ")})`,
        );

        // PHASE-1 AUTH-SAFETY ABORT — armed BEFORE Session.launch (a stalled Duo
        // unwinds cleanly), cleared the instant all three systems are ready so
        // it can't fire mid-dry-run, and again in `finally` (idempotent).
        const abortController = new AbortController();
        let authAbortCleared = false;
        const abortTimer = setTimeout(() => {
          abortController.abort(
            new Error(
              `Separations AUTH did not complete within ${INTERNAL_ABORT_MS}ms — aborting to exit the Duo ceremony cleanly before the pool hard-kill`,
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

        const trackerDir = mkdtempSync(join(tmpdir(), "hr-separations-dryrun-"));
        const runId = randomUUID();

        try {
          // Await every system's readiness (each rejects if its auth failed). The
          // separations handler fetches pages lazily, but waiting here lets the
          // Phase-1 abort cover the WHOLE 3-Duo ceremony, then we clear it.
          await session.page("kuali");
          await session.page("new-kronos");
          await session.page("ucpath");
          clearAuthAbort();

          log.step(
            `[live/separations-dryrun] DRY-RUN doc #${DOC_ID} — runId ${runId.slice(0, 8)} — tracker ${trackerDir}`,
          );

          const result = await runOneItem({
            wf: separationsWorkflow,
            session,
            item: { docId: DOC_ID, dryRun: true },
            itemId: DOC_ID,
            runId,
            trackerDir,
            callerPreEmits: false,
          });

          // Diagnostic: dump every row's status/step so a failure shows the full
          // lifecycle (and so the first live run reveals the exact skip shape).
          const rows = readRunRows(trackerDir, "separations", runId);
          log.step(
            `[live/separations-dryrun] emitted rows: ${rows
              .map((r) => `${r.status}${r.step ? `:${r.step}` : ""}`)
              .join(" → ")}`,
          );

          assert.equal(
            result.ok,
            true,
            `runOneItem must succeed (dry-run never writes) — got ${result.ok === false ? result.error : "ok"}`,
          );

          // Terminal row: lifecycle status "done", operator-facing data.status
          // "Dry Run Complete", data.dryRun true.
          const done = rows.filter((r) => r.status === "done").at(-1);
          assert.ok(done, "a terminal 'done' row was emitted for the dry-run");
          assert.equal(
            done?.data?.status,
            "Dry Run Complete",
            "the dry run halted at the 'Dry Run Complete' terminal",
          );
          // Tracker data values are serialized to strings on the emitted row
          // (the `stringifiedSeed` path), so the boolean dryRun rides as "true".
          // The unit test reads raw `ctx.data` (boolean); here we read the row.
          assert.equal(
            String(done?.data?.dryRun),
            "true",
            `the terminal row is marked dryRun (got ${JSON.stringify(done?.data?.dryRun)})`,
          );

          // BOTH irreversible writes must have been SKIPPED — the safety proof.
          const skippedSteps = new Set(
            rows.filter((r) => r.status === "skipped" && r.step).map((r) => r.step as string),
          );
          assert.ok(
            skippedSteps.has("ucpath-transaction"),
            `ucpath-transaction (the UCPath Smart HR submit) must be skipped in dry-run — skipped: [${[...skippedSteps].join(", ")}]`,
          );
          assert.ok(
            skippedSteps.has("kuali-finalization"),
            `kuali-finalization (the Kuali finalization save) must be skipped in dry-run — skipped: [${[...skippedSteps].join(", ")}]`,
          );

          log.success(
            `[live/separations-dryrun] doc #${DOC_ID} reached 'Dry Run Complete' — UCPath submit + Kuali finalization both skipped, no employee terminated, no document finalized`,
          );
        } finally {
          clearAuthAbort();
          // Graceful teardown — never force-kill (signCount desync). On the
          // abort path the kernel finalized WebAuthn cleanly already.
          await session.close();
        }
      },
      // Per-`it` timeout: Phase-1 auth abort (≤240s) + the read-path dry-run
      // (Kuali extract + Job Summary + Kronos + reconciliation, ~30-120s) +
      // teardown all fit under this last-resort backstop.
      600_000,
    );
  },
);
