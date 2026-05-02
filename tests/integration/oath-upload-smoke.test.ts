import { test } from "node:test";

/**
 * Integration smoke test for the oath-upload workflow.
 *
 * Marked `todo` because exercising the full handler end-to-end requires:
 *  - Stubbing Session.launch (Playwright Browser/Page hierarchy) so the
 *    handler's `await ctx.page("servicenow")` resolves to a fake page
 *  - Stubbing loginToServiceNow (ServiceNow Duo MFA isn't reproducible in CI)
 *  - Stubbing the OCR child workflow run (depends on Gemini API + a real PDF)
 *  - Stubbing watchChildRuns (else the test waits 7 days)
 *
 * The handler unit test (`tests/unit/workflows/oath-upload/handler.test.ts`)
 * already covers the orchestration logic by passing test escape hatches
 * (`_runOcrOverride`, `_waitForOcrApprovalOverride`, `_watchChildRunsOverride`,
 * `_gotoOverride`, `_verifyOverride`, `_fillFormOverride`, `_submitOverride`).
 * Together with the kernel's `runWorkflow` test coverage in
 * `tests/unit/core/workflow.test.ts`, the regression net is sufficient
 * for a v1 ship — manual smoke (Task 28) covers the live-target behavior
 * that no automated test can simulate.
 *
 * If/when a fake Session.launch + fake Page harness lands in the repo,
 * upgrade this todo to a runnable test that:
 *   1. Spins up a tmp tracker dir
 *   2. Pre-stages an OCR `step="approved"` entry with fannedOutItemIds=[]
 *   3. Pre-stages all oath-signature children as `status="done"` (zero
 *      itemIds means watchChildRuns resolves immediately)
 *   4. Calls runOathUpload with a fake PDF path
 *   5. Asserts the final tracker row has status="done" step="submit"
 *      and data.ticketNumber matches the stub'd return value
 */
test("oath-upload integration smoke — end-to-end workflow run", { todo: true }, () => {
  // Body intentionally empty — see comment above.
});
