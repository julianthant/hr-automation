import type { Page } from "playwright";
import { ActionPlan } from "../../ucpath/action-plan.js";
import { log } from "../../utils/log.js";
import {
  hidePeopleSoftModalMask,
  readExistingContactNames,
} from "../../ucpath/personal-data.js";
import { mapRelationship } from "./config.js";
import type { EmergencyContactRecord } from "./schema.js";

export interface EmergencyContactContext {
  /** Employee name as discovered on the UCPath page. */
  employeeName: string;
}

function normalizeNameForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether the batch's target contact is already saved on this employee's
 * record. Used as a pre-flight duplicate guard in workflow.ts — if this returns
 * a non-null string, the workflow skips the record entirely (no ActionPlan
 * execution, no dashboard "failed" noise).
 */
export async function findExistingContactDuplicate(
  page: Page,
  targetName: string,
): Promise<string | null> {
  const existing = await readExistingContactNames(page);
  log.step(`Existing contacts on record: [${existing.join(" | ") || "none"}]`);
  const targetNorm = normalizeNameForCompare(targetName);
  const match = existing.find((n) => normalizeNameForCompare(n) === targetNorm);
  return match ?? null;
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
 *   7. Click Save.
 *
 * The duplicate-guard is NOT in this plan — call `findExistingContactDuplicate`
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
    await hidePeopleSoftModalMask(page);
    await page
      .getByRole("button", { name: /add a new row/i })
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(2_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  });

  // 2. Contact Name.
  plan.add(`Fill Contact Name: ${contact.name}`, async () => {
    await page
      .getByRole("textbox", { name: "Contact Name" })
      .first()
      .fill(contact.name, { timeout: 10_000 });
    await page.waitForTimeout(500);
  });

  // 3. Primary Contact checkbox.
  plan.add("Set Primary Contact", async () => {
    const cb = page.getByRole("checkbox", { name: "Primary Contact" }).first();
    if (contact.primary) {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (!checked) await cb.check({ timeout: 5_000 });
    } else {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (checked) await cb.uncheck({ timeout: 5_000 });
    }
    await page.waitForTimeout(500);
  });

  // 4. Relationship.
  const relationshipLabel = mapRelationship(contact.relationship);
  plan.add(
    `Select Relationship: "${contact.relationship}" -> "${relationshipLabel}"`,
    async () => {
      await page
        .getByRole("combobox", { name: "Relationship to Employee" })
        .first()
        .selectOption({ label: relationshipLabel }, { timeout: 10_000 });
      await page.waitForTimeout(1_500);
    },
  );

  // 5. Same Address as Employee + manual-address fallback.
  plan.add(
    contact.sameAddressAsEmployee
      ? 'Check "Same Address as Employee"'
      : 'Uncheck "Same Address as Employee" and enter manual address',
    async () => {
      const sameAddrCb = page
        .getByRole("checkbox", { name: "Same Address as Employee" })
        .first();
      const checked = await sameAddrCb.isChecked({ timeout: 5_000 }).catch(() => false);

      if (contact.sameAddressAsEmployee) {
        if (!checked) await sameAddrCb.check({ timeout: 5_000 });
        await page.waitForTimeout(1_500);
        return;
      }

      if (checked) await sameAddrCb.uncheck({ timeout: 5_000 });
      await page.waitForTimeout(1_500);

      if (!contact.address) {
        log.step("sameAddressAsEmployee=false but no address in YAML — leaving blank");
        return;
      }

      const addr = contact.address;
      await hidePeopleSoftModalMask(page);
      await page.getByRole("button", { name: "Edit Address" }).first()
        .click({ timeout: 10_000 });
      await page.waitForTimeout(2_000);

      await page.getByRole("textbox", { name: "Address 1" }).first()
        .fill(addr.street, { timeout: 10_000 });
      if (addr.city) {
        await page.getByRole("textbox", { name: "City" }).first()
          .fill(addr.city, { timeout: 10_000 });
      }
      if (addr.state) {
        await page.getByRole("textbox", { name: "State" }).first()
          .fill(addr.state, { timeout: 10_000 });
      }
      if (addr.zip) {
        await page.getByRole("textbox", { name: "Postal" }).first()
          .fill(addr.zip, { timeout: 10_000 });
      }

      await hidePeopleSoftModalMask(page);
      await page.getByRole("button", { name: "OK", exact: true }).first()
        .click({ timeout: 10_000 });
      await page.waitForTimeout(2_000);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    },
  );

  // 6. Phone.
  const primaryPhone = contact.cellPhone || contact.homePhone || contact.workPhone;
  if (primaryPhone) {
    plan.add(`Fill Phone: ${primaryPhone}`, async () => {
      await page
        .getByRole("textbox", { name: "Phone", exact: true })
        .first()
        .fill(primaryPhone, { timeout: 10_000 });
      await page.waitForTimeout(500);
    });
  } else {
    log.step("No phone number in record — skipping phone fill");
  }

  // 7. Save.
  plan.add("Click Save", async () => {
    await hidePeopleSoftModalMask(page);
    await page
      .getByRole("button", { name: "Save", exact: true })
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  });

  return plan;
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
    const personIdEl = page.getByText("Person ID").first();
    if ((await personIdEl.count().catch(() => 0)) === 0) return;
    const rowText = await personIdEl.locator("..").innerText({ timeout: 3_000 }).catch(() => "");
    const match = rowText.match(/Person ID\s+\d+\s+([A-Za-z][A-Za-z .'-]+?)\s+Emergency Contact/);
    if (match && match[1]) {
      ctx.employeeName = match[1].trim();
    }
  } catch {
    // Best-effort
  }
}

