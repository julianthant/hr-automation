import type { Page, FrameLocator } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { oathSignature } from "../../systems/ucpath/selectors.js";
import { log } from "../../utils/log.js";
import { UCPATH_PERSON_PROFILES_URL } from "./config.js";
import type { OathSignerInput } from "./schema.js";

/** Mutable context populated during plan execution. */
export interface OathSignatureContext {
  employeeName: string;
  /** Flipped to true when the existing-oath sentinel is absent on profile load. */
  alreadyHasOath: boolean;
  /**
   * The oath signature date actually committed — the value read back from the
   * date field after fill (an operator override) or, when kept, UCPath's
   * today prefill. Empty until the add/fill step runs (skip path leaves it "").
   */
  oathDate: string;
}

/**
 * Audit-screenshot + commit hooks. The handler wires these to `ctx.screenshot`
 * so the visual trail lands at the RIGHT moments (person found → oath staged →
 * saved), never after Return-to-Search — which is why the old single shot only
 * ever captured the empty search form.
 */
export interface OathSignaturePlanOptions {
  /** After the profile loads + name/existing-oath probe (all paths). */
  onProfileLoaded?: () => Promise<void>;
  /** After the staged oath row is applied via OK (add path only). */
  onOathStaged?: () => Promise<void>;
  /** Dry-run only: right before the (skipped) Save click. */
  beforeCommit?: () => Promise<void>;
  /** After a real Save commits the oath, before returning to search. */
  onSaved?: () => Promise<void>;
}

export function shouldCommitOathSignature(
  input: OathSignerInput,
  ctx: Pick<OathSignatureContext, "alreadyHasOath">,
): boolean {
  return !input.dryRun && !ctx.alreadyHasOath;
}

// --- Helpers ---

async function waitForPageReady(page: Page): Promise<void> {
  // networkidle guards the PeopleSoft roundtrip; the preceding fixed sleep
  // was redundant (3s × 3+ calls/signer = ≥9s/signer wasted on a 20-signer batch).
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function isPersonProfilesSearchFormVisible(frame: FrameLocator): Promise<boolean> {
  return oathSignature
    .emplIdInput(frame)
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

async function waitForPersonProfilesSearchForm(frame: FrameLocator): Promise<void> {
  await oathSignature.emplIdInput(frame).waitFor({ state: "visible", timeout: 10_000 });
}

/**
 * PeopleSoft can preserve the last Person Profile detail page across direct
 * component URL loads. Make the search-form state explicit before filling the
 * next EID; otherwise daemon item N+1 can time out looking for the search box
 * while item N's profile is still rendered.
 */
export async function ensurePersonProfilesSearchForm(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  if (await isPersonProfilesSearchFormVisible(frame)) return;

  const returnButton = oathSignature.returnToSearchButton(frame);
  const canReturn = await returnButton.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!canReturn) {
    throw new Error("Person Profiles search form is not visible and Return to Search is unavailable");
  }

  log.step("Person Profiles opened on a prior profile — returning to search...");
  await returnButton.click({ timeout: 10_000 });
  await waitForPageReady(page);
  await waitForPersonProfilesSearchForm(frame);
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
  await ensurePersonProfilesSearchForm(page, oathSignature.getPersonProfileFrame(page));
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
  // networkidle guards the navigation; fixed sleep was redundant.
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

async function fillOathDateAndCapture(
  frame: FrameLocator,
  date: string | undefined,
  ctx: OathSignatureContext,
): Promise<void> {
  const input = oathSignature.oathDateInput(frame);
  if (date) {
    log.step(`Setting oath date to ${date}...`);
    await input.click({ timeout: 10_000 }).catch(() => {});
    await input.fill("", { timeout: 10_000 }).catch(() => {});
    await input.fill(date, { timeout: 10_000 });
  } else {
    log.step("Keeping default oath date (today) from UCPath prefill.");
  }
  // Read the committed value back so the tracker row records the actual oath
  // date (the override, or UCPath's today prefill) — previously never captured,
  // so the "Signature Date" field stayed blank on every default-date run.
  try {
    const value = (await input.inputValue({ timeout: 3_000 }))?.trim() ?? "";
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      ctx.oathDate = value;
      log.step(`Oath date on form: ${value}`);
    }
  } catch {
    /* best-effort — handler falls back to input.date / today */
  }
}

async function clickOk(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking OK to stage the oath row...");
  await oathSignature.oathOkButton(frame).click({ timeout: 10_000 });
  await waitForPageReady(page);
}

async function clickSave(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Clicking Save to commit...");
  await oathSignature.saveButton(frame).click({ timeout: 10_000 });
  // Save writes to DB — networkidle guards completion; fixed sleep was redundant.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  log.success("Save clicked");
}

/**
 * Handler-facing cleanup: return to the search form for the next daemon EID.
 * Called AFTER the transaction step (not inside the plan) so the step's
 * end-of-step audit screenshot captures the saved oath, not this search form.
 */
export async function returnToSearchForNextItem(page: Page): Promise<void> {
  await returnToSearch(page, oathSignature.getPersonProfileFrame(page));
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
  await waitForPersonProfilesSearchForm(frame);
}

// --- ActionPlan builder ---

/**
 * Build an ActionPlan for adding a single Oath Signature Date.
 *
 * Steps:
 *  1. Navigate to Person Profiles (direct URL)
 *  2. Search for the EID
 *  3. Extract the employee name + probe for existing oath (idempotency)
 *     → `onProfileLoaded` audit shot (person found)
 *  4. Click "Add New Oath Signature Date" (skipped if already present)
 *  5. Fill the date if overridden (else keep UCPath prefill) + read it back
 *  6. Click OK to stage the row → `onOathStaged` audit shot
 *  7. Click Save to commit → `onSaved` audit shot
 *
 * Return-to-Search is deliberately NOT in the plan: it runs in the handler
 * AFTER the transaction step ends, so the step's end-of-step audit screenshot
 * captures the SAVED oath instead of the empty search form (the reported bug).
 * `betweenItems: ["reset"]` + `ensurePersonProfilesSearchForm` handle inter-item
 * cleanup regardless.
 */
export function buildOathSignaturePlan(
  input: OathSignerInput,
  page: Page,
  ctx: OathSignatureContext,
  options: OathSignaturePlanOptions = {},
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
    await options.onProfileLoaded?.();
  });

  plan.add("Click Add New Oath Signature Date (skip if already present)", async () => {
    if (ctx.alreadyHasOath) return;
    await clickAddNewOath(page, getFrame());
  });

  plan.add(
    input.date ? `Fill oath date: ${input.date}` : "Keep default oath date (today)",
    async () => {
      if (ctx.alreadyHasOath) return;
      await fillOathDateAndCapture(getFrame(), input.date, ctx);
    },
  );

  plan.add("Click OK (stage oath row)", async () => {
    if (ctx.alreadyHasOath) return;
    await clickOk(page, getFrame());
    await options.onOathStaged?.();
  });

  plan.add("Click Save (commit oath)", async () => {
    if (ctx.alreadyHasOath) return;
    if (!shouldCommitOathSignature(input, ctx)) {
      await options.beforeCommit?.();
      log.success("Dry run: skipped UCPath Save for oath signature.");
      return;
    }
    await clickSave(page, getFrame());
    await options.onSaved?.();
  });

  return plan;
}
