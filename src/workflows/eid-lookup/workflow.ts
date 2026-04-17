/**
 * EID Lookup workflow: search employees by name in parallel tabs.
 *
 * Kernel-based. Each CLI run is one workflow run. Inside the `searching` step,
 * the handler fans out the name list across N tabs (page-per-worker) sharing
 * one BrowserContext + one UCPath Duo auth. CRM-on mode adds a second browser
 * for cross-verification.
 *
 * Excel tracker writes go through `updateEidTracker` / `updateEidTrackerNotFound`
 * with an async-mutex to serialize concurrent worker writes.
 */

import { Mutex } from "async-mutex";
import type { Page } from "playwright";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/types.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { runWorkerPool } from "../../utils/worker-pool.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { searchByName, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
import { updateEidTracker, updateEidTrackerNotFound } from "./tracker.js";
import {
  EidLookupInputSchema,
  EidLookupCrmInputSchema,
  type EidLookupInput,
  type EidLookupCrmInput,
} from "./schema.js";

export interface EidLookupOptions {
  /** Number of parallel browser tabs. Default: min(names.length, 4). */
  workers?: number;
  /** Whether to run CRM cross-verification. Default: true. */
  useCrm?: boolean;
  /** Preview the planned name list without launching a browser. */
  dryRun?: boolean;
}

export interface LookupResult {
  name: string;
  found: boolean;
  sdcmpResults: EidResult[];
  error?: string;
}

const stepsNoCrm = ["ucpath-auth", "searching"] as const;
const stepsCrm = ["ucpath-auth", "searching", "crm-auth", "cross-verification"] as const;

/**
 * Run the searching phase: fan out the name list across N worker tabs in the
 * shared UCPath context, write Excel rows under a mutex, collect results.
 * Used by both no-CRM and CRM-on handlers.
 */
async function runSearchingPhase(
  ucpathPage: Page,
  input: EidLookupInput,
): Promise<LookupResult[]> {
  const context = ucpathPage.context();

  // Mutex serializes concurrent Excel writes from parallel workers — the
  // tracker file is xlsx (not jsonl), so two workers writing simultaneously
  // would corrupt it. JSONL writes are atomic per-line and don't need this.
  const trackerMutex = new Mutex();
  const lockedUpdateEidTracker = async (name: string, r: EidResult): Promise<void> => {
    const release = await trackerMutex.acquire();
    try { await updateEidTracker(name, r); } finally { release(); }
  };
  const lockedUpdateEidTrackerNotFound = async (name: string): Promise<void> => {
    const release = await trackerMutex.acquire();
    try { await updateEidTrackerNotFound(name); } finally { release(); }
  };

  const results: LookupResult[] = [];

  log.step(`Searching ${input.names.length} name(s) with ${input.workers} parallel worker(s)...`);

  await runWorkerPool({
    items: input.names,
    workerCount: input.workers,
    // setup: first worker reuses the auth page; subsequent workers open new tabs
    // in the same context (shared auth, separate page state).
    setup: async (workerId) => {
      if (workerId === 1) return ucpathPage;
      return await context.newPage();
    },
    // process: run the search on this worker's tab, write Excel row(s) under mutex.
    process: async (nameInput, workerPage, workerId) => {
      const prefix = `[Worker ${workerId}]`;
      log.step(`${prefix} Searching: "${nameInput}"`);
      try {
        const result = await searchByName(workerPage, nameInput);
        if (result.sdcmpResults.length > 0) {
          log.success(`${prefix} Found ${result.sdcmpResults.length} result(s) for "${nameInput}":`);
          for (const r of result.sdcmpResults) {
            log.success(
              `  EID: ${r.emplId} | ${r.department ?? "?"} | ${r.jobCodeDescription} | ${r.name} | ${r.expectedEndDate || "Active"}`,
            );
            await lockedUpdateEidTracker(nameInput, r);
          }
          results.push({ name: nameInput, found: true, sdcmpResults: result.sdcmpResults });
        } else {
          log.step(`${prefix} No SDCMP results for "${nameInput}"`);
          await lockedUpdateEidTrackerNotFound(nameInput);
          results.push({ name: nameInput, found: false, sdcmpResults: [] });
        }
      } catch (err) {
        const msg = errorMessage(err);
        log.error(`${prefix} Failed for "${nameInput}": ${msg}`);
        results.push({ name: nameInput, found: false, sdcmpResults: [], error: msg });
        // DO NOT rethrow — worker pool would log a duplicate error and we
        // already recorded the failure; the next queue item should proceed.
      }
    },
  });

  return results;
}

/** Pretty-print the per-name results at the end of each run. */
function logSummary(results: LookupResult[]): void {
  log.step("\n=== EID Lookup Summary ===");
  for (const r of results) {
    if (r.sdcmpResults.length > 0) {
      const eids = r.sdcmpResults
        .map((s) => `${s.emplId} (${s.department ?? "?"} | ${s.expectedEndDate || "Active"})`)
        .join(", ");
      log.success(`${r.name} → ${eids}`);
    } else {
      log.error(`${r.name} → ${r.error ?? "No SDCMP results"}`);
    }
  }
}

/**
 * Cross-verify one name against CRM. Logs hire-date matches; does not write
 * to the Excel tracker (tracker rows already include the SDCMP details).
 */
async function crossVerifyOne(
  crmPage: Page,
  nameInput: string,
  results: LookupResult[],
): Promise<void> {
  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(nameInput);
  } catch (err) {
    log.error(`CRM cross-verify: invalid name "${nameInput}" — ${errorMessage(err)}`);
    return;
  }
  const { lastName, first: firstName } = parsed;

  let crmRecords: CrmRecord[] = [];
  try {
    crmRecords = await searchCrmByName(crmPage, lastName, firstName);
  } catch (err) {
    log.error(`CRM cross-verify: search failed for "${nameInput}" — ${errorMessage(err)}`);
    return;
  }

  if (crmRecords.length === 0) {
    log.step(`CRM: no records for "${nameInput}"`);
    return;
  }

  // Pull the SDCMP results we found earlier for this name (best-effort match by string).
  const ucpathHit = results.find((r) => r.name === nameInput);
  const allSdcmp = ucpathHit?.sdcmpResults ?? [];

  // Direct UCPath EID match
  for (const crec of crmRecords) {
    if (crec.ucpathEmployeeId) {
      log.step(`CRM has UCPath EID: ${crec.ucpathEmployeeId} for ${crec.name}`);
      const match = allSdcmp.find((r) => r.emplId === crec.ucpathEmployeeId);
      if (match) {
        log.success(`Direct EID match: ${match.emplId} — ${match.department}`);
      }
    }
  }

  // Hire date match (±7 days)
  for (const crec of crmRecords) {
    const crmDate = crec.firstDayOfService;
    if (!crmDate) continue;
    for (const ucRec of allSdcmp) {
      const ucDate = ucRec.effectiveDate;
      if (!ucDate) continue;
      if (datesWithinDays(crmDate, ucDate, 7)) {
        log.success(
          `Date match: CRM "${crmDate}" ≈ UCPath "${ucDate}" → EID ${ucRec.emplId} | ${ucRec.department}`,
        );
      }
    }
  }
}

/**
 * No-CRM kernel definition. One UCPath system, two steps. Handler fans out
 * the name list across N worker tabs in a single shared BrowserContext.
 */
export const eidLookupWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page) => {
        const ok = await loginToUCPath(page);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  steps: stepsNoCrm,
  schema: EidLookupInputSchema,
  tiling: "single",
  authChain: "sequential",
  // Per-name results stay in Excel (one CLI run = one workflow row — see
  // CLAUDE.md "Acceptable regression"). `searchName` is populated once from
  // the input list so the detail panel isn't empty; `totalNames`/`foundCount`/
  // `missingCount` are stamped after search completes.
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "totalNames", label: "Total Names" },
    { key: "foundCount", label: "Found" },
    { key: "missingCount", label: "Missing" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  handler: async (ctx: Ctx<typeof stepsNoCrm, EidLookupInput>, input) => {
    // Stamp the search name(s) immediately so the dashboard detail panel has
    // something to show during auth + searching — the batched nature of this
    // workflow means there's no per-name entry; one run covers N names.
    ctx.updateData({
      searchName: input.names.slice(0, 3).join(", ") + (input.names.length > 3 ? ", ..." : ""),
      totalNames: input.names.length,
    });

    ctx.markStep("ucpath-auth");
    const ucpathPage = await ctx.page("ucpath");

    const results = await ctx.step("searching", async () => {
      const r = await runSearchingPhase(ucpathPage, input);
      const found = r.filter((x) => x.found).length;
      ctx.updateData({
        foundCount: found,
        missingCount: input.names.length - found,
      });
      return r;
    });

    logSummary(results);
  },
});

/**
 * CRM-on kernel definition. Two systems (UCPath + CRM), four steps,
 * sequential auth (Duo ×2 — UCPath first, then CRM).
 */
export const eidLookupCrmWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page) => {
        const ok = await loginToUCPath(page);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
    {
      id: "crm",
      login: async (page) => {
        const ok = await loginToACTCrm(page);
        if (!ok) throw new Error("CRM authentication failed");
      },
    },
  ],
  steps: stepsCrm,
  schema: EidLookupCrmInputSchema,
  tiling: "auto",
  authChain: "sequential",
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "totalNames", label: "Total Names" },
    { key: "foundCount", label: "Found" },
    { key: "missingCount", label: "Missing" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  handler: async (ctx: Ctx<typeof stepsCrm, EidLookupCrmInput>, input) => {
    // Stamp the search name(s) immediately so the dashboard detail panel has
    // something to show during auth + searching — the batched nature of this
    // workflow means there's no per-name entry; one run covers N names.
    ctx.updateData({
      searchName: input.names.slice(0, 3).join(", ") + (input.names.length > 3 ? ", ..." : ""),
      totalNames: input.names.length,
    });

    ctx.markStep("ucpath-auth");
    const ucpathPage = await ctx.page("ucpath");

    ctx.markStep("crm-auth");
    const crmPage = await ctx.page("crm");

    const results = await ctx.step("searching", async () => {
      const r = await runSearchingPhase(ucpathPage, input);
      const found = r.filter((x) => x.found).length;
      ctx.updateData({
        foundCount: found,
        missingCount: input.names.length - found,
      });
      return r;
    });

    await ctx.step("cross-verification", async () => {
      log.step(`\n--- CRM Cross-Verification (${input.names.length} name(s)) ---`);
      for (const nameInput of input.names) {
        await crossVerifyOne(crmPage, nameInput, results);
      }
    });

    logSummary(results);
  },
});

/**
 * CLI adapter for `tsx src/cli.ts eid-lookup <names...>`.
 *
 * Pre-kernel phases:
 *   1. Validate inputs.
 *   2. Dry-run short-circuit: log the planned name list + CRM mode, exit 0
 *      without launching a browser.
 *   3. Pick the right workflow definition based on `useCrm`.
 *   4. Delegate to runWorkflow.
 */
export async function runEidLookup(
  names: string[],
  options: EidLookupOptions = {},
): Promise<void> {
  if (names.length === 0) {
    log.error("eid-lookup requires at least one name");
    process.exit(1);
  }
  const useCrm = options.useCrm !== false;
  const workers = options.workers ?? Math.min(names.length, 4);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(`CRM cross-verification: ${useCrm ? "ON" : "OFF"}`);
    log.step(`Workers: ${workers}`);
    log.step(`Names (${names.length}):`);
    for (const n of names) log.step(`  - ${n}`);
    log.success("Dry run complete — no browser launched, no UCPath/CRM contact made");
    return;
  }

  const input: EidLookupInput = { names, workers };

  try {
    if (useCrm) {
      await runWorkflow(eidLookupCrmWorkflow, input);
    } else {
      await runWorkflow(eidLookupWorkflow, input);
    }
    log.success("EID lookup complete");
  } catch (err) {
    log.error(`EID lookup failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
