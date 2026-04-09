/**
 * EID Lookup workflow: search employees by name in parallel windows.
 *
 * Opens N browser windows (sharing one UCPath auth session via Duo),
 * distributes names across them, and searches Person Org Summary for each.
 */

import { launchBrowser } from "../../browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { log, withLogContext } from "../../utils/log.js";
import { withTrackedWorkflow } from "../../tracker/jsonl.js";
import { searchByName, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
import { updateEidTracker, updateEidTrackerNotFound } from "./tracker.js";
import { Mutex } from "async-mutex";
import type { Page, Browser, BrowserContext } from "playwright";

export interface LookupResult {
  name: string;
  found: boolean;
  sdcmpResults: EidResult[];
  error?: string;
}

/**
 * Run EID lookup for a single name.
 */
export async function lookupSingle(nameInput: string): Promise<LookupResult> {
  const { browser, page } = await launchBrowser();

  try {
    return await withLogContext("eid-lookup", nameInput, async () => {
      return withTrackedWorkflow("eid-lookup", nameInput, {}, async (setStep, updateData) => {
      log.step(`Looking up: "${nameInput}"`);

      setStep("ucpath-auth");
      const loggedIn = await loginToUCPath(page);
      if (!loggedIn) {
        return { name: nameInput, found: false, sdcmpResults: [], error: "UCPath login failed" };
      }

      setStep("searching");
      const result = await searchByName(page, nameInput);

      if (result.sdcmpResults.length > 0) {
        const first = result.sdcmpResults[0];
        updateData({ emplId: first.emplId ?? "", name: first.name ?? "" });
        log.success(`Found ${result.sdcmpResults.length} SDCMP result(s) for "${nameInput}":`);
        for (const r of result.sdcmpResults) {
          log.success(`  EID: ${r.emplId} | ${r.department ?? "?"} | ${r.jobCodeDescription} | ${r.name} | ${r.expectedEndDate || "Active"}`);
          await updateEidTracker(nameInput, r);
        }
      } else {
        log.error(`No SDCMP results for "${nameInput}"`);
        await updateEidTrackerNotFound(nameInput);
      }

      return {
        name: nameInput,
        found: result.found,
        sdcmpResults: result.sdcmpResults,
      };
      }); // end withTrackedWorkflow
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Lookup failed for "${nameInput}": ${msg}`);
    return { name: nameInput, found: false, sdcmpResults: [], error: msg };
  }
}

/**
 * Run EID lookup for multiple names in parallel windows.
 *
 * All windows share a single browser context (one Duo auth),
 * each opens a new tab for parallel searching.
 */
export async function lookupParallel(
  names: string[],
  workers: number,
): Promise<LookupResult[]> {
  log.step(`Looking up ${names.length} name(s) with ${workers} parallel worker(s)...`);

  // Mutex to serialize concurrent Excel writes from parallel workers
  const trackerMutex = new Mutex();
  const lockedUpdateEidTracker = async (name: string, r: EidResult): Promise<void> => {
    const release = await trackerMutex.acquire();
    try { await updateEidTracker(name, r); } finally { release(); }
  };
  const lockedUpdateEidTrackerNotFound = async (name: string): Promise<void> => {
    const release = await trackerMutex.acquire();
    try { await updateEidTrackerNotFound(name); } finally { release(); }
  };

  // Launch one browser, authenticate once
  const { browser, context, page: authPage } = await launchBrowser();

  try {
    log.step("Authenticating to UCPath (one-time)...");
    const loggedIn = await loginToUCPath(authPage);
    if (!loggedIn) {
      log.error("UCPath login failed");
      return names.map((n) => ({ name: n, found: false, sdcmpResults: [], error: "Login failed" }));
    }
    log.success("Authenticated — opening parallel tabs...");

    // Create worker pages (new tabs in same context — shared auth)
    const pages: Page[] = [];
    for (let i = 0; i < Math.min(workers, names.length); i++) {
      if (i === 0) {
        pages.push(authPage); // Reuse the auth page for first worker
      } else {
        const newPage = await context.newPage();
        pages.push(newPage);
      }
    }

    // Queue-based worker distribution
    const queue = [...names];
    const results: LookupResult[] = [];

    const runWorker = async (workerPage: Page, workerId: number): Promise<void> => {
      while (queue.length > 0) {
        const nameInput = queue.shift()!;
        log.step(`[Worker ${workerId}] Searching: "${nameInput}"`);

        const workerResult = await withLogContext("eid-lookup", nameInput, async () => {
          return withTrackedWorkflow("eid-lookup", nameInput, {}, async (setStep, updateData) => {
          try {
            setStep("searching");
            const result = await searchByName(workerPage, nameInput);

            if (result.sdcmpResults.length > 0) {
              const first = result.sdcmpResults[0];
              updateData({ emplId: first.emplId ?? "", name: first.name ?? "" });
              log.success(`[Worker ${workerId}] Found ${result.sdcmpResults.length} result(s) for "${nameInput}":`);
              for (const r of result.sdcmpResults) {
                log.success(`  EID: ${r.emplId} | ${r.department ?? "?"} | ${r.jobCodeDescription} | ${r.name} | ${r.expectedEndDate || "Active"}`);
                await lockedUpdateEidTracker(nameInput, r);
              }
            } else {
              log.step(`[Worker ${workerId}] No SDCMP results for "${nameInput}"`);
              await lockedUpdateEidTrackerNotFound(nameInput);
            }

            return {
              name: nameInput,
              found: result.found,
              sdcmpResults: result.sdcmpResults,
            } as LookupResult;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`[Worker ${workerId}] Failed for "${nameInput}": ${msg}`);
            return { name: nameInput, found: false, sdcmpResults: [], error: msg } as LookupResult;
          }
          }); // end withTrackedWorkflow
        });
        results.push(workerResult);
      }
    };

    // Run workers in parallel
    await Promise.all(pages.map((p, i) => runWorker(p, i + 1)));

    // Print summary
    log.step("\n=== EID Lookup Summary ===");
    for (const r of results) {
      if (r.sdcmpResults.length > 0) {
        const eids = r.sdcmpResults.map((s) => `${s.emplId} (${s.department ?? "?"} | ${s.expectedEndDate || "Active"})`).join(", ");
        log.success(`${r.name} → ${eids}`);
      } else {
        log.error(`${r.name} → ${r.error ?? "No SDCMP results"}`);
      }
    }

    return results;
  } finally {
    // Keep browser open so user can inspect
    log.step("Browser stays open for inspection.");
  }
}

/**
 * Run EID lookup with CRM cross-verification for a single name.
 *
 * Opens two browser windows:
 *   1. UCPath — search Person Org Summary, drill into SDCMP results
 *   2. CRM — search by last name then first name, extract record fields
 *
 * Cross-verifies by matching hire dates within 7 days.
 * Duo MFA is done sequentially (UCPath first, then CRM).
 */
export async function lookupWithCrm(nameInput: string): Promise<LookupResult> {
  const { lastName, first: firstName } = parseNameInput(nameInput);

  // Launch UCPath browser
  log.step(`=== EID Lookup with CRM: "${nameInput}" ===`);
  const ucpath = await launchBrowser();

  try {
    return await withLogContext("eid-lookup", nameInput, async () => {
      return withTrackedWorkflow("eid-lookup", nameInput, {}, async (setStep, updateData) => {
      // Step 1: Authenticate UCPath
      setStep("ucpath-auth");
      log.step("Authenticating to UCPath...");
      const ucpathOk = await loginToUCPath(ucpath.page);
      if (!ucpathOk) {
        return { name: nameInput, found: false, sdcmpResults: [], error: "UCPath login failed" };
      }

      // Step 2: Authenticate CRM (separate browser, separate Duo)
      setStep("crm-auth");
      log.step("Launching CRM browser...");
      const crm = await launchBrowser();
      log.step("Authenticating to CRM...");
      const crmOk = await loginToACTCrm(crm.page);
      if (!crmOk) {
        log.error("CRM login failed — continuing with UCPath only");
      }

      // Step 3: Run both searches
      setStep("searching");
      // UCPath search
      log.step("\n--- UCPath Search ---");
      const ucpathResult = await searchByName(ucpath.page, nameInput);

      // CRM search (if auth succeeded)
      let crmRecords: CrmRecord[] = [];
      if (crmOk) {
        log.step("\n--- CRM Search ---");
        crmRecords = await searchCrmByName(crm.page, lastName, firstName);
      }

      // Step 4: Cross-verify
      setStep("cross-verification");
      log.step("\n--- Cross-Verification ---");

      // If CRM has a UCPath Employee ID, check if it matches any SDCMP result
      for (const crec of crmRecords) {
        if (crec.ucpathEmployeeId) {
          log.step(`CRM has UCPath EID: ${crec.ucpathEmployeeId}`);
          const match = ucpathResult.sdcmpResults.find((r) => r.emplId === crec.ucpathEmployeeId);
          if (match) {
            log.success(`Direct EID match: ${match.emplId} — ${match.department}`);
          }
        }
      }

      // Match by hire date: CRM "First Day of Service" ≈ UCPath "Last Hire Date" (±7 days)
      const allSdcmp = ucpathResult.sdcmpResults;
      for (const crec of crmRecords) {
        const crmDate = crec.firstDayOfService;
        if (!crmDate) continue;

        for (const ucRec of allSdcmp) {
          const ucDate = ucRec.effectiveDate; // Last Hire Date from drill-in
          if (!ucDate) continue;

          if (datesWithinDays(crmDate, ucDate, 7)) {
            log.success(`Date match: CRM "${crmDate}" ≈ UCPath "${ucDate}" → EID ${ucRec.emplId} | ${ucRec.department}`);
          }
        }
      }

      // Print CRM summary
      if (crmRecords.length > 0) {
        log.step("\nCRM Records:");
        for (const c of crmRecords) {
          log.step(`  ${c.name} | PPS: ${c.ppsId} | Hire: ${c.firstDayOfService} | Dept: ${c.department}`);
        }
      } else {
        log.step("CRM: No records found");
      }

      // Print UCPath summary
      if (allSdcmp.length > 0) {
        const first = allSdcmp[0];
        updateData({ emplId: first.emplId ?? "", name: first.name ?? "" });
        log.step("\nUCPath SDCMP Results:");
        for (const r of allSdcmp) {
          log.success(`  EID: ${r.emplId} | ${r.department ?? "?"} | Start: ${r.effectiveDate} | End: ${r.expectedEndDate || "Active"}`);
          await updateEidTracker(nameInput, r);
        }
      } else {
        log.error("UCPath: No SDCMP results");
        await updateEidTrackerNotFound(nameInput);
      }

      return {
        name: nameInput,
        found: ucpathResult.found,
        sdcmpResults: ucpathResult.sdcmpResults,
      };
      }); // end withTrackedWorkflow
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Lookup with CRM failed for "${nameInput}": ${msg}`);
    return { name: nameInput, found: false, sdcmpResults: [], error: msg };
  }
}
