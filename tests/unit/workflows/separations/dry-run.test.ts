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
 * live (4 real Duos) without terminating a real employee or finalizing a
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
    runUcpathJobSummary: vi.fn(),
    runUcpathTransaction: vi.fn(),
    runKualiFinalize: vi.fn(),
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
// VOLUNTARY type so reason-code mapping resolves cleanly.
// `eid` is a VALID 8-digit UCPath EID (`^10\d{6}$`) so the short-EID guard
// (`resolveSeparationEid`) is a no-op here — it returns the EID unchanged with
// no person-lookup delegation, keeping these tests focused on the dry-run /
// write-gating logic. (The guard's delegate/fail-loud behavior is covered by
// resolve-eid.test.ts.)
const KUALI_FIXTURE = {
  employeeName: "Test Employee",
  eid: "10772489",
  lastDayWorked: "01/15/2026",
  separationDate: "01/16/2026",
  terminationType: "Resign",
  location: "",
};

// All-not-found Kronos phase-1 result. Keeps `resolveKronosDates` from changing
// dates (so the handler attempts no Kuali date writes) and `jobSummary:
// undefined` so ucpath-job-summary self-skips — leaving the two mutating steps
// as the only writes the test gates on.
const KRONOS_NOT_FOUND = {
  oldK: { status: "fulfilled" as const, value: { found: false, date: null } },
  newK: { status: "fulfilled" as const, value: { found: false, date: null } },
  jobSummary: { status: "fulfilled" as const, value: undefined },
  kualiTimekeeper: { status: "fulfilled" as const, value: undefined },
};

const fakePage = { bringToFront: async () => {}, isClosed: () => false } as unknown;

/** Records every value stamped via ctx.updateData + every skipped step. */
interface CtxProbe {
  data: Record<string, unknown>;
  skipped: string[];
}

/** A minimal ctx satisfying exactly what the separations handler touches. */
function makeFakeCtx(input: Record<string, unknown>): { ctx: unknown; probe: CtxProbe } {
  const data: Record<string, unknown> = { ...input };
  const skipped: string[] = [];
  const ctx = {
    data,
    runId: "test-run",
    parentRunId: undefined,
    signal: undefined,
    isBatch: false,
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
  mocks.runUcpathJobSummary.mockResolvedValue(undefined);
  mocks.runUcpathTransaction.mockResolvedValue({
    transactionNumber: "T999",
    submittedWithoutTxnNumber: false,
  });
  mocks.runKualiFinalize.mockResolvedValue(undefined);
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
