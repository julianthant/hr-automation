import type { Page, FrameLocator } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { getContentFrame } from "../../systems/ucpath/navigate.js";
import { log } from "../../utils/log.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import type { WorkStudyInput } from "./schema.js";

/** Mutable context populated during plan execution. */
export interface WorkStudyContext {
  employeeName: string;
}

// --- Selectors (verified via playwright-cli 2026-03-17) ---
// Use role-based selectors (more resilient to PeopleSoft dynamic rendering).
// Fallback ID selectors as .or() alternatives.

const SEL_SAVE_AND_SUBMIT = '[id="UC_E102_PP_WRK_SUBMIT_BTN"]';

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
  await page.getByRole("link", { name: "PayPath/Additional Pay" }).click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // Click PayPath Actions sub-item
  log.step("Clicking PayPath Actions...");
  await page.getByRole("link", { name: "PayPath Actions", exact: true }).click({ timeout: 10_000 });
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
  await frame.getByRole("textbox", { name: "Empl ID" }).fill(emplId, { timeout: 10_000 });
  log.step("Filled Empl ID, clicking Search...");
  await frame.getByRole("button", { name: "Search", exact: true }).click({ timeout: 10_000 });
  // PeopleSoft reloads the iframe content after search — needs extra wait
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Dismiss any PeopleSoft alert dialog (e.g. "payroll in progress" warning)
  const okBtn = page.getByRole("button", { name: "OK" });
  if (await okBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    log.step("Dismissing PeopleSoft alert dialog...");
    await okBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);
  }

  // Extract employee name from Position Data header.
  // SELECTOR: verified v1 — the name is a SPAN with ID UC_E102_PP_WRK_NAME_DISPLAY
  // or the first text in the record header area. Try multiple selectors.
  try {
    const nameEl = frame.locator('[id="UC_E102_PP_WRK_NAME_DISPLAY"]')
      .or(frame.locator('[id*="NAME_DISPLAY"]').first());
    const name = await nameEl.textContent({ timeout: 5_000 });
    ctx.employeeName = name?.trim() ?? "";
  } catch {
    ctx.employeeName = "";
  }
  log.success(`Employee record loaded${ctx.employeeName ? `: ${ctx.employeeName}` : ""}`);
}

async function collapseSidebar(page: Page): Promise<void> {
  const sidebarBtn = page.getByRole("button", { name: "Navigation Area" });
  const isExpanded = await sidebarBtn.getAttribute("aria-expanded").catch(() => null);
  if (isExpanded === "true") {
    log.step("Collapsing sidebar...");
    await sidebarBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
  }
}

// --- Position Data tab ---

async function fillPositionData(
  page: Page,
  frame: FrameLocator,
  effectiveDate: string,
): Promise<void> {
  log.step("Filling Position Data tab...");

  log.step(`  Effective Date: ${effectiveDate}`);
  await frame.getByRole("textbox", { name: "Effective Date:" })
    .fill(effectiveDate, { timeout: 20_000 });

  log.step("  Position Change Reason: JRL");
  await frame.getByRole("textbox", { name: "Position Change Reason:" })
    .fill("JRL", { timeout: 10_000 });

  log.step("  Position Pool: F");
  await frame.getByRole("textbox", { name: "Position Pool:" })
    .fill("F", { timeout: 10_000 });

  log.success("Position Data filled");
}

// --- Job Data tab ---

async function clickJobDataTab(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Job Data tab...");
  await frame.getByRole("tab", { name: "Job Data" }).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("Job Data tab loaded");
}

async function fillJobDataComments(
  frame: FrameLocator,
  comments: string,
): Promise<void> {
  log.step(`  Job Data Comments: ${comments}`);
  await frame.getByRole("textbox", { name: "Job Data Comments:" })
    .fill(comments, { timeout: 10_000 });
  log.success("Job Data Comments filled");
}

// --- Additional Pay Data tab ---

async function clickAdditionalPayTab(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Additional Pay Data tab...");
  await frame.getByRole("tab", { name: "Additional Pay Data" }).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("Additional Pay Data tab loaded");
}

async function fillInitiatorComments(
  frame: FrameLocator,
  comments: string,
): Promise<void> {
  log.step(`  Initiator's Comments: ${comments}`);
  await frame.getByRole("textbox", { name: "Initiator's Comments" })
    .fill(comments, { timeout: 10_000 });
  log.success("Initiator's Comments filled");
}

async function clickSaveAndSubmit(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Save And Submit...");
  await frame.locator(SEL_SAVE_AND_SUBMIT).click({ timeout: 10_000 });
  await waitForPageReady(page);
  log.success("Save And Submit clicked");
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

  // TODO: re-enable after testing
  // plan.add(
  //   "Save and Submit",
  //   () => clickSaveAndSubmit(page, getContentFrame(page)),
  // );

  return plan;
}
