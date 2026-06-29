import { describe, it, beforeAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * Regression pin for the `kuali-finalization-saved` audit screenshot ORDER
 * (added 2026-06-25).
 *
 * The capture MUST fire BEFORE `clickSave`. A successful Kuali Build save
 * navigates the form away to the Home apps directory (the Group Hub — a giant
 * infinite-scroll grid of every form type), so a post-save capture shoots that
 * catalog instead of the finalization form — and the catalog is tall enough to
 * hit `CAPTURE.maxSlices` (30) every single run, flooding the Screenshots tab
 * with ~30 useless tiles of the wrong page. The fix captures the FILLED
 * finalization form while it is still on screen, immediately before the save.
 *
 * This was invisible to every prior check because the dry-run terminal halts
 * BEFORE `kuali-finalization` ever runs, so the only live "verification" never
 * exercised the real post-save page state — a synthetic fixed-modal fixture
 * stood in for it.
 */

const mocks = vi.hoisted(() => {
  process.env.TIMEKEEPER_NAME = "Test Timekeeper";
  // Records the ORDER in which the load-bearing operations run.
  const order: string[] = [];
  return {
    order,
    fillTransactionResults: vi.fn(async () => { order.push("fillTransactionResults"); }),
    fillTimekeeperComments: vi.fn(async () => { order.push("fillTimekeeperComments"); }),
    verifyTxnNumberFilled: vi.fn(async () => { order.push("verifyTxnNumberFilled"); }),
    clickSave: vi.fn(async () => { order.push("clickSave"); }),
    terminationEffDateFill: vi.fn(async () => { order.push("terminationEffDate.fill"); }),
  };
});

vi.resetModules();

vi.mock("../../../../src/systems/kuali/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/kuali/index.js")>()),
  fillTransactionResults: mocks.fillTransactionResults,
  fillTimekeeperComments: mocks.fillTimekeeperComments,
  verifyTxnNumberFilled: mocks.verifyTxnNumberFilled,
  clickSave: mocks.clickSave,
}));

vi.mock("../../../../src/systems/kuali/selectors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/kuali/selectors.js")>()),
  finalTransactions: {
    ...(await importOriginal<typeof import("../../../../src/systems/kuali/selectors.js")>()).finalTransactions,
    terminationEffDate: () => ({ fill: mocks.terminationEffDateFill }),
  },
}));

type RunKualiFinalize = typeof import("../../../../src/workflows/separations/steps/kuali-finalize.js").runKualiFinalize;
let runKualiFinalize: RunKualiFinalize;

beforeAll(async () => {
  ({ runKualiFinalize } = await import("../../../../src/workflows/separations/steps/kuali-finalize.js"));
});

beforeEach(() => {
  mocks.order.length = 0;
  vi.clearAllMocks();
});

/** Hand-rolled ctx: only `screenshot` + `data` are touched by the step. */
function makeCtx(screenshotSink: (label: string) => void) {
  return {
    data: {} as Record<string, unknown>,
    screenshot: vi.fn(async (opts: { label: string }) => { screenshotSink(opts.label); }),
  } as unknown as Parameters<RunKualiFinalize>[0] & { screenshot: ReturnType<typeof vi.fn> };
}

const baseArgs = {
  kualiPage: {} as never,
  kualiData: { lastDayWorked: "06/01/2026", separationDate: "06/01/2026" } as never,
  lastDayWorked: "06/01/2026",
  separationDate: "06/01/2026",
  ldwChanged: false,
  separationDateChanged: false,
  transactionNumber: "T001234567",
  finalTermEffDate: "06/02/2026",
  timekeeperName: "Test Timekeeper",
};

describe("runKualiFinalize — audit screenshot ordering", () => {
  it("captures the finalization form BEFORE clickSave (save navigates to Home)", async () => {
    const ctx = makeCtx((label) => mocks.order.push(`screenshot:${label}`));

    await runKualiFinalize(ctx, baseArgs);

    const shotIdx = mocks.order.indexOf("screenshot:kuali-finalization-saved");
    const saveIdx = mocks.order.indexOf("clickSave");

    assert.ok(shotIdx !== -1, "the kuali-finalization-saved screenshot must be taken");
    assert.ok(saveIdx !== -1, "clickSave must run");
    assert.ok(
      shotIdx < saveIdx,
      `screenshot must precede clickSave (got screenshot@${shotIdx}, clickSave@${saveIdx}) — ` +
        "a post-save capture shoots the Kuali Home catalog, not the form",
    );
  });

  it("captures exactly one kuali-finalization-saved screenshot of the kuali system", async () => {
    const ctx = makeCtx(() => {});
    await runKualiFinalize(ctx, baseArgs);

    const shots = ctx.screenshot.mock.calls
      .map((call: unknown[]) => call[0] as { label: string; systems?: string[]; kind?: string })
      .filter((o) => o.label === "kuali-finalization-saved");
    assert.equal(shots.length, 1);
    assert.deepEqual(shots[0].systems, ["kuali"]);
    assert.equal(shots[0].kind, "form");
  });
});
