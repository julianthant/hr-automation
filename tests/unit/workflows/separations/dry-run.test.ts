import { describe, it, beforeAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * Regression pins for the separations DRY-RUN guard (added 2026-06-17).
 *
 * Separations has TWO irreversible writes — the UCPath Smart HR submit
 * (`runUcpathTransaction` → `clickSaveAndSubmit`) and the Kuali finalization
 * save (`runKualiFinalize`). The `dryRun` flag halts the handler after the
 * READ path (extraction + Kronos search + Job Summary fetch + date
 * reconciliation) and BEFORE either write, so the workflow can be e2e-tested
 * live (3 real Duos) without terminating a real employee or finalizing a
 * Kuali document.
 *
 * Three layers are pinned:
 *   1. Schema  — `dryRun` MUST survive `schema.parse`. Zod strips unknown keys,
 *      so an undeclared `dryRun` would be silently dropped → a REAL termination.
 *      This is the catastrophic-regression guard.
 *   2. Handler — with `dryRun`, neither mutating step function is called, the
 *      three remaining steps are skipped, and `data` is stamped
 *      `status:"Dry Run Complete"` + `dryRun:true`; without it, both writes ARE
 *      called (proves the flag GATES the writes, not something else).
 *   3. Registry — the dashboard `supportsDryRun` toggle is enabled for
 *      separations (and only for workflows that actually have a guard).
 *
 * The handler is driven DIRECTLY with a hand-rolled ctx (no kernel / no auth /
 * no browser / no JSONL — the real `.tracker/separations-*.jsonl` is never
 * touched). The five step functions are mocked at the module boundary; the two
 * mutating ones are spies. The kernel's own wiring (auth gating, batch,
 * tracker emission) is already covered by `workflow.test.ts` — here we exercise
 * only the guard logic that lives in the real handler closure.
 */

// Hoisted above the ESM imports below: the step-function spies (referenced by
// the vi.mock factories) and the TIMEKEEPER_NAME env getTimekeeperName() reads.
const mocks = vi.hoisted(() => {
  process.env.TIMEKEEPER_NAME = "Test Timekeeper";
  return {
    runKualiExtract: vi.fn(),
    runKronosSearch: vi.fn(),
    runNewKronosTimecard: vi.fn(),
    runTransactionCheck: vi.fn(),
    runUcpathJobSummary: vi.fn(),
    runUcpathTransaction: vi.fn(),
    runKualiFinalize: vi.fn(),
    // Job Summary re-fetch the handler runs after an identity-check EID
    // correction (real fn navigates UCPath — stub it).
    getJobSummaryIdentity: vi.fn(),
    // Kuali name write the identity-check "similar" branch makes (real fn drives
    // a live Kuali form — stub it).
    updateEmployeeName: vi.fn(),
    // Separation Date write-back (real fn drives a live Kuali form — stub it).
    // Live runs now write the derived Separation Date back when it differs.
    updateSeparationDate: vi.fn(),
  };
});

// This repo's vitest runs single-fork with a SHARED module cache, so a static
// top-level `import` of the workflow would bind the REAL step functions before
// the mocks apply (same gotcha documented in tests/unit/workflows/ocr/
// workflow.test.ts). `vi.resetModules()` + a dynamic `import()` in the loader
// below makes the mock intercepts land before `workflow.ts` captures its
// step-function bindings.
vi.resetModules();

vi.mock("../../../../src/workflows/separations/steps/kuali-extract.js", () => ({
  runKualiExtract: mocks.runKualiExtract,
}));
vi.mock("../../../../src/workflows/separations/steps/kronos-search.js", () => ({
  runKronosSearch: mocks.runKronosSearch,
  // The handler also imports runNewKronosTimecard for the identity-check
  // re-fetch — without this the mocked module would export it as undefined.
  runNewKronosTimecard: mocks.runNewKronosTimecard,
}));
vi.mock("../../../../src/workflows/separations/steps/transaction-check.js", () => ({
  runTransactionCheck: mocks.runTransactionCheck,
}));
vi.mock("../../../../src/workflows/separations/steps/ucpath-job-summary.js", () => ({
  runUcpathJobSummary: mocks.runUcpathJobSummary,
}));
vi.mock("../../../../src/workflows/separations/steps/ucpath-transaction.js", () => ({
  runUcpathTransaction: mocks.runUcpathTransaction,
}));
vi.mock("../../../../src/workflows/separations/steps/kuali-finalize.js", () => ({
  runKualiFinalize: mocks.runKualiFinalize,
}));
// Preserve every real new-kronos export (NEW_KRONOS_URL is read by the
// workflow's systems config) and only no-op the best-effort timecard scroll
// the handler calls on the fake page.
vi.mock("../../../../src/systems/new-kronos/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/new-kronos/index.js")>()),
  scrollNewKronosTimecardToDate: vi.fn(async () => {}),
}));
// Stub only the Job Summary re-fetch the handler runs after an EID correction;
// keep every other ucpath export real (the workflow's systems config + types).
vi.mock("../../../../src/systems/ucpath/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/ucpath/index.js")>()),
  getJobSummaryIdentity: mocks.getJobSummaryIdentity,
}));
// Stub only the Kuali name write the identity-check "similar" branch makes on a
// live run; keep every other kuali export real (isVoluntaryTermination, the
// systems config wiring, etc.).
vi.mock("../../../../src/systems/kuali/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/kuali/index.js")>()),
  updateEmployeeName: mocks.updateEmployeeName,
  updateSeparationDate: mocks.updateSeparationDate,
}));

import { INPUT_RUN_REGISTRY } from "../../../../src/dashboard/lib/input-run-registry.js";

// Dynamically loaded AFTER the mocks register (see vi.resetModules above).
let schema: { parse: (v: unknown) => unknown };
let runHandler: (ctx: unknown, input: { docId: string; dryRun?: boolean }) => Promise<void>;

beforeAll(async () => {
  const { separationsWorkflow } = await import(
    "../../../../src/workflows/separations/workflow.js"
  );
  schema = separationsWorkflow.config.schema;
  runHandler = separationsWorkflow.config.handler as unknown as typeof runHandler;
});

// A KualiSeparationData fixture with PAST dates (today is well after Jan 2026)
// so the handler's `validateLastDayWorked` future-date preflight passes, and a
// VOLUNTARY type so reason-code mapping resolves cleanly. `eid` is a VALID
// 8-digit UCPath EID and `employeeName` MATCHES the default fixture's Job
// Summary name below, so the conditional identity-check is SKIPPED (no
// person-lookup) — keeping these tests focused on the dry-run / write-gating
// logic. (The identity-check delegate/correct/fail-loud behavior is covered by
// resolve-eid.test.ts; its handler wiring by the identity-check describe below.)
const KUALI_FIXTURE = {
  employeeName: "Test Employee",
  eid: "10772489",
  lastDayWorked: "01/15/2026",
  separationDate: "01/16/2026",
  terminationType: "Resign",
  location: "",
};

// Default New Kronos phase-1 result. New Kronos not-found
// (`lastPunchDate: null`) makes the handler fall back to the Kuali LDW. The
// Job Summary is no longer part of this result — it's fetched via
// `getJobSummaryIdentity` (mocked separately in beforeEach), now a 2-way
// parallel block (New Kronos + Kuali timekeeper). (Old Kronos is gone.)
const KRONOS_NOT_FOUND = {
  newK: {
    status: "fulfilled" as const,
    value: { found: false, lastPunchDate: null, sickDates: [], holidayDates: [] },
  },
  kualiTimekeeper: { status: "fulfilled" as const, value: undefined },
};

// Job Summary identity fixtures (the primary fetch now lives in
// getJobSummaryIdentity, before identity-check). The default (beforeEach) is a
// FOUND record whose name matches KUALI_FIXTURE so identity-check skips.
const JS_NAME_MISMATCH = { found: true, name: "Totally Different Person", data: null };
const JS_SIMILAR = { found: true, name: "Jayden Balmaceda", data: null };

const fakePage = { bringToFront: async () => {}, isClosed: () => false } as unknown;

/** Records every value stamped via ctx.updateData + every skipped step. */
interface CtxProbe {
  data: Record<string, unknown>;
  skipped: string[];
}

/**
 * Result the stub `ctx.delegateTo` (person-lookup) returns from the
 * `identity-check` step. Defaults to a `done` run resolving the SAME EID as
 * KUALI_FIXTURE so the verification is a clean match (no correction, no
 * throw) and these tests stay focused on the dry-run / write-gating logic.
 */
type DelegateResult = {
  status: "done" | "failed" | "cancelled" | "pending";
  data?: Record<string, string>;
};

/** A minimal ctx satisfying exactly what the separations handler touches. */
function makeFakeCtx(
  input: Record<string, unknown>,
  opts: { delegateResult?: DelegateResult } = {},
): { ctx: unknown; probe: CtxProbe } {
  const data: Record<string, unknown> = { ...input };
  const skipped: string[] = [];
  const delegateResult = opts.delegateResult ?? {
    status: "done" as const,
    data: { emplId: KUALI_FIXTURE.eid },
  };
  const ctx = {
    data,
    runId: "test-run",
    parentRunId: undefined,
    signal: undefined,
    isBatch: false,
    // identity-check step delegates to person-lookup BY NAME to verify the EID.
    delegateTo: async () => ({ workflow: "person-lookup", runId: "stub", itemId: "stub", ...delegateResult }),
    updateData: (patch: Record<string, unknown>) => {
      Object.assign(data, patch);
    },
    step: async <R>(_name: string, fn: () => Promise<R>) => fn(),
    markStep: () => {},
    skipStep: (name: string) => {
      skipped.push(name);
    },
    shouldSkipStep: () => false,
    parallel: async (tasks: Record<string, () => Promise<unknown>>) => {
      // Not reached (kronos-search is mocked), but mirror allSettled shape.
      const out: Record<string, PromiseSettledResult<unknown>> = {};
      for (const [k, f] of Object.entries(tasks)) {
        try {
          out[k] = { status: "fulfilled", value: await f() };
        } catch (reason) {
          out[k] = { status: "rejected", reason };
        }
      }
      return out;
    },
    page: async () => fakePage,
    session: { page: async () => fakePage },
    screenshot: async () => {},
    reportPhase: () => {},
  };
  return { ctx, probe: { data, skipped } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runKualiExtract.mockResolvedValue(KUALI_FIXTURE);
  mocks.runKronosSearch.mockResolvedValue(KRONOS_NOT_FOUND);
  // transaction-check: default to "no existing termination" (create normally).
  mocks.runTransactionCheck.mockResolvedValue({ status: "none" });
  mocks.runUcpathJobSummary.mockResolvedValue(undefined);
  mocks.runUcpathTransaction.mockResolvedValue({
    transactionNumber: "T999",
    submittedWithoutTxnNumber: false,
  });
  mocks.runKualiFinalize.mockResolvedValue(undefined);
  mocks.runNewKronosTimecard.mockResolvedValue({
    found: false, lastPunchDate: null, sickDates: [], holidayDates: [],
  });
  // getJobSummaryIdentity is now the PRIMARY Job Summary fetch (inline, before
  // identity-check) AND the EID-correction re-fetch. Default: a FOUND record
  // whose name MATCHES KUALI_FIXTURE so identity-check skips on a clean match.
  // Tests that need a mismatch/similar override the FIRST call with
  // mockResolvedValueOnce; the catch-all default then serves the re-fetch.
  mocks.getJobSummaryIdentity.mockResolvedValue({
    found: true,
    name: "Test Employee",
    data: { deptId: "", departmentDescription: "", jobCode: "", jobDescription: "" },
  });
  mocks.updateEmployeeName.mockResolvedValue(undefined);
  mocks.updateSeparationDate.mockResolvedValue(undefined);
});

describe("SeparationInputSchema (separationsWorkflow.config.schema)", () => {
  it("preserves dryRun:true through parse (NOT stripped)", () => {
    const parsed = schema.parse({ docId: "4131", dryRun: true }) as {
      docId: string;
      dryRun?: boolean;
    };
    assert.equal(parsed.dryRun, true);
  });

  it("preserves dryRun:false through parse", () => {
    const parsed = schema.parse({ docId: "4131", dryRun: false }) as {
      docId: string;
      dryRun?: boolean;
    };
    assert.equal(parsed.dryRun, false);
  });

  it("leaves dryRun undefined when omitted", () => {
    const parsed = schema.parse({ docId: "4131" }) as {
      docId: string;
      dryRun?: boolean;
    };
    assert.equal(parsed.dryRun, undefined);
  });

  it("rejects a non-boolean dryRun", () => {
    assert.throws(() => schema.parse({ docId: "4131", dryRun: "yes" }));
  });

  it("still requires a non-empty docId", () => {
    assert.throws(() => schema.parse({ docId: "", dryRun: true }));
  });

  it("strips an unknown key — the exact reason dryRun MUST be declared", () => {
    const parsed = schema.parse({ docId: "4131", notAField: true }) as Record<
      string,
      unknown
    >;
    assert.equal("notAField" in parsed, false);
  });
});

describe("separations handler — dry-run terminal", () => {
  it("does NOT call runUcpathTransaction (the UCPath Smart HR submit) in dry-run", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 0);
  });

  it("does NOT call runKualiFinalize (the Kuali finalization save) in dry-run", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(mocks.runKualiFinalize.mock.calls.length, 0);
  });

  it("stamps data.status = 'Dry Run Complete' in dry-run", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.status, "Dry Run Complete");
  });

  it("stamps data.dryRun = true in dry-run", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.dryRun, true);
  });

  it("stamps transactionNumber + comments in dry-run (no 'declared but never populated' warn)", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    // Both are declared detailFields. `transactionNumber` is never set on the
    // dry-run path (no UCPath submit runs) and `comments` is only set on the
    // edit-and-resume prefill path, so a fresh dry run leaves both absent and
    // trips the runtime "declared but never populated" populate-warn. The
    // dry-run snapshot must stamp both (mirrors departmentDescription).
    assert.ok("transactionNumber" in probe.data, "transactionNumber stamped in dry-run");
    assert.equal(probe.data.transactionNumber, "");
    assert.ok("comments" in probe.data, "comments stamped in dry-run");
  });

  it("skips the ucpath-transaction step in dry-run", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.ok(probe.skipped.includes("ucpath-transaction"));
  });

  it("skips the kuali-finalization step in dry-run", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.ok(probe.skipped.includes("kuali-finalization"));
  });

  it("still runs the read path (kuali-extraction) in dry-run", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(mocks.runKualiExtract.mock.calls.length, 1);
  });

  it("derives separationDate = last day worked when there's no leave (NOT Kuali's value)", async () => {
    // Default fixture: Kuali LDW 01/15, Kuali sep 01/16, no Kronos punch/leave.
    // New model: separation date falls back (via lastDayWorked) to the Kuali LDW
    // 01/15 — the last day worked — NOT Kuali's separation date 01/16.
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.separationDate, "01/15/2026");
    assert.notEqual(probe.data.separationDate, KUALI_FIXTURE.separationDate);
  });

  it("stamps terminationEffDate = reconciled separationDate + 1 day", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    // Reconciled separation date 01/15/2026 (= last day worked) → 01/16/2026.
    assert.equal(probe.data.terminationEffDate, "01/16/2026");
  });

  it("extends separationDate to the latest sick/holiday date when leave is present", async () => {
    // New Kronos: last punch 01/20, holiday pay 01/26 → separation date 01/26.
    // (Job Summary name matches via the getJobSummaryIdentity default → identity
    // -check skips, keeping the focus on dates.)
    mocks.runKronosSearch.mockResolvedValueOnce({
      newK: {
        status: "fulfilled" as const,
        value: { found: true, lastPunchDate: "01/20/2026", sickDates: [], holidayDates: ["01/26/2026"] },
      },
      kualiTimekeeper: { status: "fulfilled" as const, value: undefined },
    });
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.lastDayWorked, "01/20/2026");
    assert.equal(probe.data.separationDate, "01/26/2026");
    // Term eff = separation date + 1.
    assert.equal(probe.data.terminationEffDate, "01/27/2026");
  });

  it("no longer stamps foundInOldKronos (Old Kronos removed from separations)", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal("foundInOldKronos" in probe.data, false);
  });

  it("New Kronos last physical punch overrides the Kuali Last Day Worked", async () => {
    // New Kronos found a later last punch (01/20) than the Kuali LDW (01/15).
    // (Job Summary name matches via the getJobSummaryIdentity default → identity
    // -check skipped, focus stays on dates.)
    mocks.runKronosSearch.mockResolvedValueOnce({
      newK: {
        status: "fulfilled" as const,
        value: { found: true, lastPunchDate: "01/20/2026", sickDates: [], holidayDates: [] },
      },
      kualiTimekeeper: { status: "fulfilled" as const, value: undefined },
    });
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.lastDayWorked, "01/20/2026");
    // No leave → separation date = the last day worked (the overriding punch),
    // not Kuali's separation date.
    assert.equal(probe.data.separationDate, "01/20/2026");
  });

  it("falls back to the Kuali Last Day Worked when New Kronos has no punch", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.lastDayWorked, KUALI_FIXTURE.lastDayWorked);
  });
});

describe("separationsWorkflow.config.systems (Old Kronos removed)", () => {
  it("declares exactly 3 systems: kuali, new-kronos, ucpath", async () => {
    const { separationsWorkflow } = await import(
      "../../../../src/workflows/separations/workflow.js"
    );
    const ids = separationsWorkflow.config.systems.map((s: { id: string }) => s.id);
    assert.deepEqual(ids, ["kuali", "new-kronos", "ucpath"]);
    assert.equal(ids.includes("old-kronos"), false);
  });
});

describe("separations handler — live (non-dry-run) gates the writes", () => {
  it("DOES call runUcpathTransaction when dryRun is absent", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1);
  });

  it("DOES call runKualiFinalize when dryRun is absent", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runKualiFinalize.mock.calls.length, 1);
  });

  it("does NOT stamp Dry Run Complete when dryRun is absent", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.notEqual(probe.data.status, "Dry Run Complete");
  });

  it("stamps the comments detailField on a live run (no populate warn)", async () => {
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    // `comments` is a declared detailField only ever populated on the
    // edit-and-resume prefill path. The live final snapshot must stamp it so a
    // fresh run doesn't trip the "declared but never populated" warn (the
    // dry-run path stamps it too — see the dry-run terminal describe above).
    assert.ok("comments" in probe.data, "comments stamped on live run");
  });
});

describe("separations handler — live Separation Date write-back to Kuali", () => {
  it("writes the derived Separation Date back to Kuali when it differs from Kuali's", async () => {
    // Default fixture: Kuali sep 01/16, no Kronos punch/leave → derived sep 01/15
    // (the Kuali LDW) → CHANGED → write-back.
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.updateSeparationDate.mock.calls.length, 1, "Separation Date written back once");
    assert.equal(mocks.updateSeparationDate.mock.calls[0][1], "01/15/2026", "wrote the derived date");
  });

  it("does NOT write the Separation Date back when the derived value matches Kuali's", async () => {
    // No punch (LDW stays Kuali's 01/15, so no LDW write either) + holiday pay on
    // 01/16 → derived sep = max(01/15, 01/16) = 01/16 == Kuali sep 01/16 → no write.
    mocks.runKronosSearch.mockResolvedValueOnce({
      newK: {
        status: "fulfilled" as const,
        value: { found: true, lastPunchDate: null, sickDates: [], holidayDates: ["01/16/2026"] },
      },
      kualiTimekeeper: { status: "fulfilled" as const, value: undefined },
    });
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.updateSeparationDate.mock.calls.length, 0, "no write-back when unchanged");
  });

  it("does NOT write the Separation Date back in dry-run (no Kuali writes at all)", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(mocks.updateSeparationDate.mock.calls.length, 0, "dry-run writes nothing");
  });
});

describe("separations handler — empty transaction number fails the run", () => {
  // Regression for the silent-Done bug: a live run whose UCPath Smart HR submit
  // soft-failed (create/submit rejected, or threw and was caught) returns an
  // empty transactionNumber with submittedWithoutTxnNumber:false. It used to
  // run kuali-finalization (blank-for-manual-entry prep) and then report "Done"
  // — hiding that the transaction was never created. It must now FAIL loud.
  const EMPTY_TXN = { transactionNumber: "", submittedWithoutTxnNumber: false };

  it("throws when the UCPath submit yields no transaction number", async () => {
    mocks.runUcpathTransaction.mockResolvedValueOnce(EMPTY_TXN);
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await assert.rejects(
      () => runHandler(ctx, { docId: "4131" }),
      /No UCPath transaction number for doc #4131/,
    );
  });

  it("still runs kuali-finalization (blank-for-manual-entry prep) before failing", async () => {
    mocks.runUcpathTransaction.mockResolvedValueOnce(EMPTY_TXN);
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await assert.rejects(() => runHandler(ctx, { docId: "4131" }));
    assert.equal(mocks.runKualiFinalize.mock.calls.length, 1);
  });

  it("stamps the reconciled snapshot before throwing (failed row keeps detail data)", async () => {
    mocks.runUcpathTransaction.mockResolvedValueOnce(EMPTY_TXN);
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await assert.rejects(() => runHandler(ctx, { docId: "4131" }));
    // Reconciled separation date (= last day worked, no leave), not Kuali's.
    assert.equal(probe.data.separationDate, "01/15/2026");
    assert.equal(probe.data.transactionNumber, "");
  });

  it("does NOT throw when a transaction number IS present (happy path)", async () => {
    // Default mock returns T999 — runHandler should resolve normally.
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
  });
});

describe("separations handler — identity-check (conditional, Job-Summary-gated)", () => {
  // The Job Summary name now comes from the inline getJobSummaryIdentity fetch
  // (before identity-check), NOT from kronos-search. A test forces a name that
  // does NOT match the Kuali fixture ("Test Employee") via mockResolvedValueOnce
  // so the handler RUNS identity-check and delegates to person-lookup.

  it("SKIPS identity-check (no person-lookup) when the Job Summary name matches", async () => {
    // Default getJobSummaryIdentity: found + name "Test Employee" matches Kuali.
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.ok(probe.skipped.includes("identity-check"), "identity-check skipped on a clean name match");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1, "proceeds to submit with the trusted EID");
  });

  it("fails the run when person-lookup cannot verify a mismatched EID (never reaches the UCPath submit)", async () => {
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_NAME_MISMATCH);
    const { ctx } = makeFakeCtx({ docId: "4131" }, { delegateResult: { status: "failed" } });
    await assert.rejects(
      () => runHandler(ctx, { docId: "4131" }),
      /Could not verify the EID/,
    );
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 0, "no submit when the EID is unverified");
  });

  it("corrects the EID from the name on a Job Summary name mismatch, re-fetches, then submits", async () => {
    // Primary fetch returns a mismatched name; the catch-all default serves the
    // re-fetch for the corrected EID.
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_NAME_MISMATCH);
    const { ctx, probe } = makeFakeCtx(
      { docId: "4131" },
      { delegateResult: { status: "done", data: { emplId: "10999999" } } },
    );
    await runHandler(ctx, { docId: "4131" });
    assert.equal(probe.data.eid, "10999999", "name-derived EID persisted to ctx.data");
    // getJobSummaryIdentity is called TWICE now: the primary identity-gate fetch
    // (Kuali EID) + the re-fetch after the EID correction.
    assert.equal(
      mocks.getJobSummaryIdentity.mock.calls.length, 2,
      "primary Job Summary fetch + re-fetch for the verified EID",
    );
    assert.equal(mocks.getJobSummaryIdentity.mock.calls[0][1], KUALI_FIXTURE.eid, "primary fetch used the Kuali EID");
    assert.equal(mocks.getJobSummaryIdentity.mock.calls[1][1], "10999999", "re-fetched with the corrected EID");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1, "still submits, with the corrected EID");
  });

  it("skips identity-check on the txn-prefilled resume path (UCPath already accepted the EID)", async () => {
    const { ctx, probe } = makeFakeCtx({
      docId: "4131",
      name: "Test Employee",
      eid: "10772489",
      rawTerminationType: "Resign",
      separationDate: "01/16/2026",
      lastDayWorked: "01/15/2026",
      transactionNumber: "T123",
    });
    await runHandler(ctx, { docId: "4131" });
    assert.ok(probe.skipped.includes("identity-check"), "identity-check skipped");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 0, "txn prefilled — no re-submit");
  });
});

describe("separations handler — identity-check (similar name → correct in place)", () => {
  // Kuali name is a close spelling variant of the Job Summary name — the EID is
  // trusted and the Kuali name is corrected in place (no person-lookup, no EID
  // change, no re-fetch). The Jaden/Jayden regression. The Job Summary name
  // comes from the inline getJobSummaryIdentity fetch (JS_SIMILAR).
  const KUALI_MISSPELLED = { ...KUALI_FIXTURE, employeeName: "Balmaceda, Jaden" };

  it("LIVE: corrects the Kuali name, keeps the EID, never delegates, and submits", async () => {
    mocks.runKualiExtract.mockResolvedValueOnce(KUALI_MISSPELLED);
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_SIMILAR);
    const delegateSpy = vi.fn();
    const { ctx, probe } = makeFakeCtx({ docId: "4126" });
    (ctx as { delegateTo: unknown }).delegateTo = async (...args: unknown[]) => {
      delegateSpy(...args);
      return { workflow: "person-lookup", runId: "stub", itemId: "stub", status: "done" as const };
    };

    await runHandler(ctx, { docId: "4126" });

    assert.equal(probe.skipped.includes("identity-check"), false, "identity-check RAN (not skipped)");
    assert.equal(delegateSpy.mock.calls.length, 0, "no person-lookup delegation on a close variant");
    assert.equal(mocks.updateEmployeeName.mock.calls.length, 1, "Kuali name written once");
    assert.equal(mocks.updateEmployeeName.mock.calls[0][1], "Balmaceda, Jayden", "corrected spelling, Kuali format preserved");
    assert.equal(probe.data.name, "Balmaceda, Jayden", "corrected name persisted to ctx.data");
    assert.equal(probe.data.eid, undefined, "EID never changed via ctx.data (trusted as-is)");
    // Only the primary identity-gate fetch — no re-fetch, since the EID is unchanged.
    assert.equal(mocks.getJobSummaryIdentity.mock.calls.length, 1, "primary fetch only; no re-fetch (EID unchanged)");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1, "proceeds to submit with the trusted EID");
  });

  it("DRY-RUN: still corrects the name on the unsubmitted Kuali draft (like the timekeeper fill)", async () => {
    mocks.runKualiExtract.mockResolvedValueOnce(KUALI_MISSPELLED);
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_SIMILAR);
    const { ctx, probe } = makeFakeCtx({ docId: "4126", dryRun: true });

    await runHandler(ctx, { docId: "4126", dryRun: true });

    assert.equal(mocks.updateEmployeeName.mock.calls.length, 1, "name written to the unsubmitted draft");
    assert.equal(mocks.updateEmployeeName.mock.calls[0][1], "Balmaceda, Jayden");
    assert.equal(probe.data.name, "Balmaceda, Jayden", "corrected name recorded in ctx.data");
    // The doc is still never finalized — the dry-run terminal skips kuali-finalization.
    assert.ok(probe.skipped.includes("kuali-finalization"));
    assert.equal(probe.data.status, "Dry Run Complete");
  });
});

describe("separations handler — transaction-check (existing-termination branch)", () => {
  it("runs transaction-check with the verified EID (after identity-check)", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runTransactionCheck.mock.calls.length, 1, "transaction-check ran once");
    assert.equal(
      mocks.runTransactionCheck.mock.calls[0][1], KUALI_FIXTURE.eid,
      "searched SS Smart HR with the (verified) Kuali EID",
    );
  });

  it("passes dryRun through to transaction-check (the delete is guarded there)", async () => {
    const { ctx } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.deepEqual(mocks.runTransactionCheck.mock.calls[0][2], { dryRun: true });
  });

  it("creates a new transaction when there is no existing TER (status none)", async () => {
    // Default mock returns { status: "none" } → normal flow.
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1, "creates the transaction normally");
    assert.equal(probe.skipped.includes("ucpath-transaction"), false, "ucpath-transaction NOT skipped");
  });

  it("proceeds to create a fresh transaction after a pending one is deleted", async () => {
    mocks.runTransactionCheck.mockResolvedValueOnce({ status: "pending-deleted", transactionId: "T002168945" });
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1, "creates a fresh transaction after the delete");
  });

  it("reuses an APPROVED duplicate: skips ucpath-transaction, files the duplicate-termination comment", async () => {
    mocks.runTransactionCheck.mockResolvedValueOnce({ status: "approved", transactionNumber: "T002168945" });
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.ok(probe.skipped.includes("ucpath-transaction"), "ucpath-transaction skipped on an approved dup");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 0, "no UCPath create on an approved dup");
    assert.equal(probe.data.transactionNumber, "T002168945", "reused the approved transaction number");
    const comments = probe.data.comments as string;
    assert.ok(comments.includes("Duplicate termination"), "duplicate-termination comment queued");
    assert.ok(comments.includes("Re Kuali Form #4131"), "comment names the Kuali form");
    assert.ok(comments.includes("EE termination approved on UCPath"), "comment notes UCPath approval");
    // Reusing the approved txn # means the run does NOT fail on an empty number.
    assert.equal(mocks.runKualiFinalize.mock.calls.length, 1, "still finalizes Kuali with the reused number");
  });

  it("previews the approved duplicate transaction number in dry-run (no writes)", async () => {
    mocks.runTransactionCheck.mockResolvedValueOnce({ status: "approved", transactionNumber: "T002168945" });
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(probe.data.status, "Dry Run Complete");
    assert.equal(probe.data.transactionNumber, "T002168945", "dry-run preview shows the reused txn #");
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 0);
    assert.equal(mocks.runKualiFinalize.mock.calls.length, 0, "dry-run finalizes nothing");
  });

  it("skips transaction-check on the txn-prefilled resume path", async () => {
    const { ctx, probe } = makeFakeCtx({
      docId: "4131",
      name: "Test Employee",
      eid: "10772489",
      rawTerminationType: "Resign",
      separationDate: "01/16/2026",
      lastDayWorked: "01/15/2026",
      transactionNumber: "T123",
    });
    await runHandler(ctx, { docId: "4131" });
    assert.ok(probe.skipped.includes("transaction-check"), "transaction-check skipped when txn # prefilled");
    assert.equal(mocks.runTransactionCheck.mock.calls.length, 0, "transaction-check not invoked");
  });
});

describe("separations handler — department gate (skip Kronos for non-HDH)", () => {
  // Only Housing/Dining/Hospitality (HDH) employees are timekept in New Kronos.
  // Once the Workforce Job Summary (getJobSummaryIdentity, inline before
  // identity-check) resolves the department, a NON-HDH department skips
  // kronos-search and the dates fall back to the Kuali form. ucpath-job-summary
  // (the Kuali dept/payroll fill) now runs BEFORE kronos-search so its
  // department can gate the timecard read. The FIRST getJobSummaryIdentity call
  // is overridden per-test (name still "Test Employee" so identity-check skips
  // and the focus stays on the department gate).
  const JS_FOUND = (departmentDescription: string) => ({
    found: true,
    name: "Test Employee",
    data: { deptId: "000123", departmentDescription, jobCode: "001234", jobDescription: "Analyst" },
  });

  it("SKIPS kronos-search for a non-HDH department (not timekept in New Kronos)", async () => {
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_FOUND("Qualcomm Institute"));
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.ok(probe.skipped.includes("kronos-search"), "kronos-search skipped for a non-HDH dept");
    assert.equal(mocks.runKronosSearch.mock.calls.length, 0, "New Kronos timecard search never ran");
    // Dates fall back to the Kuali form (no timecard) — LDW = Kuali LDW.
    assert.equal(probe.data.lastDayWorked, KUALI_FIXTURE.lastDayWorked);
    // The department is STILL filled into Kuali for non-HDH (only the timecard
    // read is skipped) — ucpath-job-summary ran on this live path.
    assert.equal(mocks.runUcpathJobSummary.mock.calls.length, 1, "department still filled for non-HDH");
    // The run still completes (UCPath submit + finalization on the live path).
    assert.equal(mocks.runUcpathTransaction.mock.calls.length, 1);
  });

  it("RUNS kronos-search for an HDH department", async () => {
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_FOUND("Housing/Dining/Hospitality"));
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(probe.skipped.includes("kronos-search"), false, "kronos-search ran for an HDH dept");
    assert.equal(mocks.runKronosSearch.mock.calls.length, 1, "New Kronos timecard search ran");
  });

  it("matches HDH case-insensitively on a department-description keyword (On Campus Housing)", async () => {
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_FOUND("ON CAMPUS HOUSING"));
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runKronosSearch.mock.calls.length, 1, "the 'housing' keyword counts as HDH → kronos runs");
  });

  it("RUNS kronos-search when the department is unknown (fail-safe — empty Job Summary dept)", async () => {
    // Default getJobSummaryIdentity returns an EMPTY department, so we cannot
    // positively classify it as non-HDH → we still run kronos. Skipping an
    // actual HDH employee's timecard on a missing dept read would silently
    // produce wrong dates.
    const { ctx, probe } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(probe.skipped.includes("kronos-search"), false, "kronos-search ran for an unknown dept");
    assert.equal(mocks.runKronosSearch.mock.calls.length, 1);
  });

  it("runs ucpath-job-summary BEFORE kronos-search (the department gates the timecard read)", async () => {
    // HDH so kronos-search also runs — then their invocation order can be compared.
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_FOUND("Housing/Dining/Hospitality"));
    const { ctx } = makeFakeCtx({ docId: "4131" });
    await runHandler(ctx, { docId: "4131" });
    assert.equal(mocks.runUcpathJobSummary.mock.calls.length, 1);
    assert.equal(mocks.runKronosSearch.mock.calls.length, 1);
    assert.ok(
      mocks.runUcpathJobSummary.mock.invocationCallOrder[0] <
        mocks.runKronosSearch.mock.invocationCallOrder[0],
      "the Kuali dept fill ran before the New Kronos timecard read",
    );
  });

  it("does NOT fill the Kuali department in dry-run, even with HDH data (read path still runs kronos)", async () => {
    mocks.getJobSummaryIdentity.mockResolvedValueOnce(JS_FOUND("Housing/Dining/Hospitality"));
    const { ctx, probe } = makeFakeCtx({ docId: "4131", dryRun: true });
    await runHandler(ctx, { docId: "4131", dryRun: true });
    assert.equal(mocks.runUcpathJobSummary.mock.calls.length, 0, "no Kuali dept fill on the dry-run path");
    assert.ok(probe.skipped.includes("ucpath-job-summary"), "ucpath-job-summary skipped in dry-run");
    // The department gate read the dept regardless, and the HDH timecard read is
    // part of the dry-run READ path.
    assert.equal(mocks.runKronosSearch.mock.calls.length, 1, "HDH timecard read still runs in dry-run");
    assert.equal(probe.data.status, "Dry Run Complete");
  });
});

describe("INPUT_RUN_REGISTRY dry-run exposure", () => {
  it("enables the dry-run toggle for separations", () => {
    assert.equal(INPUT_RUN_REGISTRY.separations.supportsDryRun, true);
  });

  it("keeps the dry-run toggle enabled for onboarding (existing guarded workflow)", () => {
    assert.equal(INPUT_RUN_REGISTRY.onboarding.supportsDryRun, true);
  });

  it("does NOT enable a dry-run toggle for a workflow with no guard (person-lookup)", () => {
    // A toggle on a workflow whose handler has no dry-run guard would mislead
    // operators into thinking a real run is safe. Only guarded workflows opt in.
    assert.notEqual(INPUT_RUN_REGISTRY["person-lookup"].supportsDryRun, true);
  });
});
