import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "../../systems/crm/index.js";
import { TransactionError } from "../../systems/ucpath/types.js";
import { searchPerson } from "../../systems/ucpath/navigate.js";
import { loginToI9, createI9Employee, searchI9Employee } from "../../systems/i9/index.js";
import { extractRawFields, extractRecordPageFields } from "./extract.js";
import { validateEmployeeData } from "./schema.js";
import type { EmployeeData } from "./schema.js";
import { buildTransactionPlan } from "./enter.js";
import { buildDownloadPath, downloadCrmDocuments } from "./download.js";
import { retryStep, RetryStepError } from "./retry.js";
import { runOnboardingLegacy } from "./workflow-legacy.js";
import { z } from "zod/v4";

export interface OnboardingOptions {
  dryRun?: boolean;
  /** Pre-launched CRM page (for parallel worker reuse). If supplied, routes to legacy. */
  crmPage?: Page;
  /** Pre-launched UCPath page (for parallel worker reuse). If supplied, routes to legacy. */
  ucpathPage?: Page;
  /** Pre-launched I9 page (for parallel worker reuse). If supplied, routes to legacy. */
  i9Page?: Page;
  /** Log prefix for worker identification, e.g. "[Worker 1]". */
  logPrefix?: string;
}

/** Input schema for the onboarding kernel workflow. `email` is the only CLI-supplied field. */
const OnboardingInputSchema = z.object({
  email: z.string().email(),
});
type OnboardingInput = z.infer<typeof OnboardingInputSchema>;

/** Mask SSN for dashboard display. */
function maskSsn(ssn: string | undefined | null): string {
  if (!ssn) return "";
  const digits = ssn.replace(/-/g, "");
  if (digits.length < 4) return "***";
  return `***-**-${digits.slice(-4)}`;
}

const onboardingSteps = [
  "crm-auth",
  "extraction",
  "pdf-download",
  "ucpath-auth",
  "person-search",
  "i9-creation",
  "transaction",
] as const;

/**
 * Kernel definition for single-mode onboarding.
 *
 * Exports a RegisteredWorkflow. Run it via `runWorkflow(onboardingWorkflow, { email })`
 * or the CLI adapter `runOnboarding` (which handles dry-run and routes to legacy when
 * pre-supplied pages are passed by parallel.ts).
 */
export const onboardingWorkflow = defineWorkflow({
  name: "onboarding",
  label: "Onboarding",
  systems: [
    {
      id: "crm",
      login: async (page, instance) => {
        const ok = await loginToACTCrm(page, instance);
        if (!ok) throw new Error("ACT CRM authentication failed");
      },
    },
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
    {
      id: "i9",
      login: async (page) => {
        const ok = await loginToI9(page);
        if (!ok) throw new Error("I-9 Complete authentication failed");
      },
    },
  ],
  steps: onboardingSteps,
  schema: OnboardingInputSchema,
  authChain: "sequential",
  // Matches pre-subsystem-D WF_CONFIG["onboarding"].detailFields. Dept/Position/
  // Wage/I9-profile are populated after extraction; email is populated from the
  // CLI input / schema. firstName+lastName drive getName so the dashboard shows
  // "Jane Doe" instead of the raw email.
  detailFields: [
    { key: "email", label: "Email" },
    { key: "departmentNumber", label: "Dept #" },
    { key: "positionNumber", label: "Position #" },
    { key: "wage", label: "Wage" },
    { key: "effectiveDate", label: "Eff Date" },
    { key: "i9ProfileId", label: "I9 Profile" },
  ],
  getName: (d) => [d.firstName, d.lastName].filter(Boolean).join(" "),
  getId: (d) => d.email ?? "",
  handler: async (ctx, input) => {
    const email = input.email;
    let data: EmployeeData | null = null;

    // --- Phase 1: CRM auth + record lookup + extraction ---

    await ctx.step("crm-auth", async () => {
      await ctx.page("crm");
    });

    const crmPage = await ctx.page("crm");

    await retryStep(
      "CRM search",
      async () => {
        log.step(`Searching for ${email}...`);
        await searchByEmail(crmPage, email);
      },
      { attempts: 3 },
    );

    await retryStep(
      "CRM select latest result",
      () => selectLatestResult(crmPage),
      { attempts: 3 },
    );

    const recordFields = await retryStep(
      "CRM record-page extraction",
      () => extractRecordPageFields(crmPage),
      { attempts: 2 },
    );
    if (recordFields.departmentNumber) ctx.updateData({ departmentNumber: recordFields.departmentNumber });
    if (recordFields.recruitmentNumber) ctx.updateData({ recruitmentNumber: recordFields.recruitmentNumber });

    await retryStep(
      "Navigate to UCPath Entry Sheet",
      () => navigateToSection(crmPage, "UCPath Entry Sheet"),
      { attempts: 2 },
    );

    await ctx.step("extraction", async () => {
      const rawData = await retryStep(
        "Extract employee data",
        () => extractRawFields(crmPage),
        { attempts: 2 },
      );
      try {
        data = validateEmployeeData(rawData);
      } catch (e) {
        throw new ExtractionError(`Schema validation failed: ${errorMessage(e)}`);
      }
      if (recordFields.departmentNumber) data = { ...data, departmentNumber: recordFields.departmentNumber };
      if (recordFields.recruitmentNumber) data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };

      ctx.updateData({
        firstName: data.firstName,
        lastName: data.lastName,
        middleName: data.middleName ?? "",
        email: data.email ?? email,
        phone: data.phone ?? "",
        dob: data.dob ?? "",
        ssn: maskSsn(data.ssn),
        address: data.address,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        departmentNumber: data.departmentNumber ?? "",
        recruitmentNumber: data.recruitmentNumber ?? "",
        positionNumber: data.positionNumber,
        wage: data.wage,
        effectiveDate: data.effectiveDate,
        appointment: data.appointment ?? "",
      });
      log.success("Employee data extracted and validated");
    });

    // --- Phase 2: PDF download (non-fatal) ---

    await ctx.step("pdf-download", async () => {
      if (!data) throw new Error("extraction did not produce data");
      const folderPath = buildDownloadPath(data.firstName, data.lastName, data.middleName);
      try {
        await retryStep(
          "Navigate to CRM record page for PDF viewer",
          async () => {
            await crmPage.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
          },
          { attempts: 2 },
        );
        const saved = await retryStep(
          "Download CRM PDFs",
          () => downloadCrmDocuments(crmPage, folderPath, {}),
          { attempts: 2, backoffMs: 2_000 },
        );
        ctx.updateData({
          pdfDownload: `${saved.length} file(s)`,
          pdfFolder: folderPath,
        });
      } catch (err) {
        const msg = errorMessage(err);
        log.error(`PDF download failed (continuing without PDFs): ${msg}`);
        ctx.updateData({ pdfDownload: `Failed: ${msg.slice(0, 80)}` });
      }
    });

    // --- Phase 3: UCPath auth + person search (rehire short-circuit) ---

    await ctx.step("ucpath-auth", async () => {
      await ctx.page("ucpath");
    });

    const ucpathPage = await ctx.page("ucpath");

    const searchResult = await ctx.step("person-search", async () => {
      if (!data) throw new Error("extraction did not produce data");
      const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
      return retryStep(
        "UCPath person search",
        () => searchPerson(ucpathPage, ssnDigits, data!.firstName, data!.lastName, data!.dob ?? ""),
        { attempts: 2 },
      );
    });

    if (searchResult.found) {
      log.error("Person already exists in UCPath — marking as rehire");
      if (searchResult.matches) {
        for (const m of searchResult.matches) {
          log.step(`  Empl ID: ${m.emplId}, Name: ${m.firstName} ${m.lastName}`);
        }
      }
      const emplIds = searchResult.matches?.map((m) => m.emplId).join(", ") ?? "";
      ctx.updateData({
        rehire: "Yes",
        existingEmplIds: emplIds,
        i9ProfileId: "N/A",
        status: "Rehire",
      });
      // Early return — rehire short-circuits before I-9 creation and transaction.
      return;
    }

    log.success("No duplicate found — proceeding with I-9 creation");
    ctx.updateData({ rehire: "No" });

    // --- Phase 4: I-9 search (existing) or creation (new) ---

    const i9ProfileId = await ctx.step("i9-creation", async () => {
      if (!data) throw new Error("extraction did not produce data");
      if (!data.ssn) throw new Error("Cannot create I-9 without SSN");
      if (!data.dob) throw new Error("Cannot create I-9 without DOB");
      if (!data.departmentNumber) throw new Error("Cannot create I-9 without department number");

      const i9Page = await ctx.page("i9");

      // Search for existing profile first — avoids duplicate creation on re-runs.
      const ssnWithDashes = data.ssn!.replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3");
      const searchResults = await retryStep(
        "I-9 profile search",
        () => searchI9Employee(i9Page, { ssn: ssnWithDashes }),
        { attempts: 2 },
      );

      if (searchResults.length > 0 && searchResults[0].profileId) {
        const pid = searchResults[0].profileId;
        log.success(`Existing I-9 profile found: ${pid} — skipping creation`);
        ctx.updateData({ i9ProfileId: pid, i9SearchOnly: "true" });
        // Close search dialog
        await i9Page.keyboard.press("Escape");
        return pid;
      }

      log.step("No existing I-9 profile — creating new one");
      // Close search dialog before navigating to create flow
      await i9Page.keyboard.press("Escape");
      await i9Page.waitForTimeout(500);

      const i9Result = await retryStep(
        "I-9 record creation",
        async () => {
          const result = await createI9Employee(i9Page, {
            firstName: data!.firstName,
            middleName: data!.middleName,
            lastName: data!.lastName,
            ssn: data!.ssn!,
            dob: data!.dob!,
            email: data!.email ?? email,
            departmentNumber: data!.departmentNumber!,
            startDate: data!.effectiveDate,
          });
          if (!result.success || !result.profileId) {
            throw new Error(result.error ?? "I-9 creation returned no profile ID");
          }
          return result;
        },
        { attempts: 2, backoffMs: 3_000 },
      );
      const pid = i9Result.profileId!;
      log.success(`I-9 profile created: ${pid}`);
      ctx.updateData({ i9ProfileId: pid });
      return pid;
    });

    // --- Phase 5: UCPath Smart HR Transaction ---

    await ctx.step("transaction", async () => {
      if (!data) throw new Error("extraction did not produce data");
      try {
        const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
        log.step("Executing Smart HR transaction plan...");
        await plan.execute();
        log.success("Transaction created successfully in UCPath");
        ctx.updateData({ status: "Done" });
      } catch (error) {
        const errMsg = error instanceof TransactionError
          ? `Transaction failed at step "${error.step ?? "unknown"}": ${error.message}`
          : error instanceof RetryStepError
            ? error.message
            : `Transaction failed: ${errorMessage(error)}`;
        ctx.updateData({ status: "Failed", transactionError: errMsg });
        throw new Error(errMsg);
      }
    });
  },
});

/**
 * CLI adapter for `npm run start-onboarding <email>`.
 *
 * Routing:
 * - If pre-supplied pages are present (parallel worker context) → legacy path (workflow-legacy.ts).
 * - If `dryRun` → imperative CRM-only preview (see runOnboardingDryRun below).
 * - Otherwise → kernel via `runWorkflow(onboardingWorkflow, { email })`.
 */
export async function runOnboarding(
  email: string,
  options: OnboardingOptions = {},
): Promise<void> {
  // Parallel workers supply pre-launched pages — route to legacy until parallel migrates.
  if (options.crmPage || options.ucpathPage || options.i9Page) {
    return runOnboardingLegacy(email, options);
  }

  if (options.dryRun) {
    return runOnboardingDryRun(email);
  }

  await runWorkflow(onboardingWorkflow, { email });
  log.success("Onboarding transaction completed successfully");
}

/**
 * Single-browser imperative dry-run: CRM auth + extraction + plan preview, no UCPath/I9.
 *
 * Mirrors the old dryRun short-circuit semantics without launching unnecessary browsers.
 */
async function runOnboardingDryRun(email: string): Promise<void> {
  log.step("=== DRY RUN MODE ===");
  const { page: crmPage } = await launchBrowser();
  try {
    await retryStep(
      "CRM authentication",
      async () => {
        const ok = await loginToACTCrm(crmPage);
        if (!ok) throw new Error("loginToACTCrm returned false");
      },
      { attempts: 2, backoffMs: 3_000 },
    );

    await retryStep(
      "CRM search",
      async () => {
        log.step(`Searching for ${email}...`);
        await searchByEmail(crmPage, email);
      },
      { attempts: 3 },
    );
    await retryStep("CRM select latest result", () => selectLatestResult(crmPage), { attempts: 3 });
    const recordFields = await retryStep("CRM record-page extraction", () => extractRecordPageFields(crmPage), { attempts: 2 });
    await retryStep("Navigate to UCPath Entry Sheet", () => navigateToSection(crmPage, "UCPath Entry Sheet"), { attempts: 2 });

    const rawData = await retryStep("Extract employee data", () => extractRawFields(crmPage), { attempts: 2 });
    let data: EmployeeData;
    try {
      data = validateEmployeeData(rawData);
    } catch (e) {
      throw new ExtractionError(`Schema validation failed: ${errorMessage(e)}`);
    }
    if (recordFields.departmentNumber) data = { ...data, departmentNumber: recordFields.departmentNumber };
    if (recordFields.recruitmentNumber) data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };

    const plan = buildTransactionPlan(data, null as unknown as Page, "DRY_RUN");
    plan.preview();
    log.success("Dry run complete — no changes made to UCPath or I9");
  } catch (err) {
    log.error(`Dry run failed: ${errorMessage(err)}`);
    throw err;
  }
}

export { runOnboardingLegacy };
