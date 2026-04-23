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
import { loginToI9, lookupSection2Signer } from "../../systems/i9/index.js";
import { searchByName, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays } from "./crm-search.js";
import { EidLookupItemSchema, normalizeName, type EidLookupItem } from "./schema.js";

export interface EidLookupOptions {
  /** Number of parallel browser tabs. Default: min(names.length, 4). */
  workers?: number;
  /** Whether to run CRM cross-verification. Default: true. */
  useCrm?: boolean;
  /** Whether to run I-9 Section 2 signer lookup. Default: false. */
  useI9?: boolean;
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
const stepsI9 = ["searching", "i9-signer-lookup"] as const;
const stepsCrmI9 = ["searching", "cross-verification", "i9-signer-lookup"] as const;

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
  let result: Awaited<ReturnType<typeof searchByName>>;
  try {
    result = await searchByName(page, input.name);
  } catch (err) {
    log.error(`Search failed for "${input.name}": ${errorMessage(err)}`);
    ctx.updateData({ emplId: "Error" });
    throw err;
  }
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
 *  - "direct"   — UCPath EID matched a CRM record's UCPath EID
 *  - "date"     — UCPath effective date matched a CRM firstDayOfService (±7d)
 *  - "crm-only" — CRM had an EID but UCPath returned no SDCMP results
 *  - "none"     — CRM returned records but none matched
 *  - ""         — CRM returned no records for this name
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

  // CRM-only path: UCPath returned no SDCMP results but CRM has an EID.
  // This surfaces the CRM-sourced EID so the dashboard shows it instead of "Not found".
  if (sdcmp.length === 0) {
    const withEid = crmRecords.find((r) => r.ucpathEmployeeId);
    if (withEid) {
      log.success(`CRM-only EID: ${withEid.ucpathEmployeeId} (UCPath had no SDCMP match)`);
      ctx.updateData({
        emplId: withEid.ucpathEmployeeId,
        department: withEid.department ?? "",
        crmMatch: "crm-only",
      });
      return;
    }
    // CRM returned records but none had an EID — can't verify anything
    ctx.updateData({ crmMatch: "none" });
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
 * I-9 Section 2 signer lookup. Searches I9 Complete by last/first name,
 * navigates to the matched profile's Summary page, and reads the
 * "Signed Section 2" audit-trail row. Stamps two fields onto the tracker:
 *  - `i9Signer`   — the signer's name, or a human-readable status phrase
 *                   ("Not signed", "Historical", "Not found in I-9")
 *  - `i9Status`   — machine-readable status ("signed" | "unsigned" |
 *                   "historical" | "not-found" | "error")
 *
 * Name parsing mirrors `crossVerificationStep`: parse the "Last, First Middle"
 * input once and search by last + first. An invalid name emits `i9Status=error`
 * and leaves `i9Signer` as the parse error message.
 */
async function i9SignerStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, EidLookupItem>,
  input: EidLookupItem,
): Promise<void> {
  const i9Page = await ctx.page("i9");

  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(input.name);
  } catch (err) {
    const msg = errorMessage(err);
    log.error(`I9 signer: invalid name "${input.name}" — ${msg}`);
    ctx.updateData({ i9Status: "error", i9Signer: msg });
    return;
  }

  const result = await lookupSection2Signer(i9Page, {
    lastName: parsed.lastName,
    firstName: parsed.first,
  });

  // Map structured result → flat tracker fields. `i9Signer` always has a
  // non-empty string so the dashboard detail cell never renders as an
  // em-dash for a completed lookup — even when nobody signed.
  const signerLabel =
    result.status === "signed"
      ? result.signerName ?? "(unknown)"
      : result.status === "unsigned"
        ? "Not signed"
        : result.status === "historical"
          ? "Historical (paper)"
          : result.status === "not-found"
            ? "Not found in I-9"
            : result.detail ?? "Error";

  ctx.updateData({ i9Status: result.status, i9Signer: signerLabel });
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
  authSteps: true,
  steps: stepsNoCrm,
  schema: EidLookupItemSchema,
  tiling: "single",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
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
  authSteps: true,
  steps: stepsCrm,
  schema: EidLookupItemSchema,
  tiling: "auto",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
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
 * I9-on (no CRM) kernel definition. Two systems (UCPath + I9), two
 * handler steps. Each item = one searched name gets UCPath EID lookup and
 * an I-9 Section 2 signer check. Sequential auth: Duo ×1 UCPath then email+
 * password ×1 I9 (no Duo).
 */
export const eidLookupI9Workflow = defineWorkflow({
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
      id: "i9",
      login: async (page) => {
        const ok = await loginToI9(page);
        if (!ok) throw new Error("I9 authentication failed");
      },
    },
  ],
  authSteps: true,
  steps: stepsI9,
  schema: EidLookupItemSchema,
  tiling: "auto",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
    { key: "i9Signer", label: "Section 2 Signed By" },
    { key: "i9Status", label: "I-9 Status" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx: Ctx<typeof stepsI9, EidLookupItem>, input) => {
    ctx.updateData({ searchName: input.name });
    await ctx.step("searching", async () => {
      await searchingStep(ctx, input);
    });
    await ctx.step("i9-signer-lookup", async () => {
      await i9SignerStep(ctx, input);
    });
  },
});

/**
 * CRM + I9 kernel definition. Three systems (UCPath + CRM + I9), three
 * handler steps. Max-fidelity variant: cross-verifies CRM and also reports
 * who signed Section 2 on the I-9. Sequential auth: Duo ×1 UCPath, Duo ×1
 * CRM, email+password ×1 I9.
 */
export const eidLookupCrmI9Workflow = defineWorkflow({
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
    {
      id: "i9",
      login: async (page) => {
        const ok = await loginToI9(page);
        if (!ok) throw new Error("I9 authentication failed");
      },
    },
  ],
  authSteps: true,
  steps: stepsCrmI9,
  schema: EidLookupItemSchema,
  tiling: "auto",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
    { key: "crmMatch", label: "CRM Match" },
    { key: "i9Signer", label: "Section 2 Signed By" },
    { key: "i9Status", label: "I-9 Status" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx: Ctx<typeof stepsCrmI9, EidLookupItem>, input) => {
    ctx.updateData({ searchName: input.name });
    const sdcmp = await ctx.step("searching", async () => searchingStep(ctx, input));
    await ctx.step("cross-verification", async () => {
      await crossVerificationStep(ctx, input, sdcmp);
    });
    await ctx.step("i9-signer-lookup", async () => {
      await i9SignerStep(ctx, input);
    });
  },
});

/**
 * Dedupe preserving first-seen order. Duplicate names would collide on the
 * name-derived itemId (`deriveItemId: item => item.name`); dedupe at the
 * CLI boundary so the kernel never sees two items with the same id.
 *
 * Comparison is case-insensitive *after* `normalizeName` is applied upstream,
 * but we keep a belt-and-suspenders Set on the already-normalized strings.
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
 * Normalize every input name to "Last, First Middle" title-case + dedupe
 * duplicates post-normalization. Applied at every CLI entry point
 * (`runEidLookup`, `runEidLookupCli`) so both the legacy in-process path
 * and the daemon-mode path feed the search pipeline identical strings.
 */
export function prepareNames(names: string[]): string[] {
  return dedupeNames(names.map((n) => normalizeName(n)));
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
  const useI9 = options.useI9 === true;
  const workers = options.workers ?? Math.min(names.length, 4);

  const uniqueNames = prepareNames(names);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(`CRM cross-verification: ${useCrm ? "ON" : "OFF"}`);
    log.step(`I-9 Section 2 signer lookup: ${useI9 ? "ON" : "OFF"}`);
    log.step(`Workers: ${workers}`);
    log.step(`Names (${uniqueNames.length} after normalize + dedupe):`);
    for (const n of uniqueNames) log.step(`  - ${n}`);
    log.success("Dry run complete — no browser launched, no UCPath/CRM/I9 contact made");
    return;
  }

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

  // Pick the workflow definition based on the 2×2 of {CRM, I9} flags and
  // dispatch in-branch so each call typechecks against its own `steps` tuple
  // (the four definitions have different `readonly string[]` shapes, so a
  // unified variable would widen to a union TypeScript can't narrow).
  try {
    const result =
      useCrm && useI9
        ? await runWorkflowBatch(eidLookupCrmI9Workflow, items, batchOpts)
        : useCrm
          ? await runWorkflowBatch(eidLookupCrmWorkflow, items, batchOpts)
          : useI9
            ? await runWorkflowBatch(eidLookupI9Workflow, items, batchOpts)
            : await runWorkflowBatch(eidLookupWorkflow, items, batchOpts);
    log.success(
      `EID lookup complete: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
    );
  } catch (err) {
    log.error(`EID lookup failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Daemon-mode CLI adapter for `npm run eid-lookup <names...>`.
 *
 * Mirrors `runSeparationCli` / `runWorkStudyCli`: enqueues one `{name}` item
 * per unique, normalized name to any alive `eid-lookup` daemon (or spawns
 * one via `ensureDaemonsAndEnqueue`). Keeps the UCPath + CRM browser session
 * warm across batches so subsequent names don't re-Duo.
 *
 * Constraints baked into this adapter:
 *   - The daemon's `Session` is launched with a fixed systems list at spawn
 *     time, so only ONE workflow variant can run per daemon. We hard-wire
 *     `eidLookupCrmWorkflow` (UCPath + CRM, no I-9) as the daemon default —
 *     that's the flag combo the `eid-lookup` CLI command uses when no flags
 *     are passed.
 *   - `--no-crm` (UCPath-only) and `--i9` (adds I-9) change the systems
 *     list, so those flag combos route to `runEidLookup` (legacy
 *     in-process path) instead of the daemon. The CLI wiring in
 *     `src/cli.ts` enforces this.
 *   - `--dry-run` still bypasses the daemon entirely (no browser, no
 *     spawn) — normalized name list is printed and we exit 0.
 */
export async function runEidLookupCli(
  names: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (names.length === 0) {
    log.error("runEidLookupCli: no names provided");
    process.exitCode = 1;
    return;
  }

  const uniqueNames = prepareNames(names);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE (daemon) ===");
    log.step(`Names (${uniqueNames.length} after normalize + dedupe):`);
    for (const n of uniqueNames) log.step(`  - ${n}`);
    log.success("Dry run complete — no browser launched, no daemon spawned");
    return;
  }

  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const inputs = uniqueNames.map((name) => ({ name }));
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    eidLookupCrmWorkflow,
    inputs,
    {
      new: options.new,
      parallel: options.parallel,
    },
    {
      // Match the existing `runEidLookupBatch` pre-emit payload so the
      // dashboard queue panel shows the same `{searchName, __name, __id}`
      // shape whether the user runs the daemon CLI or `--direct`. The
      // runId here is the pre-assigned one from `enqueueItems`, so the
      // eventual running/done rows pair 1:1.
      onPreEmitPending: (item, runId) => {
        const n = item.name;
        trackEvent({
          workflow: "eid-lookup",
          timestamp: now,
          id: n,
          runId,
          status: "pending",
          data: { searchName: n, __name: n, __id: n },
        });
      },
    },
  );
}
