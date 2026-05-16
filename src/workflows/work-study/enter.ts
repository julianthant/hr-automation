import type { Page, FrameLocator } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { clickSaveAndSubmit } from "../../systems/ucpath/index.js";
import { getContentFrame } from "../../systems/ucpath/navigate.js";
import { payPathActions, hrTasks, smartHR } from "../../systems/ucpath/selectors.js";
import { log } from "../../utils/log.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import type { WorkStudyInput } from "./schema.js";

/** Mutable context populated during plan execution. */
export interface WorkStudyContext {
  employeeName: string;
}

// --- Helpers ---

async function waitForPageReady(page: Page): Promise<void> {
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

function buildCommentsText(effectiveDate: string): string {
  return `Updated pool id to F per work study award ${effectiveDate}`;
}

// --- Navigation ---

/**
 * Navigate to the PayPath Actions page via the HR Tasks Activity Guide sidebar.
 * Must go through the sidebar so the content loads inside the PeopleSoft iframe.
 * SELECTOR: verified via playwright-cli 2026-03-17
 */
async function navigateToPayPathActions(page: Page): Promise<void> {
  log.step("Navigating to HR Tasks...");
  await page.goto(UCPATH_SMART_HR_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await waitForPageReady(page);

  // Click PayPath/Additional Pay in sidebar to expand sub-items
  log.step("Expanding PayPath/Additional Pay...");
  await hrTasks.payPathLink(page).click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // Click PayPath Actions sub-item
  log.step("Clicking PayPath Actions...");
  await hrTasks.payPathActionsLink(page).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("PayPath Actions search page loaded");
}

async function searchEmployee(
  page: Page,
  frame: FrameLocator,
  emplId: string,
  ctx: WorkStudyContext,
): Promise<void> {
  log.step(`Searching for Empl ID: ${emplId}...`);
  await payPathActions.emplIdInput(frame).fill(emplId, { timeout: 10_000 });
  log.step("Filled Empl ID, clicking Search...");
  await payPathActions.searchButton(frame).click({ timeout: 10_000 });
  // PeopleSoft reloads the iframe content after search — needs extra wait
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Dismiss any PeopleSoft alert dialog (e.g. "payroll in progress" warning)
  const okBtn = payPathActions.alertOkButton(page);
  if (await okBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    log.step("Dismissing PeopleSoft alert dialog...");
    await okBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);
  }

  // Extract employee name from Position Data header.
  try {
    const nameEl = payPathActions.employeeNameDisplay(frame);
    const name = await nameEl.textContent({ timeout: 5_000 });
    ctx.employeeName = name?.trim() ?? "";
  } catch {
    ctx.employeeName = "";
  }
  log.success(`Employee record loaded${ctx.employeeName ? `: ${ctx.employeeName}` : ""}`);
}

async function collapseSidebar(page: Page): Promise<void> {
  const sidebarBtn = smartHR.sidebarNavigationToggle(page);
  const isExpanded = await sidebarBtn.getAttribute("aria-expanded").catch(() => null);
  if (isExpanded === "true") {
    log.step("Collapsing sidebar...");
    await sidebarBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
  }
}

// --- Position Data tab ---

async function fillPositionData(
  _page: Page,
  frame: FrameLocator,
  effectiveDate: string,
): Promise<void> {
  log.step("Filling Position Data tab...");

  log.step(`  Effective Date: ${effectiveDate}`);
  await payPathActions.effectiveDateInput(frame)
    .fill(effectiveDate, { timeout: 20_000 });

  log.step("  Position Change Reason: JRL");
  await payPathActions.positionChangeReasonInput(frame)
    .fill("JRL", { timeout: 10_000 });

  log.step("  Position Pool: F");
  await payPathActions.positionPoolInput(frame)
    .fill("F", { timeout: 10_000 });

  log.success("Position Data filled");
}

// --- Job Data tab ---

async function clickJobDataTab(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Job Data tab...");
  await payPathActions.jobDataTab(frame).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("Job Data tab loaded");
}

async function fillJobDataComments(
  frame: FrameLocator,
  comments: string,
): Promise<void> {
  log.step(`  Job Data Comments: ${comments}`);
  await payPathActions.jobDataCommentsInput(frame)
    .fill(comments, { timeout: 10_000 });
  log.success("Job Data Comments filled");
}

// --- Additional Pay Data tab ---

async function clickAdditionalPayTab(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Additional Pay Data tab...");
  await payPathActions.additionalPayDataTab(frame).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("Additional Pay Data tab loaded");
}

async function fillInitiatorComments(
  frame: FrameLocator,
  comments: string,
): Promise<void> {
  log.step(`  Initiator's Comments: ${comments}`);
  await payPathActions.initiatorsCommentsInput(frame)
    .fill(comments, { timeout: 10_000 });
  log.success("Initiator's Comments filled");
}

// --- ActionPlan builder ---

/**
 * Build an ActionPlan for the Work Study PayPath transaction.
 *
 * Steps:
 *  1. Navigate to PayPath Actions
 *  2. Collapse sidebar
 *  3. Search for employee by Empl ID
 *  4. Fill Position Data: effective date, reason JRL, pool F
 *  5. Click Job Data tab
 *  6. Fill Job Data Comments
 *  7. Click Additional Pay Data tab
 *  8. Fill Initiator's Comments
 *  9. Save and Submit
 */
export function buildWorkStudyPlan(
  input: WorkStudyInput,
  page: Page,
  ctx: WorkStudyContext,
): ActionPlan {
  const plan = new ActionPlan();
  const comments = buildCommentsText(input.effectiveDate);

  plan.add(
    "Navigate to PayPath Actions",
    () => navigateToPayPathActions(page),
  );

  plan.add(
    "Collapse sidebar",
    () => collapseSidebar(page),
  );

  plan.add(
    `Search for Empl ID: ${input.emplId}`,
    () => searchEmployee(page, getContentFrame(page), input.emplId, ctx),
  );

  plan.add(
    `Fill Position Data (eff date: ${input.effectiveDate}, reason: JRL, pool: F)`,
    () => fillPositionData(page, getContentFrame(page), input.effectiveDate),
  );

  plan.add(
    "Click Job Data tab",
    () => clickJobDataTab(page, getContentFrame(page)),
  );

  plan.add(
    `Fill Job Data Comments: ${comments}`,
    () => fillJobDataComments(getContentFrame(page), comments),
  );

  plan.add(
    "Click Additional Pay Data tab",
    () => clickAdditionalPayTab(page, getContentFrame(page)),
  );

  plan.add(
    `Fill Initiator's Comments: ${comments}`,
    () => fillInitiatorComments(getContentFrame(page), comments),
  );

  plan.add(
    "Save and Submit",
    async () => {
      const result = await clickSaveAndSubmit(page, getContentFrame(page), input.emplId);
      if (!result.success) {
        throw new Error(result.error ?? "Save and Submit failed");
      }
    },
  );

  return plan;
}
