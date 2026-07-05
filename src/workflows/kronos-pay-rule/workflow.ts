import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToNewKronos } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { lookupEmployee } from "./csv-lookup.js";
import {
  determinePayRuleAction,
  payRuleElectionCode,
} from "./election-logic.js";
import { KronosPayRuleInputSchema, type KronosPayRuleInput } from "./schema.js";
import {
  searchEmployee,
  selectEmployeeResult,
} from "../../systems/new-kronos/index.js";
import {
  clickGoToPeople,
  verifyPeopleEmployee,
  resetNewKronosToHome,
  expandTimekeeperSection,
  addPayRule,
  savePersonRecord,
} from "../../systems/new-kronos/navigate.js";

const kronosPayRuleSteps = ["csv-lookup", "determine-action", "kronos-auth", "update-pay-rule"] as const;

/**
 * Effective date entered for every pay-rule change — the July 1 fiscal
 * rollover this OT-election campaign targets (campaign-invariant; see
 * CLAUDE.md "Decision logic"). Follows the root config's ANNUAL_DATES
 * convention: update when the workflow is reused for a future election cycle.
 */
const PAY_RULE_EFFECTIVE_DATE = "07/01/2026";

/**
 * Kronos Pay Rule Update workflow.
 *
 * Looks up an employee in the OT Elections Tracker CSV, determines the
 * required pay rule change (CT↔OT) based on union code and election status,
 * and performs the update in Kronos via the People → Timekeeper → Pay Rule UI.
 */
export const kronosPayRuleWorkflow = defineWorkflow({
  name: "kronos-pay-rule",
  label: "Kronos Paycodes",
  archetype: "single",
  inputSubject: "eid",
  code: "kp",
  category: "Payroll",
  iconName: "Clock",
  systems: [
    {
      id: "new-kronos",
      login: requireLogin(loginToNewKronos, "New Kronos authentication failed"),
    },
  ],
  authSteps: false,
  steps: kronosPayRuleSteps,
  schema: KronosPayRuleInputSchema,
  runtimePolicy: DEFAULT_WORKFLOW_RUNTIME_POLICY,
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "Empl ID" },
    { key: "unionCode", label: "Union Code" },
    { key: "currentPayRule", label: "Current Pay Rule" },
    { key: "newPayRule", label: "New Pay Rule" },
    { key: "oldCode", label: "Old Code" },
    { key: "newCode", label: "New Code" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "eid", value: input.emplId }),
  handler: async (ctx, input) => {
    ctx.updateData({ emplId: input.emplId });

    // Step 1: CSV lookup — find employee and determine the required action.
    // The step returns the action so it stays a definitely-assigned `const`
    // (no non-null assertion needed downstream).
    const action = await ctx.step("csv-lookup", async () => {
      const employee = lookupEmployee(input.emplId);
      if (!employee) {
        throw new Error(`Employee ${input.emplId} not found in OT Elections Tracker CSV`);
      }
      ctx.updateData({
        name: employee.employeeName,
        unionCode: employee.unionCode,
        currentPayRule: employee.payRuleInUKG,
        oldCode: payRuleElectionCode(employee.payRuleInUKG) ?? "—",
        newCode: "—",
      });
      log.step(
        `[Kronos Pay Rule] Found ${employee.employeeName} (${employee.employeeId}) — ` +
        `Union: ${employee.unionCode}, Pay Rule: ${employee.payRuleInUKG}, ` +
        `Current Election: ${employee.currentElection}, ` +
        `New Election: ${employee.newElection || "(blank)"}`,
      );

      return determinePayRuleAction(employee);
    });

    // Step 2: Log the determined action.
    await ctx.step("determine-action", async () => {
      if (action.action === "skip") {
        ctx.updateData({
          status: `Skipped: ${action.reason}`,
          newPayRule: "—",
          newCode: "—",
        });
        log.step(`[Kronos Pay Rule] Skipping: ${action.reason}`);
        return;
      }
      const change = action;
      ctx.updateData({
        newPayRule: change.newPayRule,
        oldCode: change.oldCode,
        newCode: change.newCode,
      });
      log.step(
        `[Kronos Pay Rule] Action: ${change.currentPayRule} → ${change.newPayRule} (${change.reason})`,
      );
    });

    // If skip, we're done. The skip guard narrows `action` to the change variant.
    if (action.action === "skip") return;
    const changeAction = action;

    // Step 3: Kronos auth — session already kicked off login; announce for dashboard.
    ctx.markStep("kronos-auth");
    await ctx.page("new-kronos");

    // Step 4: Update pay rule in Kronos UI.
    await ctx.step("update-pay-rule", async () => {
      const page = await ctx.page("new-kronos");

      // Return to the home dashboard first. In a batch the previous employee's
      // People editor is still open, and once it is, Go To → People no longer
      // offers a "People" option — so every item must start fresh to reliably
      // switch employees (live-verified 2026-07-02).
      await resetNewKronosToHome(page);

      // Search for employee
      const found = await searchEmployee(page, input.emplId);
      if (!found) {
        throw new Error(`Employee ${input.emplId} not found in Kronos`);
      }

      // Select and navigate to People page
      const selected = await selectEmployeeResult(page);
      if (!selected) {
        throw new Error(
          `[Kronos Pay Rule] Could not select employee ${input.emplId} in search results`,
        );
      }
      const openedPeople = await clickGoToPeople(page, input.emplId);
      if (!openedPeople) {
        throw new Error(
          `[Kronos Pay Rule] Could not open People page for employee ${input.emplId}`,
        );
      }

      // Fail-loud identity gate: in a batch the previous employee's People
      // editor stays open, so confirm THIS employee is actually displayed before
      // touching any pay rule — never edit the wrong person's payroll record.
      const idCheck = await verifyPeopleEmployee(page, input.emplId);
      if (!idCheck.ok) {
        throw new Error(
          `[Kronos Pay Rule] People editor is showing ${idCheck.shownEid ?? "an unknown employee"}, ` +
          `not ${input.emplId} — aborting before add/save to avoid editing the wrong person`,
        );
      }

      // Expand Timekeeper and add the new pay rule
      await expandTimekeeperSection(page);
      await addPayRule(page, changeAction.newPayRule, PAY_RULE_EFFECTIVE_DATE);

      // Audit screenshot before save
      await debugScreenshot(page, "kronos-pay-rule-before-save");

      // Save the record
      await savePersonRecord(page);

      // Post-save screenshot
      await debugScreenshot(page, "kronos-pay-rule-after-save");

      ctx.updateData({ status: "Updated" });
      log.success(
        `[Kronos Pay Rule] Updated ${input.emplId}: ` +
        `${changeAction.currentPayRule} → ${changeAction.newPayRule}`,
      );
    });
  },
});

/** Internal adapter — real runs delegate to the kernel. */
export async function runKronosPayRule(input: KronosPayRuleInput): Promise<void> {
  try {
    await runWorkflow(kronosPayRuleWorkflow, input);
    log.success("Kronos pay rule update completed successfully");
  } catch (err) {
    log.error(`Kronos pay rule update failed: ${errorMessage(err)}`);
    throw err;
  }
}
