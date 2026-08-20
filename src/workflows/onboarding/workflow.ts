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
import {
  findExistingHireTransaction,
  readSubmittedHireReceipt,
} from "../../systems/ucpath/index.js";
import { interpretPostSubmitTxnReadback } from "../../systems/ucpath/transaction.js";
import {
  loginToI9,
  createI9Employee,
  searchI9Employee,
  fillI9EmployeeProfileWithoutSaving,
  abandonI9ProfileForm,
  resetI9Page,
} from "../../systems/i9/index.js";
import { extractRawFields, extractRecordPageFields } from "./extract.js";
import { validateEmployeeData } from "./schema.js";
import type { EmployeeData } from "./schema.js";
import { buildTransactionPlan } from "./enter.js";
import { TEMPLATE_ID } from "./config.js";
import {
  buildCrmDocumentDownloadPath,
  downloadCrmIdocsDocuments,
  readCrmIdocsViewerInfo,
  zipCrmDocumentFolder,
  type CrmIdocsViewerInfo,
} from "../../systems/crm/idocs-download.js";
import { OnboardingInputSchema } from "./schema.js";
import { maskSsn, ssnForUcpathEntry } from "../../domain/identity/ssn.js";

/**
 * Synthetic "Tracker Profile ID" used ONLY by a dry run.
 *
 * A rehearsal never saves an I-9 profile, so no real id exists — but the Smart
 * HR personal-data fill writes that field only when it is truthy, and leaving
 * it blank keeps the transaction incomplete (Save and Submit stays greyed out),
 * which would hide exactly what the rehearsal is meant to prove.
 *
 * NUMERIC on purpose. Real I-9 profile ids are digits only (`create.ts`'s
 * `extractProfileId` reads `/employee/profile/(\d+)`), and UCPath's Tracker
 * Profile ID field rejects anything else — a `DRYRUN…` prefixed value left Save
 * disabled through the whole tab walk (live 2026-08-18). Random so two
 * rehearsals never collide.
 *
 * It is never persisted anywhere: a dry run stops before Save and Submit, so
 * this value only ever exists on an unsubmitted draft.
 */
export function buildDryRunPlaceholderProfileId(): string {
  return String(Math.floor(Math.random() * 9_000_000 + 1_000_000));
}

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

    // Captured on the CRM record page during `crm-search` and consumed by
    // `pdf-download` after the run has navigated away. Exactly one of these is
    // set; `idocsViewerError` carries the real failure reason so the download
    // step never reports a misleading cause.
    let idocsViewerInfo: CrmIdocsViewerInfo | null = null;
    let idocsViewerError: string | null = null;

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

      // ── Capture the iDocs viewer hash BEFORE leaving the record page ──
      // The PDF.js viewer is a Salesforce Canvas iframe that exists ONLY on the
      // onboarding record page. `navigateToSection` below is a full `page.goto`
      // to the UCPath Entry Sheet, which tears that iframe down — so the later
      // `pdf-download` step could never find it and every run logged
      // "iDocs PDF.js viewer did not load within 30000ms" (fixed 2026-08-18).
      // Only hash DISCOVERY needs this page; the document fetch itself is a
      // cookie-authenticated request that works from anywhere.
      try {
        idocsViewerInfo = await readCrmIdocsViewerInfo(crmPage);
        log.step(`iDocs viewer hash captured on the record page (totalDocs=${idocsViewerInfo.totalDocs})`);
      } catch (err) {
        // Not fatal — PDFs are auxiliary to the hire. But do NOT swallow it:
        // carry the real reason forward so pdf-download reports THIS cause
        // instead of a misleading "viewer did not load" from the wrong page.
        idocsViewerError = errorMessage(err);
        log.error(`iDocs viewer hash capture failed on the record page: ${idocsViewerError}`);
      }

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
        if (!idocsViewerInfo) {
          throw new Error(
            idocsViewerError
              ?? "iDocs viewer hash was never captured on the CRM record page (crm-search did not run?)",
          );
        }
        const folderPath = buildCrmDocumentDownloadPath({
          firstName: data.firstName,
          lastName: data.lastName,
          middleName: data.middleName,
        });
        const saved = await downloadCrmIdocsDocuments(crmPage, folderPath, {
          workflow: "onboarding",
          itemId: email,
          runId: ctx.runId,
          // Record page is long gone by now — use the hash captured back then.
          viewerInfo: idocsViewerInfo,
        });
        if (saved.length === 0) {
          // Already-archived short-circuit: the zip is on disk from a prior run.
          ctx.updateData({
            pdfDownload: "Already archived",
            pdfArchive: `${folderPath}.zip`,
          });
        } else {
          // Deliver ONE archive per person rather than a folder tree.
          const archive = await zipCrmDocumentFolder(folderPath, saved);
          ctx.updateData({
            pdfDownload: `${archive.entries.length} file(s) — ${archive.filename}`,
            pdfArchive: archive.path,
          });
        }
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
    //
    // DRY RUN (2026-08-18): a rehearsal now walks the WHOLE workflow. Every
    // SEARCH still runs for real (I-9 SSN search below, duplicate-hire probe in
    // the transaction step) — searches are read-only and are exactly what a
    // rehearsal needs to exercise. Only the two FORM SUBMISSIONS are withheld:
    // `createI9Employee` here, and Save-and-Submit in the transaction step.

    const i9ProfileId = await ctx.step("i9-creation", async () => {
      const t0 = Date.now();
      let resultPid = "";
      let mode: "existing" | "created" | "pending" = "pending";
      try {
        if (!data) throw new Error("extraction did not produce data");

        // ── SSN that is not really an SSN (2026-08-18) ──
        // A National ID in the 900-999 range is an ITIN or CRM's all-9s
        // "no SSN on file yet" placeholder. It is NOT an SSN: UCPath refuses it
        // outright, and I-9 Complete refuses it on save ("The SSN number is not
        // valid or is not entered correctly"). Operator rule: that means the
        // person has no SSN, so the I-9 is still created — just with the SSN
        // field LEFT BLANK. Never substitute the placeholder.
        const usableSsn = ssnForUcpathEntry(data.ssn);
        const hasNoSsn = !usableSsn;
        if (hasNoSsn && data.ssn) {
          log.warn(
            `National ID on file for ${data.firstName} ${data.lastName} begins 900-999 (ITIN range / `
            + `"no SSN yet" placeholder) — treating it as NO SSN: the I-9 profile is created with the `
            + `SSN field blank.`,
          );
        }

        if (!data.dob) throw new Error("Cannot create I-9 without DOB");
        if (!data.departmentNumber) throw new Error("Cannot create I-9 without department number");

        log.debug(
          `[Step: i9-creation] START ssnLast4='${usableSsn ? usableSsn.replace(/-/g, "").slice(-4) : "<none>"}' `
          + `dept='${data.departmentNumber}'`,
        );

        const i9Page = await ctx.page("i9");

        // The daemon reuses one I-9 browser across every queued person, and the
        // app leaves stale hidden Kendo dialogs behind whose overlays intercept
        // the next item's clicks. Reset the page per item so item N+1 never
        // inherits item N's modal wreckage (live 2026-08-20: five hires lost).
        await resetI9Page(i9Page);

        // Search for an existing profile FIRST — this is the only thing standing
        // between a re-run and a duplicate I-9. Prefer SSN (unique); with no SSN
        // fall back to first+last NAME rather than skipping the search, because
        // skipping means every re-run creates another profile for the same
        // person (2026-08-18: a no-SSN hire would have accumulated one profile
        // per attempt).
        const searchResults = await ctx.retry(
          () => usableSsn
            ? searchI9Employee(i9Page, {
                ssn: usableSsn.replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3"),
              })
            : searchI9Employee(i9Page, {
                firstName: data!.firstName,
                lastName: data!.lastName,
              }),
          { attempts: 2 },
        );
        if (!usableSsn) {
          log.step(
            `No SSN on file — searched I-9 by name instead `
            + `("${data.firstName} ${data.lastName}"): ${searchResults.length} match(es)`,
          );
        }

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

        // DRY RUN: the authoritative SSN search above HAS run (read-only) and
        // found nothing. Fill the Employee Profile form exactly as a live run
        // would — that is the part worth rehearsing — then abandon it WITHOUT
        // clicking "Save & Continue". The profile record is created by that
        // Save, so an abandoned form leaves nothing behind.
        if (input.dryRun) {
          await fillI9EmployeeProfileWithoutSaving(i9Page, {
            firstName: data.firstName,
            middleName: data.middleName,
            lastName: data.lastName,
            ...(usableSsn ? { ssn: usableSsn } : {}),
            dob: data.dob,
            email: data.email ?? email,
            departmentNumber: data.departmentNumber,
            startDate: data.effectiveDate,
          });
          await ctx.screenshot({ kind: "form", label: "onboarding-dry-run-i9-profile-filled" });
          await abandonI9ProfileForm(i9Page);

          // The real profile id only exists after a Save. Downstream, the Smart
          // HR "Tracker Profile ID" field is filled only `if (i9ProfileId)`, so
          // a blank would leave the form incomplete and Submit could stay
          // greyed out — defeating the point of the rehearsal. Use an obviously
          // synthetic placeholder so the form reaches a complete, submittable
          // state while never being mistaken for a real profile id.
          const placeholderProfileId = buildDryRunPlaceholderProfileId();
          log.warn(
            `DRY RUN: I-9 profile NOT created (form filled then abandoned). Using placeholder `
            + `Tracker Profile ID '${placeholderProfileId}' for the Smart HR form so it reaches a `
            + `complete, submittable state. This is NOT a real I-9 profile id.`,
          );
          ctx.updateData({
            i9ProfileId: `Not created — dry run (placeholder ${placeholderProfileId})`,
            i9DryRunPlaceholderProfileId: placeholderProfileId,
          });
          mode = "pending";
          resultPid = placeholderProfileId;
          return placeholderProfileId;
        }

        // Create is deliberately single-attempt. If the remote mutation lands
        // but its callback/redirect cannot be verified, retrying here could
        // create a duplicate because the authoritative SSN search happened
        // before this call. The next operator retry starts from that search.
        const i9Result = await createI9Employee(i9Page, {
          firstName: data.firstName,
          middleName: data.middleName,
          lastName: data.lastName,
          ...(usableSsn ? { ssn: usableSsn } : {}),
          dob: data.dob,
          email: data.email ?? email,
          departmentNumber: data.departmentNumber,
          startDate: data.effectiveDate,
        });
        if (!i9Result.success || !i9Result.profileId) {
          throw new Error(i9Result.error ?? "I-9 creation returned no profile ID");
        }
        const pid = i9Result.profileId;
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
          // The SUBMIT itself reads the transaction number back via the
          // Transactions-in-Progress row -> Continue -> "Transaction ID:" path.
          // That is the authoritative source for a NEW HIRE; the SS Smart HR
          // list does not carry an unprocessed hire, so deriving it from there
          // produced a false "submittedWithoutTxnNumber" on every successful
          // hire (2026-08-18: T002214808/810/812 were all read fine here while
          // the SS lookup found nothing).
          let submittedTxnNumber = "";
          const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId, {
            dryRun: input.dryRun === true,
            onTransactionNumber: (txn) => { submittedTxnNumber = txn; },
          });
          log.step("Executing Smart HR transaction plan...");
          await plan.execute();

          // DRY RUN terminal: the form is now fully filled but NOT submitted.
          // Screenshot it so the operator can inspect exactly what would have
          // been sent, then stop before the receipt readback (there is no
          // receipt — nothing was submitted).
          if (input.dryRun) {
            txnExit = "<dry-run: filled, not submitted>";
            await ctx.screenshot({ kind: "form", label: "onboarding-dry-run-transaction-filled" });
            log.success(
              "DRY RUN COMPLETE: Smart HR transaction form filled across all tabs and NOT submitted. "
              + "An unsubmitted draft remains in UCPath — delete it there if you do not intend to submit.",
            );
            ctx.updateData({
              status: "Dry Run Complete",
              dryRun: true,
              transactionDraftLeftInUcpath: true,
            });
            return;
          }

          await ctx.screenshot({ kind: 'form', label: 'onboarding-transaction-submitted' });
          log.success("Transaction created successfully in UCPath");
          ctx.updateData({ status: "Done" });

          // ── Post-submit RECEIPT readback ──
          // A new hire has no EID (the Smart HR list's Person ID column renders
          // "NEW" until the transaction processes), so clickSaveAndSubmit's
          // EID-keyed readback is structurally unavailable here. Read the
          // receipt off the transaction's own SS Smart HR detail page instead
          // (`readSubmittedHireReceipt`), effdt-gated to THIS run exactly.
          //
          // A `T…` NUMBER is issued regardless of outcome — a Denied
          // transaction carries a perfectly well-formed one — so success is
          // proved by the PAIR (transactionNumber, approvalStatus), never by
          // the number alone (2026-08-04). The old readback reused the
          // PRE-submit duplicate guard, which fails OPEN and only ever reports
          // an in-flight hire: a REFUSED hire came back indistinguishable from
          // "couldn't read the number", so the operator was told to look up a
          // number for a transaction UCPath had rejected.
          //
          // Prefer the number the submit already read back. Only fall back to
          // the SS Smart HR receipt when the submit could not read one — that
          // list is keyed on processed transactions and legitimately does not
          // hold a brand-new pending hire.
          let receipt = { transactionId: "", approvalStatus: "", effectiveDate: "" };
          if (submittedTxnNumber) {
            log.success(
              `[Onboarding Txn] Transaction number read from the submit itself: ${submittedTxnNumber}`,
            );
            receipt = {
              transactionId: submittedTxnNumber,
              // A freshly submitted hire enters the approval queue as Pending;
              // the submit page shows it under the HIRE routing box. We do not
              // invent a status beyond that, and the operator sees the number.
              approvalStatus: "Pending",
              effectiveDate: data.effectiveDate,
            };
          } else {
            for (let attempt = 1; attempt <= 3 && !receipt.transactionId; attempt++) {
              if (attempt > 1) await ucpathPage.waitForTimeout(5_000);
              receipt = await readSubmittedHireReceipt(ucpathPage, {
                firstName: data.firstName,
                lastName: data.lastName,
                effectiveDate: data.effectiveDate,
                templateId: TEMPLATE_ID,
              });
            }
          }
          const stamp = interpretPostSubmitTxnReadback(
            receipt.transactionId,
            receipt.approvalStatus,
          );
          const who = `${data.firstName} ${data.lastName} (effdt ${data.effectiveDate})`;
          // NONE of these branches throws. The hire IS submitted by this point,
          // and failing the run would invite a retry whose fail-open duplicate
          // probe could re-submit and create a DUPLICATE HIRE. Loudness lives
          // in the tracker row (status + explicit marker) and the screenshot.
          if (stamp.submittedWithoutTxnNumber) {
            // No readable transaction number at all — mirrors separations'
            // submittedWithoutTxnNumber marker.
            txnExit = "<submitted-without-txn-number>";
            log.warn(
              `[Onboarding Txn] Smart HR hire submitted but NO transaction number could be read `
              + `back from the SS Smart HR list for ${who} — marking submittedWithoutTxnNumber for `
              + `manual lookup. The submit outcome is UNCONFIRMED.`,
            );
            await ctx.screenshot({ kind: 'error', label: 'onboarding-transaction-submitted-missing-number' });
            ctx.updateData({
              status: "Needs Review",
              transactionNumber: "",
              transactionApprovalStatus: "",
              submittedWithoutTxnNumber: true,
            });
          } else if (stamp.outcome === "unknown") {
            // A real number, but the approval status is blank/unrecognized.
            // "The status could not be read" must never become "approved".
            txnExit = `<receipt-unverified:${stamp.transactionNumber}>`;
            log.error(
              `[Onboarding Txn] Smart HR hire ${stamp.transactionNumber} for ${who} read back with an `
              + `UNREADABLE approval status ('${stamp.approvalStatus || "<blank>"}') — refusing to treat `
              + `it as a successful submit; a human must check the transaction in UCPath.`,
            );
            await ctx.screenshot({ kind: 'error', label: 'onboarding-transaction-receipt-unverified' });
            ctx.updateData({
              status: "Needs Review",
              transactionNumber: stamp.transactionNumber,
              transactionApprovalStatus: stamp.approvalStatus,
              transactionReceiptUnverified: true,
            });
          } else if (stamp.outcome === "refused") {
            // UCPath REFUSED the transaction. The number is stamped for the
            // audit trail, but this is NOT a successful hire.
            txnExit = `<refused:${stamp.transactionNumber}/${stamp.approvalStatus}>`;
            log.error(
              `[Onboarding Txn] UCPath REFUSED Smart HR hire ${stamp.transactionNumber} for ${who} `
              + `— approval status '${stamp.approvalStatus}'. The hire did NOT go through; it is not `
              + `resubmitted automatically because UCPath would refuse the same transaction again.`,
            );
            await ctx.screenshot({ kind: 'error', label: 'onboarding-transaction-refused' });
            ctx.updateData({
              status: "Transaction Refused",
              transactionNumber: stamp.transactionNumber,
              transactionApprovalStatus: stamp.approvalStatus,
              transactionRefused: true,
            });
          } else if (stamp.outcome === "pending") {
            // Submitted and awaiting an approver — the normal state right after
            // a submit, and a legitimate intermediate. Distinct from "Done" so
            // nobody reads an unapproved hire as a finished one.
            txnExit = `${stamp.transactionNumber} (${stamp.approvalStatus})`;
            log.success(
              `[Onboarding Txn] Smart HR hire ${stamp.transactionNumber} submitted for ${who} — `
              + `approval status '${stamp.approvalStatus}' (awaiting approval).`,
            );
            ctx.updateData({
              status: "Pending Approval",
              transactionNumber: stamp.transactionNumber,
              transactionApprovalStatus: stamp.approvalStatus,
            });
          } else {
            txnExit = `${stamp.transactionNumber} (${stamp.approvalStatus})`;
            log.success(
              `[Onboarding Txn] Smart HR hire ${stamp.transactionNumber} ACCEPTED for ${who} — `
              + `approval status '${stamp.approvalStatus}'.`,
            );
            ctx.updateData({
              status: "Done",
              transactionNumber: stamp.transactionNumber,
              transactionApprovalStatus: stamp.approvalStatus,
            });
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
        const exitStr = failedAtStep ? `<failed at step: ${String(failedAtStep)}>` : txnExit;
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
