import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";

vi.resetModules();
const state = vi.hoisted(() => ({
  search: "", current: "", comments: "canonical", initiator: "canonical", opened: [] as string[],
  wrongId: false, directJobForm: false, receiptEffectiveDate: "09/02/2026", continueClicks: 0,
  approvalStatus: "Pending", dialogText: "",
}));
vi.mock("../../../../src/systems/ucpath/navigate.js", async (original) => ({
  ...await original<typeof import("../../../../src/systems/ucpath/navigate.js")>(),
  navigateToSmartHR: async () => { state.search = ""; state.current = ""; },
  collapseSidebar: async () => {}, waitForPeopleSoftProcessing: async () => {},
  readPeopleSoftDialogText: async () => state.dialogText,
  dismissPeopleSoftDialog: async () => { state.dialogText = ""; return true; },
}));
vi.mock("../../../../src/systems/common/index.js", async (original) => ({
  ...await original<typeof import("../../../../src/systems/common/index.js")>(),
  safeClick: async (locator: { click: () => Promise<void> }) => locator.click(),
  safeFill: async (locator: { fill: (value: string) => Promise<void> }, value: string) => locator.fill(value),
}));
vi.mock("../../../../src/systems/ucpath/selectors.js", async (original) => {
  const real = await original<typeof import("../../../../src/systems/ucpath/selectors.js")>();
  const idle = () => ({ click: async () => {}, waitFor: async () => {}, count: async () => 1 });
  const grid = () => [
    ["Transaction ID", "Action", "Approval Status"],
    ["T000000001", "TER", "Pending"], ["T000000002", "TER", "Pending"],
  ];
  const body = () => ({
    evaluate: async () => grid(),
    innerText: async () => `Effective Date: ${state.receiptEffectiveDate} Employee ID: 10599318 Employee Record: ${state.current === "T000000001" ? "0 (STDT 3)" : "1 (STDT 4)"}`,
  });
  return {
    ...real,
    getContentFrame: () => ({ locator: body }),
    hrTasks: { ...real.hrTasks, smartHRTemplatesLink: idle, ssSmartHRTransactionsLink: idle },
    jobData: { ...real.jobData, positionNumberInput: () => ({ count: async () => 1, inputValue: async () => state.current === "T000000001" ? "41202096" : "41079142" }) },
    smartHR: {
      ...real.smartHR,
      transactionBody: body,
      employmentRecordSelect: () => ({ ...idle(), count: async () => state.directJobForm ? 0 : 1 }),
      continueButton: () => ({ click: async () => { state.continueClicks += 1; } }),
    },
    comments: { ...real.comments, commentsTextarea: () => ({ inputValue: async () => state.comments }), initiatorCommentsTextarea: () => ({ inputValue: async () => state.initiator }) },
    ssSmartHRTransactions: {
      ...real.ssSmartHRTransactions,
      // `navigateToSsSmartHrTransactions` probes these two before deciding to
      // skip / return-to-search / navigate (2026-09-16 sequential reuse). Both
      // absent = this stub is on neither the search form nor a detail page, so
      // the separations path still does the full sidebar drill it asserts.
      nameInput: () => ({ isVisible: async () => false, waitFor: async () => {} }),
      returnToSearchButton: () => ({ isVisible: async () => false }),
      emplIdInput: () => ({ fill: async () => {} }),
      txnNumberTextbox: () => ({ fill: async (value: string) => { state.search = value; } }),
      searchButton: () => ({ click: async () => { state.current = state.search; if (state.current) state.opened.push(state.current); } }),
      transactionDetailTxnId: () => ({
        count: async () => (state.current ? 1 : 0),
        innerText: async () => (state.wrongId ? "T000000009" : state.current),
        isVisible: async () => Boolean(state.current),
        filter: idle,
      }),
      transactionDetailApprovalStatus: () => ({ innerText: async () => state.approvalStatus }),
      detailPersonLink: idle,
    },
  };
});

let findTerminationTransactionStatus: typeof import("../../../../src/systems/ucpath/ss-smart-hr.js")["findTerminationTransactionStatus"];
let findExistingTerminationTransaction: typeof import("../../../../src/systems/ucpath/transaction.js")["findExistingTerminationTransaction"];
beforeAll(async () => {
  ({ findTerminationTransactionStatus } = await import("../../../../src/systems/ucpath/ss-smart-hr.js"));
  ({ findExistingTerminationTransaction } = await import("../../../../src/systems/ucpath/transaction.js"));
});
const page = { waitForTimeout: async () => {}, waitForLoadState: async () => {} } as unknown as Page;
const job = { emplRecord: "0", positionNumber: "41202096", jobCode: "004920" };
const options = { job, effectiveDate: "09/02/2026", expectedComments: "canonical" };
beforeEach(() => {
  Object.assign(state, {
    search: "", current: "", comments: "canonical", initiator: "canonical", opened: [],
    wrongId: false, directJobForm: false, receiptEffectiveDate: "09/02/2026", continueClicks: 0,
    approvalStatus: "Pending", dialogText: "",
  });
});

describe("job-scoped SS receipt reuse", () => {
  it("restores the matching receipt after inspecting a different concurrent job", async () => {
    const result = await findTerminationTransactionStatus(page, "10599318", options);
    assert.equal(result.transactionId, "T000000001");
    assert.equal(state.current, result.transactionId);
    assert.deepEqual(state.opened, ["T000000001", "T000000002", "T000000001"]);
  });
  for (const field of ["comments", "initiator"] as const) {
    it(`rejects extra narrative in ${field}`, async () => {
      state[field] = "canonical Extra job/source narrative";
      await assert.rejects(() => findTerminationTransactionStatus(page, "10599318", options), /incorrect Comments or Initiator/);
    });
  }
  it("reuses an Approved receipt when comments differ (manual initiator)", async () => {
    state.approvalStatus = "Approved";
    state.comments = "Student Separation effective 6/13/2026 Reason: Look for another job";
    state.initiator = "Student Separation effective 6/13/2026 Reason: Look for another job";
    // Only one grid row so restore-path is not exercised
    const result = await findTerminationTransactionStatus(page, "10599318", {
      ...options,
      expectedComments: "Termination eff 09/02/2026. Last Day Worked 09/01/2026. Kuali form #4671.",
    });
    assert.equal(result.found, true);
    assert.equal(result.transactionId, "T000000001");
    assert.equal(result.approvalStatus, "Approved");
  });
  it("reuses an Approved receipt when job-form drill-in raises a UCPath system dialog", async () => {
    state.approvalStatus = "Approved";
    state.dialogText = "An error occurred. Please consult your system log for details.";
    const result = await findTerminationTransactionStatus(page, "10599318", options);
    assert.equal(result.found, true);
    assert.equal(result.transactionId, "T000000001");
    assert.equal(result.approvalStatus, "Approved");
  });
  it("still fails Pending receipts on a UCPath system dialog", async () => {
    state.dialogText = "An error occurred. Please consult your system log for details.";
    await assert.rejects(
      () => findTerminationTransactionStatus(page, "10599318", options),
      /UCPath dialog on receipt/,
    );
  });
  it("rejects a receipt number that changed during navigation", async () => {
    state.wrongId = true;
    await assert.rejects(() => findTerminationTransactionStatus(page, "10599318", options), /Cannot verify termination receipt/);
  });
  it("reads a single-record receipt whose employee drill-in opens the job form directly", async () => {
    state.directJobForm = true;
    const result = await findTerminationTransactionStatus(page, "10599318", options);
    assert.equal(result.transactionId, "T000000001");
    assert.equal(state.continueClicks, 0);
  });
  it("skips a prior receipt by effective date before requiring a job form", async () => {
    state.receiptEffectiveDate = "08/31/2026";
    state.directJobForm = true;
    const result = await findTerminationTransactionStatus(page, "10599318", options);
    assert.equal(result.found, false);
    assert.equal(state.continueClicks, 0);
  });
  it("permits duplicate Kuali request document reference in comments", async () => {
    state.comments = "Termination eff 09/02/2026. Last Day Worked 09/01/2026. Kuali form #4653.";
    state.initiator = "Termination eff 09/02/2026. Last Day Worked 09/01/2026. Kuali form #4653.";
    const result = await findTerminationTransactionStatus(page, "10599318", {
      ...options,
      expectedComments: "Termination eff 09/02/2026. Last Day Worked 09/01/2026. Kuali form #4652.",
    });
    assert.equal(result.transactionId, "T000000001");
  });
  it("rejects substantive comment mismatches across Kuali requests", async () => {
    state.comments = "Termination eff 09/02/2026. Last Day Worked 08/30/2026. Kuali form #4653.";
    state.initiator = "Termination eff 09/02/2026. Last Day Worked 08/30/2026. Kuali form #4653.";
    await assert.rejects(
      () => findTerminationTransactionStatus(page, "10599318", {
        ...options,
        expectedComments: "Termination eff 09/02/2026. Last Day Worked 09/01/2026. Kuali form #4652.",
      }),
      /incorrect Comments or Initiator/,
    );
  });
  it("requires canonical expected comments before either lookup navigates", async () => {
    await assert.rejects(() => findTerminationTransactionStatus(page, "10599318", { job, effectiveDate: "09/02/2026" }), /requires canonical comments/);
    await assert.rejects(() => findExistingTerminationTransaction(page, "10599318", "09/02/2026", job), /requires canonical comments/);
    assert.deepEqual(state.opened, []);
  });
});
