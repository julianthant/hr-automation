import { describe, test, beforeAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * `runTransactionCheck` decouples two concerns (2026-06-24):
 *   1. APPROVED-reuse detection via the effdt-gated SS Smart HR search
 *      (`findTerminationTransactionStatus`).
 *   2. A DATE-AGNOSTIC pending sweep of the "Transactions in Progress" grid
 *      (`deletePendingTransaction`) on every create-bound path.
 *
 * Both ucpath system functions are mocked at the module boundary; a fake ctx
 * supplies `page()` + `screenshot()`. These tests pin that the sweep runs
 * independently of what the SS Smart HR search returned — the regression that
 * let a prior run's pending termination (different effective date) survive both
 * date-keyed backstops and become a visible duplicate.
 */

const mocks = vi.hoisted(() => ({
  findTerminationTransactionStatus: vi.fn(),
  deletePendingTransaction: vi.fn(),
}));

// This repo's vitest runs single-fork with a SHARED module cache, so a static
// top-level import of the step would bind the REAL ucpath functions before the
// mock applies (same gotcha as dry-run.test.ts). `vi.resetModules()` + a dynamic
// import in beforeAll makes the mock intercept land first.
vi.resetModules();

// Keep every other ucpath export real; stub only the two functions the step calls.
vi.mock("../../../../src/systems/ucpath/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/systems/ucpath/index.js")>()),
  findTerminationTransactionStatus: mocks.findTerminationTransactionStatus,
  deletePendingTransaction: mocks.deletePendingTransaction,
}));

// Dynamically loaded AFTER the mocks register (see vi.resetModules above).
let runTransactionCheck: typeof import(
  "../../../../src/workflows/separations/steps/transaction-check.js"
)["runTransactionCheck"];

beforeAll(async () => {
  ({ runTransactionCheck } = await import(
    "../../../../src/workflows/separations/steps/transaction-check.js"
  ));
});

const EID = "10779506";

// Minimal ctx: the step only awaits ctx.page("ucpath") and best-effort
// ctx.screenshot(). The returned "page" is opaque — the real system calls are
// mocked — so an empty object is enough.
function makeCtx() {
  const page = {};
  return {
    page: vi.fn(async () => page),
    screenshot: vi.fn(async () => {}),
    page$: page,
  } as never;
}

function ter(overrides: Partial<{
  found: boolean;
  transactionId: string;
  approvalStatus: string;
  effectiveDate: string;
  priorTerminationSkipped: boolean;
}>) {
  return {
    found: false,
    transactionId: "",
    approvalStatus: "",
    effectiveDate: "",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findTerminationTransactionStatus.mockReset();
  mocks.deletePendingTransaction.mockReset();
  mocks.deletePendingTransaction.mockResolvedValue(0);
});

describe("runTransactionCheck — approved-reuse (concern 1)", () => {
  test("APPROVED TER → reuse, and NO pending sweep", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: true, transactionId: "T1", approvalStatus: "Approved", effectiveDate: "06/20/2026" }),
    );
    const result = await runTransactionCheck(makeCtx(), EID, {
      dryRun: false,
      separationDate: "06/19/2026",
    });
    assert.deepEqual(result, { status: "approved", transactionNumber: "T1" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 0, "approved path must not sweep");
  });
});

describe("runTransactionCheck — pending sweep (concern 2)", () => {
  test("PENDING TER visible in SS Smart HR → sweep, status pending-deleted", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: true, transactionId: "T1", approvalStatus: "Pending", effectiveDate: "06/20/2026" }),
    );
    mocks.deletePendingTransaction.mockResolvedValue(1);
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: false });
    assert.deepEqual(result, { status: "pending-deleted", transactionId: "T1" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 1);
    assert.equal(mocks.deletePendingTransaction.mock.calls[0][1], EID, "swept by EID");
  });

  test("REGRESSION: SS Smart HR found NOTHING but a stale pending exists in the grid → still swept", async () => {
    // The core bug: the effdt-gated search doesn't surface the in-progress
    // pending (different/old effdt), yet the grid sweep must still clear it
    // before the create — otherwise a duplicate is born.
    mocks.findTerminationTransactionStatus.mockResolvedValue(ter({ found: false }));
    mocks.deletePendingTransaction.mockResolvedValue(1);
    const result = await runTransactionCheck(makeCtx(), EID, {
      dryRun: false,
      separationDate: "06/19/2026",
    });
    assert.deepEqual(result, { status: "pending-deleted", transactionId: "" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 1, "sweep runs even when the search found nothing");
  });

  test("prior-job termination flagged (priorTerminationSkipped) → still attempts the sweep; empty grid → none", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: false, priorTerminationSkipped: true, effectiveDate: "01/01/2025" }),
    );
    mocks.deletePendingTransaction.mockResolvedValue(0);
    const result = await runTransactionCheck(makeCtx(), EID, {
      dryRun: false,
      separationDate: "06/19/2026",
    });
    assert.deepEqual(result, { status: "none" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 1, "sweep attempted before create");
  });

  test("multiple stale pendings deleted → count reflected, status pending-deleted", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(ter({ found: false }));
    mocks.deletePendingTransaction.mockResolvedValue(2);
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: false });
    assert.deepEqual(result, { status: "pending-deleted", transactionId: "" });
  });

  test("other status (Denied) with no pending in grid → none, sweep attempted", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: true, transactionId: "T9", approvalStatus: "Denied", effectiveDate: "06/20/2026" }),
    );
    mocks.deletePendingTransaction.mockResolvedValue(0);
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: false });
    assert.deepEqual(result, { status: "none" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 1);
  });
});

describe("runTransactionCheck — dry-run guards the mutation", () => {
  test("PENDING TER + dry-run → no sweep, status pending-skipped-dryrun", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: true, transactionId: "T1", approvalStatus: "Pending", effectiveDate: "06/20/2026" }),
    );
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: true });
    assert.deepEqual(result, { status: "pending-skipped-dryrun", transactionId: "T1" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 0, "dry-run never deletes");
  });

  test("nothing found + dry-run → none, no sweep", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(ter({ found: false }));
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: true });
    assert.deepEqual(result, { status: "none" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 0);
  });

  test("APPROVED + dry-run → reuse, no sweep", async () => {
    mocks.findTerminationTransactionStatus.mockResolvedValue(
      ter({ found: true, transactionId: "T1", approvalStatus: "Approved", effectiveDate: "06/20/2026" }),
    );
    const result = await runTransactionCheck(makeCtx(), EID, { dryRun: true });
    assert.deepEqual(result, { status: "approved", transactionNumber: "T1" });
    assert.equal(mocks.deletePendingTransaction.mock.calls.length, 0);
  });
});
