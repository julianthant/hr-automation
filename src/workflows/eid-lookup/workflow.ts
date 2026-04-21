/**
 * EID Lookup workflow: search employees by name in parallel tabs.
 *
 * Kernel-based (shared-context-pool mode). Each CLI invocation launches one
 * UCPath browser (+ CRM browser in CRM mode), authenticates once per system,
 * then fans out N names across N tabs in each shared BrowserContext. Each
 * name is a separate kernel item so the dashboard shows one row per name.
 */

import { defineWorkflow, runWorkflowBatch } from "../../core/index.js";
import type { Ctx } from "../../core/types.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { searchByName, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays } from "./crm-search.js";
import { EidLookupItemSchema, type EidLookupItem } from "./schema.js";

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

const stepsNoCrm = ["searching"] as const;
const stepsCrm = ["searching", "cross-verification"] as const;

/**
 * Perform the UCPath SDCMP/HDH search for one name and stamp the result
 * fields onto the tracker entry's data. Returns the raw results so the
 * CRM step can cross-reference them.
 */
async function searchingStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, EidLookupItem>,
  input: EidLookupItem,
): Promise<EidResult[]> {
  const page = await ctx.page("ucpath");
  const result = await searchByName(page, input.name);
  if (result.sdcmpResults.length === 0) {
    log.step(`No SDCMP results for "${input.name}"`);
    ctx.updateData({ emplId: "Not found" });
    return [];
  }
  const first = result.sdcmpResults[0];
  log.success(
    `Found ${result.sdcmpResults.length} result(s) for "${input.name}": EID ${first.emplId} | ${first.department ?? "?"} | ${first.jobCodeDescription}`,
  );
  ctx.updateData({
    emplId: first.emplId,
    department: first.department ?? "",
    jobTitle: first.jobCodeDescription ?? "",
  });
  return result.sdcmpResults;
}

/**
 * Cross-verify one name against CRM. Emits `crmMatch` as one of:
 *  - "direct" — UCPath EID matched a CRM record's UCPath EID
 *  - "date"   — UCPath effective date matched a CRM firstDayOfService (±7d)
 *  - "none"   — CRM returned records but none matched
 *  - ""       — CRM returned no records for this name
 */
async function crossVerificationStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, EidLookupItem>,
  input: EidLookupItem,
  sdcmp: EidResult[],
): Promise<void> {
  const crmPage = await ctx.page("crm");

  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(input.name);
  } catch (err) {
    log.error(`CRM cross-verify: invalid name "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  let crmRecords: Awaited<ReturnType<typeof searchCrmByName>> = [];
  try {
    crmRecords = await searchCrmByName(crmPage, parsed.lastName, parsed.first);
  } catch (err) {
    log.error(`CRM cross-verify: search failed for "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  if (crmRecords.length === 0) {
    log.step(`CRM: no records for "${input.name}"`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  for (const crec of crmRecords) {
    if (crec.ucpathEmployeeId) {
      const match = sdcmp.find((r) => r.emplId === crec.ucpathEmployeeId);
      if (match) {
        log.success(`Direct EID match: ${match.emplId} — ${match.department}`);
        ctx.updateData({ crmMatch: "direct" });
        return;
      }
    }
  }

  for (const crec of crmRecords) {
    const crmDate = crec.firstDayOfService;
    if (!crmDate) continue;
    for (const ucRec of sdcmp) {
      const ucDate = ucRec.effectiveDate;
      if (!ucDate) continue;
      if (datesWithinDays(crmDate, ucDate, 7)) {
        log.success(`Date match: CRM "${crmDate}" ≈ UCPath "${ucDate}" → EID ${ucRec.emplId}`);
        ctx.updateData({ crmMatch: "date" });
        return;
      }
    }
  }

  ctx.updateData({ crmMatch: "none" });
}

/**
 * No-CRM kernel definition. One UCPath system, one step per item.
 * Each item = one searched name; shared-context-pool fans out N tabs
 * against a single UCPath browser + Duo auth.
 */
export const eidLookupWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: stepsNoCrm,
  schema: EidLookupItemSchema,
  tiling: "single",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
    { key: "jobTitle", label: "Title" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx: Ctx<typeof stepsNoCrm, EidLookupItem>, input) => {
    ctx.updateData({ searchName: input.name });
    await ctx.step("searching", async () => {
      await searchingStep(ctx, input);
    });
  },
});

/**
 * CRM-on kernel definition. Two systems (UCPath + CRM), two handler steps.
 * Each item = one searched name with its own UCPath tab AND its own CRM tab.
 * Sequential auth chain — Duo ×1 UCPath then ×1 CRM, once for the whole pool.
 */
export const eidLookupCrmWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
    {
      id: "crm",
      login: async (page, instance) => {
        const ok = await loginToACTCrm(page, instance);
        if (!ok) throw new Error("CRM authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: stepsCrm,
  schema: EidLookupItemSchema,
  tiling: "auto",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
    { key: "jobTitle", label: "Title" },
    { key: "crmMatch", label: "CRM Match" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx: Ctx<typeof stepsCrm, EidLookupItem>, input) => {
    ctx.updateData({ searchName: input.name });
    const sdcmp = await ctx.step("searching", async () => searchingStep(ctx, input));
    await ctx.step("cross-verification", async () => {
      await crossVerificationStep(ctx, input, sdcmp);
    });
  },
});

/**
 * Dedupe preserving first-seen order. Duplicate names would collide on the
 * name-derived itemId (`deriveItemId: item => item.name`); dedupe at the
 * CLI boundary so the kernel never sees two items with the same id.
 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) {
      log.warn(`Duplicate name skipped: "${n}"`);
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * CLI adapter for `tsx src/cli.ts eid-lookup <names...>`.
 *
 *   1. Validate inputs (>=1 name).
 *   2. Dry-run short-circuit: log the planned name list + CRM mode, exit 0
 *      without launching a browser.
 *   3. Dedupe duplicate names (warn + drop).
 *   4. Pick the right workflow definition based on `useCrm`.
 *   5. Delegate to runWorkflowBatch (shared-context-pool mode).
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

  const uniqueNames = dedupeNames(names);
  const items: EidLookupItem[] = uniqueNames.map((name) => ({ name }));
  const now = new Date().toISOString();
  const batchOpts = {
    poolSize: workers,
    deriveItemId: (item: unknown) => (item as EidLookupItem).name,
    onPreEmitPending: (item: unknown, runId: string) => {
      const n = (item as EidLookupItem).name;
      trackEvent({
        workflow: "eid-lookup",
        timestamp: now,
        id: n,
        runId,
        status: "pending",
        data: { searchName: n, __name: n, __id: n },
      });
    },
  };

  try {
    const result = useCrm
      ? await runWorkflowBatch(eidLookupCrmWorkflow, items, batchOpts)
      : await runWorkflowBatch(eidLookupWorkflow, items, batchOpts);
    log.success(
      `EID lookup complete: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
    );
  } catch (err) {
    log.error(`EID lookup failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
