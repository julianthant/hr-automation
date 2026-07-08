import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { isUcpathEmployeeId } from "../../domain/identity/eid.js";
import { classifyNameSimilarity } from "../../services/matching/match.js";
import {
  buildIdentityApprovalPauseData,
  identityApprovalStatusExtensions,
} from "../../domain/identity-approval.js";
import { loginToUCPath, loginToACTCrm } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "../../systems/crm/index.js";
import { TransactionError } from "../../systems/ucpath/types.js";
import { searchPerson } from "../../systems/ucpath/navigate.js";
import { findExistingHireTransaction } from "../../systems/ucpath/index.js";
import { interpretPostSubmitTxnReadback } from "../../systems/ucpath/transaction.js";
import { loginToI9, createI9Employee, searchI9Employee } from "../../systems/i9/index.js";
import { extractRawFields, extractRecordPageFields } from "./extract.js";
import { validateEmployeeData } from "./schema.js";
import type { EmployeeData } from "./schema.js";
import { buildTransactionPlan } from "./enter.js";
import { TEMPLATE_ID } from "./config.js";
import {
  buildCrmDocumentDownloadPath,
  downloadCrmIdocsDocuments,
} from "../../systems/crm/idocs-download.js";
import { OnboardingInputSchema } from "./schema.js";
import { maskSsn } from "../../domain/identity/ssn.js";

const onboardingSteps = [
  "crm-auth",
  "crm-search",
  "extraction",
  "pdf-download",
  "ucpath-auth",
  "person-search",
  "i9-creation",
  "transaction",
] as const;

export const ONBOARDING_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

/**
 * Kernel definition for single-mode onboarding.
 *
 * Exports a RegisteredWorkflow. Run it via `runWorkflow(onboardingWorkflow, { email })`
 * in tests/internal scripts, or expose it through a dashboard input-run parser before
 * adding an operator start path.
 */
export const onboardingWorkflow = defineWorkflow({
  name: "onboarding",
  label: "Onboarding",
  archetype: "operation",
  inputSubject: "email",
  code: "on",
  category: "Onboarding",
  iconName: "Users",
  systems: [
    {
      id: "crm",
      login: requireLogin(loginToACTCrm, "ACT CRM authentication failed"),
    },
    {
      id: "ucpath",
      login: requireLogin(loginToUCPath, "UCPath authentication failed"),
    },
    {
      id: "i9",
      // I-9 Complete now authenticates via UCSD Shibboleth SSO + Duo through the
      // UCOP portal (2026-07-01), so `instance` + `abortSignal` ARE used —
      // requireLogin passes them through and loginToI9 joins the global Duo
      // queue (UCPath + I-9 = two staggered Duos here).
      login: requireLogin(loginToI9, "I-9 Complete authentication failed"),
    },
  ],
  authSteps: false,
  steps: onboardingSteps,
  schema: OnboardingInputSchema,
  runtimePolicy: ONBOARDING_WORKFLOW_RUNTIME_POLICY,
  // Identity-approval review: person-search pauses (rather than blindly
  // recording a rehire) when the UCPath match resolves a DIFFERENT-named
  // person than the CRM record. The row then displays "Awaiting Approval" /
  // "Dismissed" via this shared rule (gated on data.eidApproval). See
  // src/domain/identity-approval.ts + the person-search gate below.
  statusExtensions: identityApprovalStatusExtensions,
  // Pool mode: each worker gets its own Session with 3 browsers (CRM + UCPath +
  // I9), 2 Duos per worker (I9 SSO has no 2FA). Pool size 4 matches the legacy
  // default; overridable at runtime via `RunOpts.poolSize`. `preEmitPending: true` lets in-process pool callers emit the full
  // email queue to the dashboard before any worker's auth finishes.
  batch: { mode: "pool", poolSize: 4, preEmitPending: true },
  // Matches pre-subsystem-D WF_CONFIG["onboarding"].detailFields. Dept/Position/
  // Wage/I9-profile are populated after extraction; email is populated from the
  // input schema. firstName+lastName drive getName so the dashboard shows
  // "Jane Doe" instead of the raw email.
  detailFields: [
    { key: "email", label: "Email" },
    { key: "departmentNumber", label: "Dept #" },
    { key: "positionNumber", label: "Position #" },
    { key: "wage", label: "Wage" },
    { key: "effectiveDate", label: "Eff Date" },
    { key: "i9ProfileId", label: "I9 Profile" },
    // Stamped by the post-submit readback (or the duplicate-hire skip path).
    // conditional: rehire / dry-run / failed runs legitimately never reach it.
    { key: "transactionNumber", label: "Txn #", conditional: true },
  ],
  getName: (d) => {
    const name = [d.firstName, d.lastName].filter(Boolean).join(" ");
    if (name) return name;
    return d.email ?? "(extracting)";
  },
  getId: (d) => d.email ?? "",
  initialData: (input) => ({
    email: input.email,
    ...(input.dryRun ? { dryRun: true } : {}),
  }),
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "email", value: input.email }),
  handler: async (ctx, input) => {
    const email = input.email;
    let data: EmployeeData | null = null;

    // Identity-approval re-run marker. When the operator approves a chosen EID
    // from the identity-approval review, the approve action re-enqueues this
    // email carrying `prefilledData.eidApproved` (merged into ctx.data before the
    // handler runs). Its presence means the operator already resolved the
    // identity mismatch surfaced by the person-search gate below, so that gate
    // must NOT re-pause. Read at handler entry (before any step overwrites data).
    const approvedEid =
      typeof ctx.data.eidApproved === "string" ? ctx.data.eidApproved.trim() : "";
    const eidPreApproved = isUcpathEmployeeId(approvedEid);

    // Stamp dryRun onto every running row's data (initialData stamps the
    // pending pre-emit; this carries it to subsequent live rows so the
    // dashboard detail + tracker reflect dry-run mode for the whole run).
    if (input.dryRun) {
      ctx.updateData({ dryRun: true });
    }

    // --- Phase 1: CRM auth + record lookup + extraction ---

    await ctx.step("crm-auth", async () => {
      const t0 = Date.now();
      log.debug(`[Step: crm-auth] START email='${email}'`);
      await ctx.page("crm");
      log.step(`[Step: crm-auth] END took=${Date.now() - t0}ms`);
    });

    const crmPage = await ctx.page("crm");

    let crmRecordFields: { departmentNumber: string | null; recruitmentNumber: string | null } = {
      departmentNumber: null,
      recruitmentNumber: null,
    };

    await ctx.step("crm-search", async () => {
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

      crmRecordFields = await ctx.retry(
        () => extractRecordPageFields(crmPage),
        { attempts: 2 },
      );
      if (crmRecordFields.departmentNumber) ctx.updateData({ departmentNumber: crmRecordFields.departmentNumber });
      if (crmRecordFields.recruitmentNumber) ctx.updateData({ recruitmentNumber: crmRecordFields.recruitmentNumber });

      await ctx.retry(
        () => navigateToSection(crmPage, "UCPath Entry Sheet"),
        { attempts: 2 },
      );
    });

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
      try {
        const rawData = await ctx.retry(
          () => extractRawFields(crmPage),
          { attempts: 2 },
        );
        try {
          data = validateEmployeeData(rawData);
        } catch (e) {
          throw new ExtractionError(`Schema validation failed: ${errorMessage(e)}`);
        }
        if (crmRecordFields.departmentNumber) data = { ...data, departmentNumber: crmRecordFields.departmentNumber };
        if (crmRecordFields.recruitmentNumber) data = { ...data, recruitmentNumber: crmRecordFields.recruitmentNumber };

        ctx.updateData(buildDetailFieldsPayload(data));
        log.success("Employee data extracted and validated");
      } finally {
        log.step(
          `[Step: extraction] END took=${Date.now() - t0}ms `
          + `departmentNumber='${data?.departmentNumber || "<none>"}' `
          + `positionNumber='${data?.positionNumber || "<none>"}' `
          + `name='${data?.firstName ?? ""} ${data?.lastName ?? ""}'`,
        );
      }
    });

    // --- Phase 2: PDF download (non-fatal) ---
    //
    // Downloads run in-process against the already-authenticated CRM page.
    // The standalone `crm-doc-download` daemon exists for explicit CLI use;
    // delegating from onboarding would force a fresh CRM Duo + extra Chromium
    // launch per item (~30-90s wall) since the onboarding daemon's CRM session
    // can't be shared across daemons.

    await ctx.step("pdf-download", async () => {
      const t0 = Date.now();
      log.debug("[Step: pdf-download] START");
      if (!data) throw new Error("extraction did not produce data");
      try {
        const folderPath = buildCrmDocumentDownloadPath({
          firstName: data.firstName,
          lastName: data.lastName,
          middleName: data.middleName,
        });
        const saved = await downloadCrmIdocsDocuments(crmPage, folderPath, {
          workflow: "onboarding",
          itemId: email,
          runId: ctx.runId,
        });
        ctx.updateData({
          pdfDownload: `${saved.length} file(s)`,
          pdfFolder: folderPath,
        });
      } catch (err) {
        const downloadErr = errorMessage(err);
        log.error(`PDF download failed (continuing without PDFs): ${downloadErr}`);
        ctx.updateData({ pdfDownload: `Failed: ${downloadErr.slice(0, 80)}` });
      }
      log.step(`[Step: pdf-download] END took=${Date.now() - t0}ms`);
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
      // ── Identity-approval gate (wrong-person guard) ──
      // person-search matched an existing UCPath person by SSN/DOB/name. If that
      // matched person's name is confidently the SAME (or a close spelling
      // variant) as the CRM-extracted person, it's a genuine rehire (recorded
      // below). But a `different` name means the SSN/name search resolved a
      // DIFFERENT person (an SSN typo / collision) — recording their EID as this
      // person's rehire (or acting on it downstream) is the wrong-person risk
      // that once terminated the wrong employee in separations. So PAUSE for
      // operator approval instead of assuming the match — UNLESS the operator
      // already approved a chosen EID (the eidPreApproved re-run). Uses the SAME
      // order-insensitive `classifyNameSimilarity` confidence tiers separations
      // trusts. This is orthogonal to the 2026-07-01 duplicate-HIRE probe (that
      // guards the new-hire submit path; this guards the rehire-match path).
      const match = searchResult.matches?.[0];
      const matchedName = match ? `${match.firstName} ${match.lastName}`.trim() : "";
      // The CRM-extracted name was stamped into ctx.data by the extraction step
      // (buildDetailFieldsPayload) — read it there (the outer `data` local is
      // narrowed to null in linear flow since it's only assigned inside step
      // closures).
      const crmFirst = typeof ctx.data.firstName === "string" ? ctx.data.firstName : "";
      const crmLast = typeof ctx.data.lastName === "string" ? ctx.data.lastName : "";
      const crmName = `${crmFirst} ${crmLast}`.trim();
      const nameTier = match ? classifyNameSimilarity(crmName, matchedName) : "different";

      if (!eidPreApproved && match && nameTier === "different") {
        log.warn(
          `[person-search] UCPath match "${matchedName}" (EID ${match.emplId}) does not match the CRM `
          + `record "${crmName}" — PAUSING for operator identity approval (no silent rehire/hire).`,
        );
        ctx.updateData(buildIdentityApprovalPauseData({
          // Original = the CRM-extracted person. A new hire has no UCPath EID, so
          // the original card shows the name only (found:false → its "Use this
          // EID" button is disabled; the operator picks the proposed EID, types a
          // different one, or dismisses to fix the CRM record).
          original: { eid: "", name: crmName, found: false },
          // Proposed = the UCPath person the SSN/name search matched.
          proposed: { eid: match.emplId, name: matchedName },
        }));
        // Early return (no steps skipped — onboarding's rehire branch already
        // returns before i9-creation/transaction; the run ends `done`).
        return;
      }
      if (eidPreApproved) {
        log.success(
          `[person-search] EID ${approvedEid} was operator-approved via the identity-approval `
          + `review — proceeding with the confirmed rehire (no re-pause).`,
        );
      }

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
        const ssnWithDashes = data.ssn.replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3");
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

        // Dry-run guard: stop BEFORE the irreversible UCPath Smart HR submit.
        // Everything upstream (CRM extraction, person search, I-9 search-first
        // create) has already run; we only skip `plan.execute()` →
        // `clickSaveAndSubmit`, the single UCPath mutation in this workflow.
        // Mirrors oath-signature / emergency-contact dry-run behavior.
        if (input.dryRun) {
          await ctx.screenshot({ kind: "form", label: "onboarding-dry-run-before-submit" });
          ctx.updateData({ status: "Dry Run Complete", dryRun: true });
          log.success(
            "DRY RUN: reached Smart HR transaction — submit skipped (no UCPath mutation)",
          );
          return;
        }

        // ── Duplicate-hire idempotency probe (before the irreversible submit) ──
        // A prior run can submit the Smart HR hire server-side yet die before
        // writing the terminal tracker row; a kernel retry re-runs the handler
        // from step 0 and would re-file the hire (person-search still returns
        // "new hire" because an unprocessed Smart HR hire creates no searchable
        // person yet). New hires have no EID (Person ID renders "NEW"), so probe
        // the SS Smart HR Transactions list by NAME. The probe is HIGH-CONFIDENCE
        // gated (findExistingHireTransaction → decideHireDuplicateSkip): it flags
        // `found` ONLY for an in-flight/approved HIR/REH whose effective date
        // matches THIS run exactly. A DIFFERENT same-named person's stale hire row
        // (name is a begins-with match) or a terminal-failed hire fails open →
        // `found:false` → we SUBMIT. A false skip would silently never hire the
        // real person, which is worse than the probe-guarded double-submit risk.
        const existingHire = await findExistingHireTransaction(ucpathPage, {
          firstName: data.firstName,
          lastName: data.lastName,
          effectiveDate: data.effectiveDate,
          templateId: TEMPLATE_ID,
        });
        if (existingHire.found) {
          txnExit = existingHire.transactionId || "<already-submitted>";
          log.warn(
            `[Onboarding Txn] A hire transaction (#${existingHire.transactionId || "unknown"}, `
            + `${existingHire.approvalStatus || "unknown status"}, effdt ${existingHire.effectiveDate || "unknown"}) `
            + `already exists on the Smart HR list for ${data.firstName} ${data.lastName} `
            + `(effdt matches this run) — skipping submit to avoid a duplicate hire.`,
          );
          ctx.updateData({
            status: "Already Submitted",
            existingHireTxn: existingHire.transactionId,
            // Same field the fresh-submit readback stamps, so the dashboard
            // Txn # column is populated on both paths.
            transactionNumber: existingHire.transactionId,
          });
          await ctx.screenshot({ kind: "form", label: "onboarding-existing-hire-transaction" });
          return;
        }

        try {
          const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
          log.step("Executing Smart HR transaction plan...");
          await plan.execute();
          await ctx.screenshot({ kind: 'form', label: 'onboarding-transaction-submitted' });
          log.success("Transaction created successfully in UCPath");
          ctx.updateData({ status: "Done" });

          // ── Post-submit transaction-number readback ──
          // A new hire has no EID (the Smart HR list's Person ID column renders
          // "NEW" until the transaction processes), so clickSaveAndSubmit's
          // EID-keyed readback is structurally unavailable here. Instead reuse
          // the NAME-keyed SS Smart HR probe — the same HIGH-CONFIDENCE
          // instrument as the pre-submit duplicate guard (HIR/REH + in-flight
          // status + effdt matching this run EXACTLY), so it can only return
          // THIS run's just-submitted transaction, never a guessed number.
          // Poll a few attempts: the list can take a beat to show the new row.
          let readbackTxnId = "";
          for (let attempt = 1; attempt <= 3 && !readbackTxnId; attempt++) {
            if (attempt > 1) await ucpathPage.waitForTimeout(5_000);
            const readback = await findExistingHireTransaction(ucpathPage, {
              firstName: data.firstName,
              lastName: data.lastName,
              effectiveDate: data.effectiveDate,
              templateId: TEMPLATE_ID,
            });
            if (readback.found) readbackTxnId = readback.transactionId;
          }
          const stamp = interpretPostSubmitTxnReadback(readbackTxnId);
          if (stamp.submittedWithoutTxnNumber) {
            // Fail LOUD in the tracker data (explicit marker, mirroring
            // separations' submittedWithoutTxnNumber) — but do NOT fail the
            // run: the hire IS submitted, and failing here would invite a
            // retry whose fail-open duplicate probe (the same instrument that
            // just missed) could re-submit and create a DUPLICATE HIRE.
            txnExit = "<submitted-without-txn-number>";
            log.warn(
              `[Onboarding Txn] Smart HR hire submitted but the transaction number could not be `
              + `read back from the SS Smart HR list for ${data.firstName} ${data.lastName} `
              + `(effdt ${data.effectiveDate}) — marking submittedWithoutTxnNumber for manual lookup.`,
            );
            await ctx.screenshot({ kind: 'error', label: 'onboarding-transaction-submitted-missing-number' });
            ctx.updateData({ transactionNumber: "", submittedWithoutTxnNumber: true });
          } else {
            txnExit = stamp.transactionNumber;
            log.success(`[Onboarding Txn] Transaction number read back: ${stamp.transactionNumber}`);
            ctx.updateData({ transactionNumber: stamp.transactionNumber });
          }
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
          throw new Error(errMsg, { cause: error });
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
 * Internal single-email adapter.
 * Delegates to the kernel via `runWorkflow(onboardingWorkflow, { email })`.
 *
 * For in-process pool-mode use `runWorkflowBatch(onboardingWorkflow, items)`
 * directly — no adapter indirection through this function.
 */
export async function runOnboarding(email: string): Promise<void> {
  await runWorkflow(onboardingWorkflow, { email });
  log.success("Onboarding transaction completed successfully");
}

/**
 * Internal daemon-mode adapter.
 *
 * Enqueues one `{email}` item per input onto any alive `onboarding`
 * daemon (or spawns one via `ensureDaemonsAndEnqueue`). Daemons keep
 * CRM + UCPath browsers warm across invocations so repeat onboards don't
 * re-Duo every time — CRM's Duo alone costs ~30-60s per run, so this is
 * the biggest wall-clock savings of any converted workflow.
 *
 * Onboarding's `defineWorkflow` already declares `batch: { mode: "pool" }`,
 * which is how `runWorkflowBatch` → `runWorkflowPool` (legacy `--direct`
 * path + `--batch` flag) fans a batch across N workers. Daemon mode is
 * orthogonal: each alive daemon is one long-lived single-worker Session
 * claiming items off the shared SQLite tasks queue. For throughput, start
 * N daemons with `-p N`; the atomic SQLite claim transaction distributes
 * items across them identically to pool workers, with the added benefit
 * that the daemons survive the batch.
 *
 * Public operator starts should go through a dashboard input-run parser.
 */
export const runOnboardingCli = buildCliAdapter<[string[]], { email: string }>({
  workflow: onboardingWorkflow,
  emptyMessage: "runOnboardingCli: no emails provided",
  buildInputs: (emails) => emails.map((email) => ({ email })),
  deriveItemId: (item) => item.email,
  buildPendingData: (item) => ({ email: item.email }),
});
