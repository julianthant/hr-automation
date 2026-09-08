import { beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

const state = vi.hoisted(() => ({ task: 1, reopened: false, savedTxn: "T002230487", savedComments: "Verified STDT 3", saveCount: 0 }));
vi.mock("../../../../src/systems/common/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../src/systems/common/index.js")>(),
  safeClick: async (locator: { click(): Promise<void> }) => locator.click(),
}));
vi.mock("../../../../src/systems/kuali/selectors.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../src/systems/kuali/selectors.js")>(),
  separationForm: { actionDialog: () => ({ innerText: async () => `PLEASE REVIEW AND COMPLETE CHECKLIST - Task ${state.task}` }) },
  transactionResults: { transactionNumber: () => ({ press: async () => {}, waitFor: async () => {}, inputValue: async () => state.reopened ? state.savedTxn : "T002230487" }) },
  finalTransactions: { terminationEffDate: () => ({ inputValue: async () => "09/02/2026" }) },
  timekeeperTasks: { timekeeperComments: () => ({ press: async () => {}, inputValue: async () => state.reopened ? state.savedComments : "Verified STDT 3" }) },
  save: { navbarSaveButton: () => ({ first: () => ({ click: async () => { state.saveCount++; } }) }) },
}));
vi.resetModules();
const { saveAndVerifySeparation } = await import("../../../../src/systems/kuali/navigate.js");
const page = { url: () => "https://example.test/action/4605", evaluate: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {}, goto: async () => { state.reopened = true; } } as never;
beforeEach(() => Object.assign(state, { task: 1, reopened: false, savedTxn: "T002230487", savedComments: "Verified STDT 3", saveCount: 0 }));
describe("Kuali durable Task 1 save", () => {
  it("reopens and verifies the saved transaction and comments", async () => {
    await saveAndVerifySeparation(page, "T002230487", "09/02/2026");
    assert.equal(state.saveCount, 1);
    assert.equal(state.reopened, true);
  });
  it("fails if Save leaves the old transaction or loses comments", async () => {
    state.savedTxn = "T002230440";
    await assert.rejects(saveAndVerifySeparation(page, "T002230487", "09/02/2026"), /did not persist/);
    state.reopened = false; state.savedTxn = "T002230487"; state.savedComments = "";
    await assert.rejects(saveAndVerifySeparation(page, "T002230487", "09/02/2026"), /comments match=false/);
  });
  it("refuses to save Task 2", async () => {
    state.task = 2;
    await assert.rejects(saveAndVerifySeparation(page, "T002230487", "09/02/2026"), /Refusing to save Kuali Task 2/);
    assert.equal(state.saveCount, 0);
  });
});
