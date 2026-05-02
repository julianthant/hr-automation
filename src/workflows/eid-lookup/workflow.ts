/**
 * EID Lookup workflow: search employees by name in parallel tabs.
 *
 * Kernel-based (shared-context-pool mode). Each CLI invocation launches one
 * UCPath browser (+ CRM browser in CRM mode), authenticates once per system,
 * then fans out N names across N tabs in each shared BrowserContext. Each
 * name is a separate kernel item so the dashboard shows one row per name.
 */

import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/types.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { searchByName, searchByEid, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays } from "./crm-search.js";
import {
  EidLookupItemSchema,
  isEidInput,
  normalizeName,
  type EidLookupItem,
} from "./schema.js";

export interface LookupResult {
  name: string;
  found: boolean;
  sdcmpResults: EidResult[];
  error?: string;
}

const stepsCrm = ["searching", "cross-verification"] as const;

/**
 * Perform the UCPath search for one item and stamp the result fields
 * onto the tracker entry's data. Branches on the input shape:
 *
 *  - `{ name }`   — multi-strategy SDCMP/HDH search, returns up to N
 *                   candidate rows (callers may cross-verify against CRM)
 *  - `{ emplId }` — direct Empl ID search, single result; used by the
 *                   prep-flow verification path
 *
 * After either branch resolves to a detail page, captures a screenshot
 * via `ctx.screenshot({ kind: "form", label: "person-org-summary" })`
 * and stamps the resulting filename onto the tracker row's
 * `personOrgScreenshot` data field — the prep watcher reads it from
 * the eid-lookup JSONL to populate `verification.screenshotFilename`.
 *
 * Returns the raw results so the CRM step can cross-reference them
 * (CRM cross-verification is skipped for EID-input items — the prep
 * flow doesn't need it).
 */
async function searchingStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, EidLookupItem>,
  input: EidLookupItem,
): Promise<EidResult[]> {
  const page = await ctx.page("ucpath");

  if (isEidInput(input)) {
    let result: EidResult | null;
    try {
      result = await searchByEid(page, input.emplId);
    } catch (err) {
      log.error(`searchByEid failed for "${input.emplId}": ${errorMessage(err)}`);
      ctx.updateData({ emplId: input.emplId, hrStatus: "Error" });
      throw err;
    }
    if (!result) {
      log.step(`No detail page for EID ${input.emplId}`);
      ctx.updateData({ emplId: input.emplId, hrStatus: "Not found" });
      return [];
    }
    log.success(
      `EID ${result.emplId} resolved → ${result.name} | ${result.department ?? "?"} | ${result.hrStatus}`,
    );
    ctx.updateData({
      searchName: result.name,
      emplId: result.emplId,
      department: result.department ?? "",
      hrStatus: result.hrStatus,
      jobTitle: result.jobCodeDescription ?? "",
    });
    await captureAndStampScreenshot(ctx);
    return [result];
  }

  // Name-search path
  let result: Awaited<ReturnType<typeof searchByName>>;
  try {
    result = await searchByName(page, input.name, {
      keepNonHdh: input.keepNonHdh,
    });
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
    hrStatus: first.hrStatus,
    jobTitle: first.jobCodeDescription ?? "",
  });
  await captureAndStampScreenshot(ctx);
  return result.sdcmpResults;
}

/**
 * Capture the current Person Org Summary detail page and stamp the
 * resulting screenshot filename into the tracker row's data so the
 * prep watcher can find it. Best-effort — failures to screenshot are
 * logged and don't break the search step.
 */
async function captureAndStampScreenshot<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, EidLookupItem>,
): Promise<void> {
  try {
    const cap = await ctx.screenshot({
      kind: "form",
      label: "person-org-summary",
    });
    if (cap.files && cap.files.length > 0) {
      // Take the basename — matches how `/screenshots/<filename>` resolves.
      const fullPath = cap.files[0].path;
      const filename = fullPath.split("/").pop() ?? fullPath;
      ctx.updateData({ personOrgScreenshot: filename });
    }
  } catch (err) {
    log.warn(
      `Person Org screenshot failed: ${errorMessage(err)} — verification result will lack screenshotFilename`,
    );
  }
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
  // CRM cross-verification is name-based; EID-input items skip this step
  // entirely (the handler gates on isEidInput before scheduling it).
  if (isEidInput(input)) return;

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
 * CRM-on kernel definition. Two systems (UCPath + CRM), two handler steps.
 * Each item = one searched name with its own UCPath tab AND its own CRM tab.
 * Sequential auth chain — Duo ×1 UCPath then ×1 CRM, once for the whole pool.
 */
export const eidLookupCrmWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  category: "Utils",
  iconName: "Search",
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
  initialData: (input) =>
    isEidInput(input)
      ? { searchName: input.emplId, emplId: input.emplId }
      : { searchName: input.name },
  handler: async (ctx: Ctx<typeof stepsCrm, EidLookupItem>, input) => {
    if (!isEidInput(input)) {
      ctx.updateData({ searchName: input.name });
    }
    const sdcmp = await ctx.step("searching", async () => searchingStep(ctx, input));
    if (isEidInput(input)) {
      // Prep-flow verification path doesn't need CRM cross-check —
      // mark cross-verification as skipped to keep the dashboard
      // pipeline tidy.
      ctx.skipStep?.("cross-verification");
      return;
    }
    await ctx.step("cross-verification", async () => {
      await crossVerificationStep(ctx, input, sdcmp);
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
 * duplicates post-normalization. Applied at every CLI entry point so the
 * daemon-mode path feeds the search pipeline normalized strings.
 */
export function prepareNames(names: string[]): string[] {
  return dedupeNames(names.map((n) => normalizeName(n)));
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
 */
export async function runEidLookupCli(
  names: string[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (names.length === 0) {
    log.error("runEidLookupCli: no names provided");
    process.exitCode = 1;
    return;
  }

  const uniqueNames = prepareNames(names);

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
        // CLI adapter only enqueues `{ name }` items, but the workflow
        // schema accepts the union — narrow to the name shape we just
        // constructed at line `inputs.map((name) => ({ name }))`.
        const n = "name" in item ? item.name : item.emplId;
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
