import { log } from "../../utils/log.js";
import { defineWorkflow } from "../../core/index.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { TransactionError } from "../../systems/ucpath/types.js";
import {
  navigateToEmergencyContact,
  demoteExistingContact,
} from "../../systems/ucpath/personal-data.js";
import { dismissPeopleSoftModalMask } from "../../systems/common/modal.js";
import {
  buildEmergencyContactPlan,
  extractEmployeeName,
  findExistingContactDuplicate,
  type ContactMatch,
} from "./enter.js";
import type { EmergencyContactContext } from "./enter.js";
import { RecordSchema } from "./schema.js";
import type { EmergencyContactRecord } from "./schema.js";

const WORKFLOW = "emergency-contact";

const emergencyContactSteps = ["navigation", "fill-form", "save"] as const;

/**
 * Emergency Contact runtime policy.
 *
 * Emergency Contact PDF uploads mirror OCR prep behavior before approval:
 * file rows title by PDF filename, and approved contact/person rows fan
 * out as child-only delegation members titled by employee/contact data.
 */
export const EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  prepRow: {
    titleSource: "pdf-original-name",
  },
};

export function shouldDemoteExistingContactForRun(
  match: ContactMatch | null,
  dryRun: boolean | undefined,
): boolean {
  return Boolean(match && !match.isExact && !dryRun);
}

export function buildEmergencyContactPendingData(
  record: EmergencyContactRecord,
  batchName: string,
): Record<string, string> {
  return {
    batchName,
    sourcePage: String(record.sourcePage),
    emplId: record.employee.employeeId,
    employeeName: record.employee.name,
    contactName: record.emergencyContact.name,
    relationship: record.emergencyContact.relationship,
    ...(record.dryRun ? { dryRun: "true" } : {}),
  };
}

/**
 * Kernel definition for the emergency-contact batch workflow.
 *
 * Batch mode (`sequential`, `preEmitPending: true`): OCR approval prepares the
 * pending rows with rich display fields before records are claimed by daemons;
 * `withTrackedWorkflow` then reuses that runId and skips its duplicate pending
 * emit.
 *
 * `betweenItems: ["reset"]` resets UCPath to `about:blank` between
 * records so a stuck page from record N doesn't leak into record N+1's
 * `navigateToEmergencyContact`.
 */
export const emergencyContactWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Emergency Contact",
  archetype: "batch",
  inputSubject: "name",
  code: "ec",
  category: "Onboarding",
  iconName: "Phone",
  systems: [
    {
      id: "ucpath",
      // deferAuth: UCPath auth is deferred to the `navigation` step so a
      // fan-out contact child only Duos AFTER OCR approval, when it actually
      // reaches UCPath. Mirrors oath-signature's deferral: all three OCR fan-out
      // targets (oath-signature / oath-upload / emergency-contact) defer auth
      // so the operator is not prompted for Duo before reviewing the OCR results.
      deferAuth: true,
    },
  ],
  authSteps: false,
  steps: emergencyContactSteps,
  schema: RecordSchema,
  runtimePolicy: EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  // OCR approval populates these fields up front so the dashboard shows rich
  // rows from the pending state onward. The handler only refreshes employeeName
  // after the iframe extraction succeeds.
  detailFields: [
    { key: "employeeName", label: "Employee", editable: true },
    { key: "emplId", label: "Empl ID", editable: true },
    { key: "contactName", label: "Contact", editable: true },
    { key: "relationship", label: "Relationship", editable: true },
    { key: "contactPhone", label: "Contact Phone", editable: true },
    { key: "contactAddress", label: "Contact Address", editable: true },
  ],
  getName: (d) => d.employeeName ?? "",
  getId: (d) => d.emplId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "person",
      value: input.employee.name || input.employee.employeeId,
      prefix: "Emergency Contact",
    }),
  handler: async (ctx, record) => {
    const page = await ctx.page("ucpath");

    // Populate dashboard fields synchronously from the input so the kernel's
    // post-handler check stops warning about declared-but-unpopulated fields.
    // onPreEmitPending writes these to the *pending* row; this writes them
    // to subsequent running rows' data via the ctx merge.
    {
      const c = record.emergencyContact;
      const phoneSummary = c.cellPhone || c.homePhone || c.workPhone || "";
      const contactAddress = c.sameAddressAsEmployee
        ? "(same as employee)"
        : c.address
          ? [c.address.street, c.address.city, c.address.state, c.address.zip]
              .filter((s): s is string => Boolean(s))
              .join(", ")
          : "(none)";
      ctx.updateData({
        emplId: record.employee.employeeId,
        employeeName: record.employee.name,
        contactName: c.name,
        relationship: c.relationship,
        contactPhone: phoneSummary,
        contactAddress,
        ...(record.dryRun ? { dryRun: true } : {}),
      });
    }

    const skipped = await ctx.step("navigation", async () => {
      // Auth is deferred from session-launch to here so Duo fires AFTER OCR
      // approval, not before. `loginToUCPath` is idempotent: on a daemon only
      // the first item shows Duo; subsequent items reuse the warm session.
      const authOk = await loginToUCPath(page, ctx.workflowInstance, ctx.signal);
      if (!authOk) throw new Error("UCPath authentication failed");

      await navigateToEmergencyContact(page, record.employee.employeeId);

      const discoveredCtx: EmergencyContactContext = { employeeName: record.employee.name };
      await extractEmployeeName(page, discoveredCtx);
      if (discoveredCtx.employeeName) {
        ctx.updateData({ employeeName: discoveredCtx.employeeName });
      }

      // Duplicate guard (pre-plan). Returns ContactMatch | null:
      //   - null: no match within distance 2 → add normally.
      //   - isExact: existing record is already current → skip the plan.
      //   - fuzzy (distance 1-2): likely historical typo of the same person →
      //     demote the existing primary, then add new as primary.
      const existing = await findExistingContactDuplicate(page, record.emergencyContact.name);
      if (existing && existing.isExact) {
        ctx.updateData({
          skipped: "true",
          skipReason: `Contact "${existing.name}" already exists (exact match)`,
        });
        log.success(`Skipping — "${existing.name}" already present on this employee's record`);
        return true;
      }
      if (existing && !existing.isExact) {
        // Fuzzy match — demote the existing row and continue with normal add.
        if (shouldDemoteExistingContactForRun(existing, record.dryRun)) {
          log.step(
            `Fuzzy duplicate "${existing.name}" (distance ${existing.distance}) — demoting and adding new as primary.`,
          );
          await demoteExistingContact(page, existing.name);
          // After save+return, navigate back into the editor for this employee
          // so the subsequent fill-form step starts from the right place.
          await navigateToEmergencyContact(page, record.employee.employeeId);
        } else {
          log.step(
            `Dry run: would demote fuzzy duplicate "${existing.name}" (distance ${existing.distance}) before adding new primary contact.`,
          );
        }
        ctx.updateData({
          fuzzyDemote: record.dryRun ? "would-run" : "true",
          fuzzyDemoteName: existing.name,
        });
      }
      return false;
    });

    if (skipped) {
      ctx.skipStep("fill-form");
      ctx.skipStep("save");
      return;
    }

    await ctx.step("fill-form", async () => {
      const planCtx: EmergencyContactContext = { employeeName: record.employee.name };
      const plan = buildEmergencyContactPlan(record, page, planCtx);
      try {
        await plan.execute();
        if (record.dryRun) {
          await ctx.screenshot({ kind: "form", label: "emergency-contact-dry-run-pre-save" });
        }
      } catch (err) {
        if (err instanceof TransactionError) {
          throw new Error(
            `Transaction failed at step: ${err.step ?? "unknown"} — ${err.message}`,
            { cause: err },
          );
        }
        throw err;
      }
    });

    await ctx.step("save", async () => {
      if (record.dryRun) {
        ctx.updateData({ status: "Dry Run Complete" });
        log.success(`Dry run complete for ${record.employee.name} — UCPath Save was skipped.`);
        return;
      }
      await dismissPeopleSoftModalMask(page);
      await page
        .getByRole("button", { name: "Save", exact: true })
        .first()
        .click({ timeout: 10_000 });
      await page.waitForTimeout(3_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await ctx.screenshot({ kind: "form", label: "emergency-contact-saved" });
      log.success(`Saved emergency contact for ${record.employee.name}`);
    });
  },
});
