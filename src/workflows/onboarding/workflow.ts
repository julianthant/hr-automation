import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import {
  defineWorkflow,
  runWorkflow,
  hashKey,
  hasRecentlySucceeded,
  recordSuccess,
  findRecentTransactionId,
  stepCacheGet,
  stepCacheSet,
} from "../../core/index.js";
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
import { TEMPLATE_ID } from "./config.js";
import { buildDownloadPath, downloadCrmDocuments } from "./download.js";
import { retryStep } from "./retry.js";
import { z } from "zod/v4";

export interface OnboardingOptions {
  dryRun?: boolean;
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
      // I9 has no Duo MFA so `instance` isn't used — accept it to keep the
      // closure signature uniform with the other kernel-invoked logins.
      login: async (page, _instance) => {
        const ok = await loginToI9(page);
        if (!ok) throw new Error("I-9 Complete authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: onboardingSteps,
  schema: OnboardingInputSchema,
  authChain: "sequential",
  // Pool mode: each worker gets its own Session with 3 browsers (CRM + UCPath +
  // I9), 2 Duos per worker (I9 SSO has no 2FA). Pool size 4 matches the legacy
  // default; overridable at runtime via `RunOpts.poolSize` from the `--workers N`
  // CLI flag. `preEmitPending: true` lets `runParallel` / `runOnboardingPositional`
  // emit the full email queue to the dashboard before any worker's auth finishes.
  batch: { mode: "pool", poolSize: 4, preEmitPending: true },
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
      const t0 = Date.now();
      log.debug(`[Step: crm-auth] START email='${email}'`);
      await ctx.page("crm");
      log.step(`[Step: crm-auth] END took=${Date.now() - t0}ms`);
    });

    const crmPage = await ctx.page("crm");

    await ctx.retry(
      async () => {
        log.step(`Searching for ${email}...`);
        await searchByEmail(crmPage, email);
      },
      { attempts: 3 },
    );

    await ctx.retry(
      () => selectLatestResult(crmPage),
      { attempts: 3 },
    );

    const recordFields = await ctx.retry(
      () => extractRecordPageFields(crmPage),
      { attempts: 2 },
    );
    if (recordFields.departmentNumber) ctx.updateData({ departmentNumber: recordFields.departmentNumber });
    if (recordFields.recruitmentNumber) ctx.updateData({ recruitmentNumber: recordFields.recruitmentNumber });

    await ctx.retry(
      () => navigateToSection(crmPage, "UCPath Entry Sheet"),
      { attempts: 2 },
    );

    const buildDetailFieldsPayload = (d: EmployeeData) => ({
      firstName: d.firstName,
      lastName: d.lastName,
      middleName: d.middleName ?? "",
      email: d.email ?? email,
      phone: d.phone ?? "",
      dob: d.dob ?? "",
      ssn: maskSsn(d.ssn),
      address: d.address,
      city: d.city,
      state: d.state,
      postalCode: d.postalCode,
      departmentNumber: d.departmentNumber ?? "",
      recruitmentNumber: d.recruitmentNumber ?? "",
      positionNumber: d.positionNumber,
      wage: d.wage,
      effectiveDate: d.effectiveDate,
      appointment: d.appointment ?? "",
    });

    await ctx.step("extraction", async () => {
      const t0 = Date.now();
      log.debug(`[Step: extraction] START email='${email}'`);
      let cacheHit = false;
      try {
        // Cache-hit branch — skip CRM re-scrape if a recent extraction exists
        // for this email. Pre-step nav (searchByEmail, selectLatestResult,
        // extractRecordPageFields, navigateToSection) has still run, so we
        // re-apply recordFields's dept + recruitment numbers on top of cache.
        const cached = stepCacheGet<EmployeeData>(
          "onboarding",
          email,
          "extraction",
          { withinHours: 2 },
        );
        if (cached) {
          cacheHit = true;
          log.warn("Using cached extraction data (≤2 h old) — skipping CRM re-scrape");
          data = cached;
          if (recordFields.departmentNumber) data = { ...data, departmentNumber: recordFields.departmentNumber };
          if (recordFields.recruitmentNumber) data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };
          ctx.updateData(buildDetailFieldsPayload(data));
          return;
        }

        // Cache-miss branch — normal extraction from CRM.
        const rawData = await ctx.retry(
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

        ctx.updateData(buildDetailFieldsPayload(data));

        // Cache write is best-effort: a disk-full / permission error must NOT
        // fail the step — the underlying extraction already succeeded. Log-warn
        // and move on; next rerun will re-scrape, which is correct behavior.
        try {
          stepCacheSet("onboarding", email, "extraction", data);
        } catch (e) {
          log.warn(`Step cache write failed (continuing): ${errorMessage(e)}`);
        }

        log.success("Employee data extracted and validated");
      } finally {
        log.step(
          `[Step: extraction] END took=${Date.now() - t0}ms `
          + `cacheHit=${cacheHit} `
          + `departmentNumber='${data?.departmentNumber || "<none>"}' `
          + `positionNumber='${data?.positionNumber || "<none>"}' `
          + `name='${data?.firstName ?? ""} ${data?.lastName ?? ""}'`,
        );
      }
    });

    // --- Phase 2: PDF download (non-fatal) ---

    await ctx.step("pdf-download", async () => {
      const t0 = Date.now();
      log.debug(`[Step: pdf-download] START`);
      if (!data) throw new Error("extraction did not produce data");
      const folderPath = buildDownloadPath(data.firstName, data.lastName, data.middleName);
      let fileCount = 0;
      let downloadErr = "";
      try {
        await ctx.retry(
          async () => {
            await crmPage.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
          },
          { attempts: 2 },
        );
        const saved = await ctx.retry(
          () => downloadCrmDocuments(crmPage, folderPath, {}),
          { attempts: 2, backoffMs: 2_000 },
        );
        fileCount = saved.length;
        ctx.updateData({
          pdfDownload: `${saved.length} file(s)`,
          pdfFolder: folderPath,
        });
      } catch (err) {
        downloadErr = errorMessage(err);
        log.error(`PDF download failed (continuing without PDFs): ${downloadErr}`);
        ctx.updateData({ pdfDownload: `Failed: ${downloadErr.slice(0, 80)}` });
      }
      log.step(
        `[Step: pdf-download] END took=${Date.now() - t0}ms `
        + `fileCount=${fileCount} error='${downloadErr || "<empty>"}'`,
      );
    });

    // --- Phase 3: UCPath auth + person search (rehire short-circuit) ---

    await ctx.step("ucpath-auth", async () => {
      const t0 = Date.now();
      log.debug(`[Step: ucpath-auth] START`);
      await ctx.page("ucpath");
      log.step(`[Step: ucpath-auth] END took=${Date.now() - t0}ms`);
    });

    const ucpathPage = await ctx.page("ucpath");

    const searchResult = await ctx.step("person-search", async () => {
      const t0 = Date.now();
      if (!data) throw new Error("extraction did not produce data");
      const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
      const ssnLast4 = ssnDigits.slice(-4) || "<empty>";
      log.debug(
        `[Step: person-search] START ssnLast4='${ssnLast4}' `
        + `dob='${data.dob ?? "<none>"}' `
        + `name='${data.firstName} ${data.lastName}'`,
      );
      const result = await ctx.retry(
        () => searchPerson(ucpathPage, ssnDigits, data!.firstName, data!.lastName, data!.dob ?? ""),
        { attempts: 2 },
      );
      const matchCount = result.matches?.length ?? 0;
      const firstEmplId = result.matches?.[0]?.emplId ?? "";
      const resultLabel = result.found ? (matchCount > 1 ? "duplicate" : "rehire") : "new-hire";
      log.step(
        `[Step: person-search] END took=${Date.now() - t0}ms `
        + `result='${resultLabel}' matchCount=${matchCount} `
        + `emplId='${firstEmplId || "<empty>"}'`,
      );
      return result;
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
      const t0 = Date.now();
      let resultPid = "";
      let mode: "existing" | "created" | "pending" = "pending";
      try {
        if (!data) throw new Error("extraction did not produce data");
        if (!data.ssn) throw new Error("Cannot create I-9 without SSN");
        if (!data.dob) throw new Error("Cannot create I-9 without DOB");
        if (!data.departmentNumber) throw new Error("Cannot create I-9 without department number");

        log.debug(
          `[Step: i9-creation] START ssnLast4='${data.ssn.replace(/-/g, "").slice(-4)}' `
          + `dept='${data.departmentNumber}'`,
        );

        const i9Page = await ctx.page("i9");

        // Search for existing profile first — avoids duplicate creation on re-runs.
        const ssnWithDashes = data.ssn!.replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3");
        const searchResults = await ctx.retry(
          () => searchI9Employee(i9Page, { ssn: ssnWithDashes }),
          { attempts: 2 },
        );

        if (searchResults.length > 0 && searchResults[0].profileId) {
          const pid = searchResults[0].profileId;
          log.success(`Existing I-9 profile found: ${pid} — skipping creation`);
          ctx.updateData({ i9ProfileId: pid, i9SearchOnly: "true" });
          // Close search dialog
          await i9Page.keyboard.press("Escape");
          resultPid = pid;
          mode = "existing";
          return pid;
        }

        log.step("No existing I-9 profile — creating new one");
        // Close search dialog before navigating to create flow
        await i9Page.keyboard.press("Escape");
        await i9Page.waitForTimeout(500);

        const i9Result = await ctx.retry(
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
        resultPid = pid;
        mode = "created";
        return pid;
      } finally {
        log.step(
          `[Step: i9-creation] END took=${Date.now() - t0}ms `
          + `mode='${mode}' profileId='${resultPid || "<empty>"}'`,
        );
      }
    });

    // --- Phase 5: UCPath Smart HR Transaction ---

    await ctx.step("transaction", async () => {
      const t0 = Date.now();
      let txnExit = "<empty>";
      let failedAtStep: string | null = null;
      try {
        if (!data) throw new Error("extraction did not produce data");

        log.debug(
          `[Step: transaction] START template='${TEMPLATE_ID}' `
          + `effectiveDate='${data.effectiveDate}'`,
        );

        // Idempotency: key on (workflow, emplId-or-NEW, ssn, effectiveDate). For
        // a fresh hire, emplId doesn't exist yet so we use "NEW"; the SSN +
        // effectiveDate combination still uniquely identifies the intended txn.
        const idempKey = hashKey({
          workflow: "onboarding",
          emplId: searchResult.matches?.[0]?.emplId ?? "NEW",
          ssn: data.ssn ?? "",
          effectiveDate: data.effectiveDate,
        });
        if (hasRecentlySucceeded(idempKey)) {
          const existingTxId = findRecentTransactionId(idempKey);
          const note = existingTxId
            ? `transaction already submitted recently (txId ${existingTxId}) — skipping (idempotency)`
            : "transaction already submitted recently — skipping (idempotency)";
          log.warn(note);
          ctx.updateData({
            status: "Skipped (Duplicate)",
            idempotencySkip: "true",
            ...(existingTxId ? { transactionId: existingTxId } : {}),
          });
          txnExit = existingTxId ? `<skipped:${existingTxId}>` : "<skipped>";
          return;
        }

        try {
          const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
          log.step("Executing Smart HR transaction plan...");
          await plan.execute();
          log.success("Transaction created successfully in UCPath");
          // transactionId isn't surfaced by ActionPlan today — record empty string;
          // the key match is what prevents duplicates on re-run.
          recordSuccess(idempKey, "", "onboarding");
          ctx.updateData({ status: "Done" });
          // ActionPlan doesn't surface the txn number; leave as "<empty>" sentinel.
        } catch (error) {
          // `ctx.retry` rethrows the underlying error verbatim on exhaustion, so the
          // old `RetryStepError` branch no longer fires on kernel-handler callsites.
          // TransactionError still carries a useful step name; everything else
          // falls through to `errorMessage()`.
          const classified = classifyPlaywrightError(error);
          log.error(`[Transaction] ${classified.kind}: ${classified.summary}`);
          log.debug(`[Transaction] full error: ${errorMessage(error)}`);
          failedAtStep = error instanceof TransactionError
            ? (error.step ?? "unknown")
            : classified.kind;
          const errMsg = error instanceof TransactionError
            ? `Transaction failed at step "${error.step ?? "unknown"}": ${error.message}`
            : `Transaction failed: ${errorMessage(error)}`;
          ctx.updateData({ status: "Failed", transactionError: errMsg });
          throw new Error(errMsg);
        }
      } finally {
        const exitStr = failedAtStep ? `<failed at step: ${failedAtStep}>` : txnExit;
        log.step(
          `[Step: transaction] END took=${Date.now() - t0}ms `
          + `txnNumber='${exitStr}'`,
        );
      }
    });
  },
});

/**
 * CLI adapter for `npm run onboarding <email>` (single-email path).
 *
 * Routing:
 * - If `dryRun` → imperative CRM-only preview (see `runOnboardingDryRun` below).
 * - Otherwise → kernel via `runWorkflow(onboardingWorkflow, { email })`.
 *
 * Pool-mode variants live in sibling files:
 * - `./positional.ts` (`runOnboardingPositional`) — positional CLI emails.
 * - `./parallel.ts` (`runParallel`) — reads `batch.yaml`.
 *
 * Both delegate straight to `runWorkflowBatch(onboardingWorkflow, ...)` —
 * no adapter indirection through this function.
 */
export async function runOnboarding(
  email: string,
  options: OnboardingOptions = {},
): Promise<void> {
  if (options.dryRun) {
    return runOnboardingDryRun(email);
  }

  await runWorkflow(onboardingWorkflow, { email });
  log.success("Onboarding transaction completed successfully");
}

/**
 * Daemon-mode CLI adapter for `npm run onboarding <email...>`.
 *
 * Enqueues one `{email}` item per CLI argument onto any alive `onboarding`
 * daemon (or spawns one via `ensureDaemonsAndEnqueue`). Daemons keep
 * CRM + UCPath browsers warm across invocations so repeat onboards don't
 * re-Duo every time — CRM's Duo alone costs ~30-60s per run, so this is
 * the biggest wall-clock savings of any converted workflow.
 *
 * Onboarding's `defineWorkflow` already declares `batch: { mode: "pool" }`,
 * which is how `runWorkflowBatch` → `runWorkflowPool` (legacy `--direct`
 * path + `--batch` flag) fans a batch across N workers. Daemon mode is
 * orthogonal: each alive daemon is one long-lived single-worker Session
 * claiming items off the shared queue. For throughput, start N daemons
 * with `-p N` — the shared `fs.mkdir` claim mutex distributes items across
 * them identically to pool workers, with the added benefit that the
 * daemons survive the batch.
 *
 * Constraints:
 *   - `--dry-run` still bypasses daemon mode entirely (CRM-only preview,
 *     no spawn, no enqueue).
 *   - `--batch` (reads batch.yaml) routes through `runParallel` / `--direct`
 *     because the daemon adapter takes emails positionally. If you want
 *     daemon-mode batch processing, pass the emails explicitly on the
 *     CLI — `npm run onboarding a@uc b@uc c@uc` fans across alive daemons
 *     via the shared queue.
 */
export async function runOnboardingCli(
  emails: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (emails.length === 0) {
    log.error("runOnboardingCli: no emails provided");
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    // Daemon can't share a single CRM browser across N dry-run previews
    // without launching the full session — fall back to the sequential
    // imperative dry-run that `runOnboarding` already owns.
    for (const email of emails) {
      await runOnboardingDryRun(email);
    }
    return;
  }

  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const inputs = emails.map((email) => ({ email }));
  await ensureDaemonsAndEnqueue(onboardingWorkflow, inputs, {
    new: options.new,
    parallel: options.parallel,
  });
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
