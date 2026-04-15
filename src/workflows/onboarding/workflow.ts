import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "../../crm/index.js";
import { TransactionError } from "../../ucpath/types.js";
import { searchPerson } from "../../ucpath/navigate.js";
import { withTrackedWorkflow } from "../../tracker/jsonl.js";
import { loginToI9, createI9Employee } from "../../i9/index.js";
import {
  extractRawFields,
  extractRecordPageFields,
  validateEmployeeData,
  buildTransactionPlan,
} from "./index.js";
import type { EmployeeData } from "./index.js";
import { buildDownloadPath, downloadCrmDocuments } from "./download.js";
import { retryStep, RetryStepError } from "./retry.js";

export interface OnboardingOptions {
  dryRun?: boolean;
  /** Pre-launched CRM page (for parallel worker reuse). If omitted, launches a new browser. */
  crmPage?: Page;
  /** Pre-launched UCPath page (for parallel worker reuse). If omitted, launches a new browser. */
  ucpathPage?: Page;
  /** Pre-launched I9 page (for parallel worker reuse). If omitted, launches a new browser. */
  i9Page?: Page;
  /** Log prefix for worker identification, e.g. "[Worker 1]". */
  logPrefix?: string;
}

function prefixed(prefix: string | undefined, msg: string): string {
  return prefix ? `${prefix} ${msg}` : msg;
}

function maskSsn(ssn: string | undefined | null): string {
  if (!ssn) return "";
  const digits = ssn.replace(/-/g, "");
  if (digits.length < 4) return "***";
  return `***-**-${digits.slice(-4)}`;
}

export async function runOnboarding(
  email: string,
  options: OnboardingOptions = {},
): Promise<void> {
  const p = options.logPrefix;
  const isParallel = Boolean(options.crmPage);

  return withLogContext("onboarding", email, async () => {
  return withTrackedWorkflow("onboarding", email, { email }, async (setStep, updateData, _onCleanup, session) => {

  let data: EmployeeData | null = null;

  const sessionId = `onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  session.registerSession(sessionId);
  session.setCurrentItem(email);
  const crmBrowserId = `${sessionId}-crm`;
  const ucpathBrowserId = `${sessionId}-ucpath`;
  const i9BrowserId = `${sessionId}-i9`;

  // --- Phase 1: CRM auth + extraction + PDF download ---
  setStep("crm-auth");
  const crmPage = options.crmPage ?? (await launchBrowser()).page;
  session.registerBrowser(sessionId, crmBrowserId, "CRM");

  log.step(prefixed(p, "Authenticating to ACT CRM..."));
  session.setAuthState(crmBrowserId, "CRM", "start");
  try {
    await retryStep(
      "CRM authentication",
      async () => {
        const ok = await loginToACTCrm(crmPage, session.instance);
        if (!ok) throw new Error("loginToACTCrm returned false");
        return true;
      },
      { attempts: 2, logPrefix: p, backoffMs: 3_000 },
    );
    session.setAuthState(crmBrowserId, "CRM", "complete");
  } catch (err) {
    session.setAuthState(crmBrowserId, "CRM", "failed");
    throw err;
  }

  await retryStep(
    "CRM search",
    async () => {
      log.step(prefixed(p, `Searching for ${email}...`));
      await searchByEmail(crmPage, email);
    },
    { attempts: 3, logPrefix: p },
  );

  await retryStep(
    "CRM select latest result",
    () => selectLatestResult(crmPage),
    { attempts: 3, logPrefix: p },
  );

  const recordFields = await retryStep(
    "CRM record-page extraction",
    () => extractRecordPageFields(crmPage),
    { attempts: 2, logPrefix: p },
  );

  if (recordFields.departmentNumber) updateData({ departmentNumber: recordFields.departmentNumber });
  if (recordFields.recruitmentNumber) updateData({ recruitmentNumber: recordFields.recruitmentNumber });

  // Extract UCPath Entry Sheet fields — needed for name before we can build the download folder
  await retryStep(
    "Navigate to UCPath Entry Sheet",
    () => navigateToSection(crmPage, "UCPath Entry Sheet"),
    { attempts: 2, logPrefix: p },
  );

  setStep("extraction");
  const rawData = await retryStep(
    "Extract employee data",
    () => extractRawFields(crmPage),
    { attempts: 2, logPrefix: p },
  );

  try {
    data = validateEmployeeData(rawData);
  } catch (e) {
    throw new ExtractionError(`Schema validation failed: ${errorMessage(e)}`);
  }
  if (recordFields.departmentNumber) {
    data = { ...data, departmentNumber: recordFields.departmentNumber };
  }
  if (recordFields.recruitmentNumber) {
    data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };
  }

  updateData({
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
  log.success(prefixed(p, "Employee data extracted and validated"));

  // --- Phase 2: PDF download (non-fatal — we log and continue on failure) ---
  setStep("pdf-download");
  const folderPath = buildDownloadPath(data.firstName, data.lastName, data.middleName);
  try {
    // Navigate back to the record page so the PDF viewer iframe is present.
    await retryStep(
      "Navigate to CRM record page for PDF viewer",
      async () => {
        await crmPage.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      },
      { attempts: 2, logPrefix: p },
    );
    const saved = await retryStep(
      "Download CRM PDFs",
      () => downloadCrmDocuments(crmPage, folderPath, { logPrefix: p }),
      { attempts: 2, logPrefix: p, backoffMs: 2_000 },
    );
    updateData({
      pdfDownload: `${saved.length} file(s)`,
      pdfFolder: folderPath,
    });
  } catch (err) {
    // Non-fatal: PDF download failure shouldn't block the transaction
    const msg = errorMessage(err);
    log.error(prefixed(p, `PDF download failed (continuing without PDFs): ${msg}`));
    updateData({ pdfDownload: `Failed: ${msg.slice(0, 80)}` });
  }

  // --- Dry-run short-circuit ---
  if (options.dryRun) {
    const plan = buildTransactionPlan(data, null as unknown as Page, "DRY_RUN");
    log.step(prefixed(p, "=== DRY RUN MODE ==="));
    plan.preview();
    updateData({ i9ProfileId: "Dry Run", status: "Dry Run" });
    log.success(prefixed(p, "Dry run complete — no changes made to UCPath or I9"));
    session.completeItem(email);
    return;
  }

  // --- Phase 3: UCPath auth + person search ---
  setStep("ucpath-auth");
  const ucpathPage = options.ucpathPage ?? (await launchBrowser()).page;
  session.registerBrowser(sessionId, ucpathBrowserId, "UCPath");

  session.setAuthState(ucpathBrowserId, "UCPath", "start");
  try {
    await retryStep(
      "UCPath authentication",
      async () => {
        const ok = await loginToUCPath(ucpathPage, session.instance);
        if (!ok) throw new Error("loginToUCPath returned false");
        return true;
      },
      { attempts: 2, logPrefix: p, backoffMs: 3_000 },
    );
    session.setAuthState(ucpathBrowserId, "UCPath", "complete");
  } catch (err) {
    session.setAuthState(ucpathBrowserId, "UCPath", "failed");
    throw err;
  }

  setStep("person-search");
  const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
  const searchResult = await retryStep(
    "UCPath person search",
    () => searchPerson(ucpathPage, ssnDigits, data!.firstName, data!.lastName, data!.dob ?? ""),
    { attempts: 2, logPrefix: p },
  );

  if (searchResult.found) {
    log.error(prefixed(p, "Person already exists in UCPath — marking as rehire"));
    if (searchResult.matches) {
      for (const m of searchResult.matches) {
        log.step(prefixed(p, `  Empl ID: ${m.emplId}, Name: ${m.firstName} ${m.lastName}`));
      }
    }
    const emplIds = searchResult.matches?.map((m) => m.emplId).join(", ") ?? "";
    updateData({
      rehire: "Yes",
      existingEmplIds: emplIds,
      i9ProfileId: "N/A",
      status: "Rehire",
    });
    session.completeItem(email);
    return;
  }

  log.success(prefixed(p, "No duplicate found — proceeding with I-9 creation"));
  updateData({ rehire: "No" });

  // --- Phase 4: I-9 creation ---
  setStep("i9-creation");
  const i9Page = options.i9Page ?? (await launchBrowser()).page;
  session.registerBrowser(sessionId, i9BrowserId, "I9");

  if (!options.i9Page) {
    session.setAuthState(i9BrowserId, "I9", "start");
    try {
      await retryStep(
        "I-9 login",
        async () => {
          const ok = await loginToI9(i9Page);
          if (!ok) throw new Error("loginToI9 returned false");
          return true;
        },
        { attempts: 2, logPrefix: p, backoffMs: 3_000 },
      );
      session.setAuthState(i9BrowserId, "I9", "complete");
    } catch (err) {
      session.setAuthState(i9BrowserId, "I9", "failed");
      throw err;
    }
  } else {
    // Page reused from parallel worker — pre-authenticated at worker startup
    session.setAuthState(i9BrowserId, "I9", "complete");
  }

  if (!data.ssn) throw new Error("Cannot create I-9 without SSN");
  if (!data.dob) throw new Error("Cannot create I-9 without DOB");
  if (!data.departmentNumber) throw new Error("Cannot create I-9 without department number");

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
    { attempts: 2, logPrefix: p, backoffMs: 3_000 },
  );

  const i9ProfileId = i9Result.profileId!;
  log.success(prefixed(p, `I-9 profile created: ${i9ProfileId}`));
  updateData({ i9ProfileId });

  // --- Phase 5: UCPath Smart HR Transaction ---
  setStep("transaction");
  try {
    const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
    log.step(prefixed(p, "Executing Smart HR transaction plan..."));
    await plan.execute();
    log.success(prefixed(p, "Transaction created successfully in UCPath"));
    updateData({ status: "Done" });
    session.completeItem(email);
  } catch (error) {
    const errMsg = error instanceof TransactionError
      ? `Transaction failed at step "${error.step ?? "unknown"}": ${error.message}`
      : error instanceof RetryStepError
        ? error.message
        : `Transaction failed: ${errorMessage(error)}`;
    updateData({ status: "Failed", transactionError: errMsg });
    throw new Error(errMsg);
  }

  void isParallel; // retained for future branching; no-op today
  }); // end withTrackedWorkflow
  }); // end withLogContext
}
