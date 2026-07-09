import type { Page } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { log } from "../../utils/log.js";
import { readExistingContactNames } from "../../systems/ucpath/personal-data.js";
import { emergencyContact as emergencyContactSelectors } from "../../systems/ucpath/selectors.js";
import { dismissPeopleSoftModalMask } from "../../systems/common/modal.js";
import { normalizePersonNameForCompare } from "../../domain/identity/person-name.js";
import { mapRelationship } from "./config.js";
import { levenshteinDistance } from "../../services/matching/index.js";
import type { EmergencyContactRecord } from "./schema.js";

export interface EmergencyContactContext {
  /** Employee name as discovered on the UCPath page. */
  employeeName: string;
}

/**
 * Best-effort PeopleSoft processing-spinner wait, adapted from
 * `ucpath.waitForPeopleSoftProcessing` (which targets a `FrameLocator`) for
 * use directly on this `Page` — Emergency Contact's `uc_deep_link=1` URL
 * renders OUTSIDE the HR Tasks iframe (see `buildEmergencyContactPlan`'s
 * JSDoc), so there is no `FrameLocator` to hand that helper. Same spinner
 * anchors; always resolves (never throws) since the spinner may not appear
 * for every postback — a checkbox/select toggle that doesn't round-trip the
 * server just returns immediately.
 * NEEDS LIVE VERIFY: confirm these anchors actually render on the deep-link
 * (non-iframed) Emergency Contact page the same way they do inside HR Tasks.
 */
async function waitForContactPagePostback(page: Page, timeoutMs = 3_000): Promise<void> {
  const processingSelector =
    "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']"; // allow-inline-selector
  try {
    const probe = page.locator(processingSelector).first(); // allow-inline-selector
    await probe.waitFor({ state: "visible", timeout: 800 });
    await probe.waitFor({ state: "hidden", timeout: timeoutMs });
  } catch {
    // Spinner did not appear or already disappeared — fine.
  }
}


export interface ContactMatch {
  /** The existing contact's name as it appears on the UCPath record. */
  name: string;
  /** Levenshtein distance on normalized names. 0 = exact, > 2 = no match. */
  distance: number;
  /** True iff distance === 0. */
  isExact: boolean;
}

/**
 * Pure matcher — finds the closest fuzzy match for a target name within a
 * list of existing contact names. Uses Levenshtein on normalized forms.
 * Returns null if no candidate is within distance 2.
 *
 * Distance 0 = exact (typically "skip — already current").
 * Distance 1-2 = fuzzy (typically "demote existing primary, add new as primary").
 * > 2 = treat as no match.
 */
export function pickBestContactMatch(
  existingNames: readonly string[],
  targetName: string,
): ContactMatch | null {
  const targetNorm = normalizePersonNameForCompare(targetName, { lettersOnly: true });
  let best: ContactMatch | null = null;
  for (const candidate of existingNames) {
    const norm = normalizePersonNameForCompare(candidate, { lettersOnly: true });
    const distance = levenshteinDistance(norm, targetNorm);
    if (distance > 2) continue;
    if (!best || distance < best.distance) {
      best = { name: candidate, distance, isExact: distance === 0 };
    }
  }
  return best;
}

/**
 * UCPath-side wrapper — reads existing contact names off the page, then
 * delegates to pickBestContactMatch.
 *
 * Returns:
 *   - `null` when no existing contact is within fuzzy-match distance.
 *   - `{ name, distance: 0, isExact: true }` for an exact match (skip).
 *   - `{ name, distance: 1|2, isExact: false }` for a fuzzy match
 *     (workflow should demote the existing primary and add new as primary).
 */
export async function findExistingContactDuplicate(
  page: Page,
  targetName: string,
): Promise<ContactMatch | null> {
  const existing = await readExistingContactNames(page);
  log.step(`Existing contacts on record: [${existing.join(" | ") || "none"}]`);
  return pickBestContactMatch(existing, targetName);
}

/**
 * Build the ActionPlan for filling + saving a single emergency-contact record.
 *
 * Assumes `navigateToEmergencyContact(page, emplId)` already loaded the editor.
 * All field selectors are top-level (`page.getByRole(...)`) because we use the
 * `uc_deep_link=1` URL which opens outside the HR Tasks iframe.
 *
 * Plan (verified 2026-04-14 on EID 10872384):
 *   1. Click "Add a new row at row 1" → inserts blank row as row 1.
 *   2. Fill Contact Name.
 *   3. Primary Contact checkbox (always checked per form convention).
 *   4. Select Relationship (mapped via RELATIONSHIP_MAP).
 *   5. Same Address as Employee — if batch says not-same, uncheck + open Edit
 *      Address modal + fill Address 1/City/State/Postal + OK.
 *   6. Fill Phone (cell > home > work preference).
 *   6. Fill Phone.
 *
 * Save is NOT in this plan — the caller's "save" ctx.step performs the UCPath
 * Save click so the dashboard timeline reflects actual save wall-clock time.
 * The duplicate-guard is also NOT here — call `findExistingContactDuplicate`
 * in workflow.ts before building the plan, and skip plan execution if present.
 */
export function buildEmergencyContactPlan(
  record: EmergencyContactRecord,
  page: Page,
  _ctx: EmergencyContactContext,
): ActionPlan {
  const plan = new ActionPlan();
  const contact = record.emergencyContact;

  // 1. Add a new row.
  plan.add('Click "Add a new row at row 1"', async () => {
    await dismissPeopleSoftModalMask(page);
    await emergencyContactSelectors
      .addNewRowButton(page)
      .click({ timeout: 10_000 });
    // The new row's Contact Name field is what the next plan step fills —
    // wait for it directly instead of a blind pause.
    await emergencyContactSelectors
      .contactNameInputs(page)
      .first()
      .waitFor({ state: "visible", timeout: 6_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  });

  // 2. Contact Name.
  plan.add(`Fill Contact Name: ${contact.name}`, async () => {
    await emergencyContactSelectors
      .contactNameInputs(page)
      .first()
      .fill(contact.name, { timeout: 10_000 });
    // TODO(live-verify): no detectable post-fill condition for a plain text
    // field with no known dependent postback — keeping the settle pause.
    await page.waitForTimeout(500);
  });

  // 3. Primary Contact checkbox.
  plan.add("Set Primary Contact", async () => {
    const cb = emergencyContactSelectors.primaryContactCheckboxes(page).first();
    if (contact.primary) {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (!checked) await cb.check({ timeout: 5_000 });
    } else {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (checked) await cb.uncheck({ timeout: 5_000 });
    }
    // Checkbox toggles can round-trip a PeopleSoft postback; wait for the
    // processing spinner (if any) to settle rather than a blind pause.
    await waitForContactPagePostback(page, 2_000);
  });

  // 4. Relationship.
  const relationshipLabel = mapRelationship(contact.relationship);
  plan.add(
    `Select Relationship: "${contact.relationship}" -> "${relationshipLabel}"`,
    async () => {
      await emergencyContactSelectors
        .relationshipComboBox(page)
        .selectOption({ label: relationshipLabel }, { timeout: 10_000 });
      // A relationship change can round-trip a postback; wait for the
      // processing spinner (if any) to settle rather than a blind pause.
      await waitForContactPagePostback(page, 3_000);
    },
  );

  // 5. Same Address as Employee + manual-address fallback.
  // Treat (sameAddressAsEmployee=false, address=null) as same-address — the
  // schema transform normally rewrites this, but the guard here is defense
  // in depth for any caller that bypasses Zod.
  const wantsSameAddress = contact.sameAddressAsEmployee || !contact.address;
  plan.add(
    wantsSameAddress
      ? 'Check "Same Address as Employee"'
      : 'Uncheck "Same Address as Employee" and enter manual address',
    async () => {
      const sameAddrCb = emergencyContactSelectors.sameAddressAsEmployeeCheckbox(page);
      const checked = await sameAddrCb.isChecked({ timeout: 5_000 }).catch(() => false);

      if (wantsSameAddress) {
        if (!checked) await sameAddrCb.check({ timeout: 5_000 });
        // Checking "Same Address" can round-trip a postback (it hides/disables
        // the manual-address section); wait for the spinner to settle.
        await waitForContactPagePostback(page, 3_000);
        if (!contact.sameAddressAsEmployee && !contact.address) {
          log.step(
            "sameAddressAsEmployee=false + address=null — defensive fallback to same-as-employee",
          );
        }
        return;
      }

      if (checked) await sameAddrCb.uncheck({ timeout: 5_000 });
      // Unchecking reveals the "Edit Address" button — wait for it directly
      // (the next step in this branch clicks it) instead of a blind pause.
      await emergencyContactSelectors
        .editAddressButton(page)
        .waitFor({ state: "visible", timeout: 4_000 })
        .catch(() => {});

      // Unreachable in practice (wantsSameAddress is true when address is null),
      // but kept as a final safety net.
      if (!contact.address) {
        log.step("sameAddressAsEmployee=false but no address in YAML — leaving blank");
        return;
      }

      const addr = contact.address;
      await dismissPeopleSoftModalMask(page);
      await emergencyContactSelectors.editAddressButton(page)
        .click({ timeout: 10_000 });
      // Wait for the Edit Address modal's first field before filling it.
      await emergencyContactSelectors
        .address1Input(page)
        .waitFor({ state: "visible", timeout: 4_000 });

      if (addr.street) {
        await emergencyContactSelectors.address1Input(page)
          .fill(addr.street, { timeout: 10_000 });
      }
      if (addr.city) {
        await emergencyContactSelectors.cityInput(page)
          .fill(addr.city, { timeout: 10_000 });
      }
      if (addr.state) {
        await emergencyContactSelectors.stateInput(page)
          .fill(addr.state, { timeout: 10_000 });
      }
      if (addr.zip) {
        await emergencyContactSelectors.postalInput(page)
          .fill(addr.zip, { timeout: 10_000 });
      }

      await dismissPeopleSoftModalMask(page);
      await emergencyContactSelectors.editAddressOkButton(page)
        .click({ timeout: 10_000 });
      // Wait for the Edit Address modal to close (its Address 1 field
      // detaches/hides) before falling through to the existing networkidle wait.
      await emergencyContactSelectors
        .address1Input(page)
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    },
  );

  // 6. Phone.
  const primaryPhone = contact.cellPhone || contact.homePhone || contact.workPhone;
  if (primaryPhone) {
    plan.add(`Fill Phone: ${primaryPhone}`, async () => {
      await emergencyContactSelectors
        .phoneInput(page)
        .fill(primaryPhone, { timeout: 10_000 });
      // TODO(live-verify): no detectable post-fill condition — Phone is the
      // last field before caller's "save" step; keeping the settle pause.
      await page.waitForTimeout(500);
    });
  } else {
    log.step("No phone number in record — skipping phone fill");
  }

  return plan;
}

/**
 * Read the loaded Emergency Contact editor's header row text — UCPath renders it
 * as "Person ID <emplId> <Employee Name> Emergency Contact". This is the page's
 * OWN identity (distinct from anything the operator typed), used both to extract
 * the display name and as the pre-fill identity gate's `extract` source.
 * Returns "" when the header is absent (the gate then fails loud). An innerText
 * exception (frame detached, etc.) is left to propagate so the gate reports a
 * clear "could not read the displayed identity" rather than a false miss.
 */
export async function readEmergencyContactPersonIdRow(page: Page): Promise<string> {
  const personIdEl = emergencyContactSelectors.personIdText(page);
  if ((await personIdEl.count().catch(() => 0)) === 0) return "";
  return (await personIdEl.locator("..").innerText({ timeout: 3_000 })).trim(); // allow-inline-selector
}

/**
 * Pull the employee's display name from the Emergency Contact page header.
 * UCPath shows it as a generic div alongside "Person ID <emplId>".
 */
export async function extractEmployeeName(
  page: Page,
  ctx: EmergencyContactContext,
): Promise<void> {
  try {
    const rowText = await readEmergencyContactPersonIdRow(page);
    if (!rowText) return;
    const match = rowText.match(/Person ID\s+\d+\s+([A-Za-z][A-Za-z .'-]+?)\s+Emergency Contact/);
    if (match && match[1]) {
      ctx.employeeName = match[1].trim();
    }
  } catch {
    // Best-effort
  }
}
