import type { Page } from "playwright";
import { ActionPlan } from "../../ucpath/action-plan.js";
import {
  navigateToSmartHR,
  getContentFrame,
} from "../../ucpath/navigate.js";
import {
  selectTemplate,
  enterEffectiveDate,
  clickCreateTransaction,
} from "../../ucpath/transaction.js";
import type { EmployeeData } from "./schema.js";

/**
 * Build an ActionPlan for creating a UC_FULL_HIRE transaction in UCPath.
 *
 * Composes navigation, template selection, date entry, and transaction creation
 * into a reviewable, executable plan.
 *
 * @param data - Validated employee data from ACT CRM extraction
 * @param page - Playwright page instance (authenticated to UCPath)
 * @returns ActionPlan ready for preview() or execute()
 */
export function buildTransactionPlan(
  data: EmployeeData,
  page: Page,
): ActionPlan {
  const plan = new ActionPlan();

  plan.add(
    "Navigate to Smart HR Transactions",
    () => navigateToSmartHR(page),
  );

  plan.add(
    "Select template UC_FULL_HIRE",
    () => selectTemplate(getContentFrame(page), "UC_FULL_HIRE"),
  );

  plan.add(
    `Enter effective date: ${data.effectiveDate}`,
    () => enterEffectiveDate(getContentFrame(page), data.effectiveDate),
  );

  plan.add(
    "Click Create Transaction",
    async () => {
      const result = await clickCreateTransaction(getContentFrame(page));
      if (!result.success) {
        throw new Error(result.error ?? "Transaction creation failed");
      }
    },
  );

  return plan;
}
