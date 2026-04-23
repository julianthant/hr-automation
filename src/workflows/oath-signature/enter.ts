import type { Page, FrameLocator } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { oathSignature } from "../../systems/ucpath/selectors.js";
import { log } from "../../utils/log.js";
import { UCPATH_PERSON_PROFILES_URL } from "./config.js";
import type { OathSignatureInput } from "./schema.js";

/** Mutable context populated during plan execution. */
export interface OathSignatureContext {
  employeeName: string;
  /** Flipped to true when the existing-oath sentinel is absent on profile load. */
  alreadyHasOath: boolean;
}

// --- Helpers ---

async function waitForPageReady(page: Page): Promise<void> {
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

// --- Navigation ---

/**
 * Navigate to the Person Profiles search form via direct component URL.
 * Distinct from Smart HR — Person Profile mounts inside `#ptifrmtgtframe`
 * (not `#main_target_win0`).
 */
export async function navigateToPersonProfiles(page: Page): Promise<void> {
  log.step("Navigating to Person Profiles...");
  await page.goto(UCPATH_PERSON_PROFILES_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await waitForPageReady(page);
  log.success("Person Profiles search form loaded");
}

// --- Search ---

async function searchByEmplId(
  page: Page,
  frame: FrameLocator,
  emplId: string,
): Promise<void> {
  log.step(`Searching for Empl ID: ${emplId}...`);
  // Clear first — Return-to-Search retains the prior EID between iterations
  // in daemon/batch mode, so blind .fill() can append or mismatch.
  const input = oathSignature.emplIdInput(frame);
  await input.click({ timeout: 10_000 }).catch(() => {});
  await input.fill("", { timeout: 10_000 }).catch(() => {});
  await input.fill(emplId, { timeout: 10_000 });
  await oathSignature.searchButton(frame).click({ timeout: 10_000 });
  // PeopleSoft reload — EID is unique so this lands directly on the profile.
  await page.waitForTimeout(4_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function extractEmployeeName(
  frame: FrameLocator,
  ctx: OathSignatureContext,
): Promise<void> {
  try {
    const name = await oathSignature
      .employeeNameDisplay(frame)
      .textContent({ timeout: 3_000 });
    ctx.employeeName = name?.trim() ?? "";
  } catch {
    ctx.employeeName = "";
  }
  log.success(
    `Person Profile loaded${ctx.employeeName ? `: ${ctx.employeeName}` : ""}`,
  );
}

// --- Idempotency probe ---

/**
 * Check the loaded profile for an existing oath signature. UCPath shows a
 * "There are currently no Oath Signature Date for this profile..."
 * sentinel when the section is empty; presence of the sentinel means safe
 * to add. If absent, an oath row is already present — the handler skips.
 */
async function probeExistingOath(
  frame: FrameLocator,
  ctx: OathSignatureContext,
): Promise<void> {
  const sentinelVisible = await oathSignature
    .noOathSentinel(frame)
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  ctx.alreadyHasOath = !sentinelVisible;
  if (ctx.alreadyHasOath) {
    log.warn("Oath signature already exists — handler will skip add+save.");
  }
}

// --- Add + Save ---

async function clickAddNewOath(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Add New Oath Signature Date...");
  await oathSignature.addNewOathLink(frame).click({ timeout: 10_000 });
  await waitForPageReady(page);
}

async function fillOathDateIfProvided(
  frame: FrameLocator,
  date: string | undefined,
): Promise<void> {
  if (!date) {
    log.step("Keeping default oath date (today) from UCPath prefill.");
    return;
  }
  log.step(`Setting oath date to ${date}...`);
  const input = oathSignature.oathDateInput(frame);
  await input.click({ timeout: 10_000 }).catch(() => {});
  await input.fill("", { timeout: 10_000 }).catch(() => {});
  await input.fill(date, { timeout: 10_000 });
}

async function clickOk(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking OK to stage the oath row...");
  await oathSignature.oathOkButton(frame).click({ timeout: 10_000 });
  await waitForPageReady(page);
}

async function clickSave(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Save to commit...");
  await oathSignature.saveButton(frame).click({ timeout: 10_000 });
  // Save writes to DB — longer wait than a tab switch.
  await page.waitForTimeout(4_000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  log.success("Save clicked");
}

/**
 * Click Return-to-Search to restore a clean search form for the next EID in
 * batch/daemon mode. Idempotent — button is absent on the search form itself.
 */
export async function returnToSearch(page: Page, frame: FrameLocator): Promise<void> {
  const btn = oathSignature.returnToSearchButton(frame);
  const visible = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!visible) return;
  log.step("Returning to search...");
  await btn.click({ timeout: 10_000 });
  await waitForPageReady(page);
}

// --- ActionPlan builder ---

/**
 * Build an ActionPlan for adding a single Oath Signature Date.
 *
 * Steps:
 *  1. Navigate to Person Profiles (direct URL)
 *  2. Search for the EID
 *  3. Extract the employee name + probe for existing oath (idempotency)
 *  4. Click "Add New Oath Signature Date" (skipped if already present)
 *  5. Fill the date if overridden (else keep UCPath prefill)
 *  6. Click OK to stage the row
 *  7. Click Save to commit
 *  8. Return to search (so the daemon reuses this browser for the next EID)
 */
export function buildOathSignaturePlan(
  input: OathSignatureInput,
  page: Page,
  ctx: OathSignatureContext,
): ActionPlan {
  const plan = new ActionPlan();
  const getFrame = (): FrameLocator => oathSignature.getPersonProfileFrame(page);

  plan.add("Navigate to Person Profiles", () => navigateToPersonProfiles(page));

  plan.add(
    `Search for Empl ID: ${input.emplId}`,
    () => searchByEmplId(page, getFrame(), input.emplId),
  );

  plan.add("Extract employee name + probe existing oath", async () => {
    await extractEmployeeName(getFrame(), ctx);
    await probeExistingOath(getFrame(), ctx);
  });

  plan.add("Click Add New Oath Signature Date (skip if already present)", async () => {
    if (ctx.alreadyHasOath) return;
    await clickAddNewOath(page, getFrame());
  });

  plan.add(
    input.date ? `Fill oath date: ${input.date}` : "Keep default oath date (today)",
    async () => {
      if (ctx.alreadyHasOath) return;
      await fillOathDateIfProvided(getFrame(), input.date);
    },
  );

  plan.add("Click OK (stage oath row)", async () => {
    if (ctx.alreadyHasOath) return;
    await clickOk(page, getFrame());
  });

  plan.add("Click Save (commit oath)", async () => {
    if (ctx.alreadyHasOath) return;
    await clickSave(page, getFrame());
  });

  plan.add("Return to Search (clean state for next EID)", async () => {
    await returnToSearch(page, getFrame());
  });

  return plan;
}
