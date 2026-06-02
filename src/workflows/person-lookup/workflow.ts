/**
 * Person Lookup workflow: resolve an employee in UCPath Person Org Summary by
 * name or EID, cross-verify names against CRM, and derive active / HDH status.
 *
 * Merges the former EID Lookup and Active Check workflows: name inputs run the
 * full searching → cross-verification → active-status chain; EID inputs skip
 * CRM cross-verification (the EID already identifies the person).
 *
 * Kernel-based (shared-context-pool mode). Each input-run batch launches one
 * UCPath browser (+ CRM browser), authenticates once per system, then fans out
 * N people across N tabs in each shared BrowserContext. One-person requests
 * are single rows; multi-person requests are grouped as batch-member rows by
 * the dashboard enqueue boundary.
 */

import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import type { Ctx } from "../../core/kernel/types.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../infra/auth/login.js";
import { buildOperatorSubject, operatorSubjectData } from "../../domain/operator-subject.js";
import { rootQueueTitleData } from "../../domain/queue-title.js";
import { personLookupStatusExtensions } from "../../domain/person-lookup-status.js";
import {
  deriveActiveCheckOutcome,
  resolvePersonLookupForEidLookup,
  type ActiveCheckOutcome,
} from "./outcome.js";
import { lookupPersonInUcpath } from "./lookup.js";
import {
  parsePersonOrgNameInput as parseNameInput,
  type EidResult,
} from "../../systems/ucpath/person-org-summary.js";
import {
  searchCrmByName,
  searchCrmByEidOrName,
  pickCrmStartDate,
  datesWithinDays,
  type CrmRecord,
} from "./crm-search.js";
import {
  PersonLookupItemSchema,
  derivePersonLookupItemId,
  displayPersonLookupInput,
  isEidInput,
  normalizeName,
  type PersonLookupItem,
} from "./schema.js";
import { prepareNames } from "../../domain/identity/person-name.js";

export interface LookupResult {
  name: string;
  found: boolean;
  sdcmpResults: EidResult[];
  error?: string;
}

const steps = ["searching", "cross-verification", "active-status", "crm-dates"] as const;

/** Direct input runs use normal utility defaults; OCR fan-out children title by person/EID. */
export const PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  // Delegated lookups (OCR EID-resolution fan-out) always render as a batch,
  // even when one record resolves — a lone delegated lookup stays a one-member
  // batch, not a standalone single. Direct one-person input runs are unaffected
  // (root rows, not delegated members), so they stay `single`.
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysBatchDelegatedMembers: true,
  },
};

/**
 * Perform the UCPath search for one item and stamp the result fields
 * onto the tracker entry's data. Branches on the input shape:
 *
 *  - `{ name }`   — multi-strategy SDCMP/HDH search, returns up to N
 *                   candidate rows (callers may cross-verify against CRM)
 *  - `{ emplId }` — direct Empl ID search, single result
 *
 * After either branch resolves to a detail page, captures a screenshot
 * and stamps the resulting filename onto the tracker row's
 * `personOrgScreenshot` data field.
 *
 * Returns the raw results so the CRM step can cross-reference them
 * (CRM cross-verification is skipped for EID-input items).
 */
async function searchingStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
  input: PersonLookupItem,
): Promise<EidResult[]> {
  const page = await ctx.page("ucpath");

  if (isEidInput(input)) {
    let lookup: Awaited<ReturnType<typeof lookupPersonInUcpath>>;
    try {
      lookup = await lookupPersonInUcpath(page, { kind: "by-eid", emplId: input.emplId });
    } catch (err) {
      log.error(`searchByEid failed for "${input.emplId}": ${errorMessage(err)}`);
      ctx.updateData({ emplId: input.emplId, hrStatus: "Error" });
      throw err;
    }
    const result = lookup.selection.selected;
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
    await ctx.captureAndStampScreenshot("person-org-summary", "personOrgScreenshot", {
      systems: ["ucpath"],
    });
    return lookup.results as EidResult[];
  }

  // Name-search path. The searching-state grid is only worth a screenshot when
  // nothing resolves (a not-found audit) — on success we capture the resolved
  // detail page instead, so the operator never sees the mid-search form.
  let lookup: Awaited<ReturnType<typeof lookupPersonInUcpath>>;
  try {
    lookup = await lookupPersonInUcpath(page, { kind: "by-name", name: input.name }, {
      keepNonHdh: input.keepNonHdh,
    });
  } catch (err) {
    log.error(`Search failed for "${input.name}": ${errorMessage(err)}`);
    ctx.updateData({ emplId: "Error" });
    throw err;
  }
  if (lookup.results.length === 0) {
    log.step(`No SDCMP results for "${input.name}"`);
    ctx.updateData({ emplId: "Not found" });
    await ctx.captureAndStampScreenshot(
      "person-org-summary-search-results",
      "personOrgSearchScreenshot",
      { systems: ["ucpath"] },
    );
    return [];
  }
  const first = lookup.selection.selected ?? lookup.results[0]!;
  log.success(
    `Found ${lookup.results.length} result(s) for "${input.name}": EID ${first.emplId} | ${first.department ?? "?"} | ${first.jobCodeDescription}`,
  );
  ctx.updateData({
    emplId: first.emplId,
    department: first.department ?? "",
    hrStatus: first.hrStatus,
    jobTitle: first.jobCodeDescription ?? "",
  });
  await ctx.captureAndStampScreenshot("person-org-summary", "personOrgScreenshot", {
    systems: ["ucpath"],
  });
  return lookup.results as EidResult[];
}

/** Split a UCPath-resolved "First [Middle] Last" name into CRM search parts. */
export function splitResolvedName(fullName: string): { lastName: string; firstName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { lastName: "", firstName: "" };
  if (parts.length === 1) return { lastName: parts[0]!, firstName: "" };
  return { lastName: parts[parts.length - 1]!, firstName: parts[0]! };
}

/**
 * Resolve the CRM cross-verification match for a name search against the
 * UCPath SDCMP candidates. Pure — drives `crmMatch` / `crmMatchedEmplId`:
 *  - "direct" — a CRM record's UCPath EID equals an SDCMP candidate's EID
 *  - "date"   — a CRM firstDayOfService is within ±7d of an SDCMP date
 *  - "none"   — CRM returned records but nothing matched
 */
export function matchCrmEid(
  sdcmp: EidResult[],
  crmRecords: CrmRecord[],
): { crmMatch: "direct" | "date" | "none"; crmMatchedEmplId?: string } {
  for (const crec of crmRecords) {
    if (!crec.ucpathEmployeeId) continue;
    const match = sdcmp.find((r) => r.emplId === crec.ucpathEmployeeId);
    if (match) return { crmMatch: "direct", crmMatchedEmplId: match.emplId };
  }
  for (const crec of crmRecords) {
    const crmDate = crec.firstDayOfService;
    if (!crmDate) continue;
    for (const ucRec of sdcmp) {
      const ucDate = ucRec.startDate || ucRec.effectiveDate;
      if (!ucDate) continue;
      if (datesWithinDays(crmDate, ucDate, 7)) {
        return { crmMatch: "date", crmMatchedEmplId: ucRec.emplId };
      }
    }
  }
  return { crmMatch: "none" };
}

/**
 * Stamp the operator-facing Start Date from CRM (First Day of Service) and, if
 * any CRM record was found, capture the CRM record page (not the search grid).
 * Start Date is CRM-only: it stays blank when CRM has no record or no date.
 */
async function stampCrmStartDateAndScreenshot<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
  crmRecords: CrmRecord[],
  resolvedEid?: string,
): Promise<void> {
  const startDate = pickCrmStartDate(crmRecords, resolvedEid);
  ctx.updateData({ startDate });
  if (crmRecords.length === 0) {
    log.step("CRM start date: no CRM record — Start Date left blank");
    return;
  }
  log.step(`CRM start date: "${startDate || "(none)"}" (EID ${resolvedEid || "?"})`);
  await ctx.captureAndStampScreenshot("crm-record", "crmRecordScreenshot", {
    systems: ["crm"],
  });
}

/**
 * Cross-verify against CRM and source the operator-facing Start Date (CRM First
 * Day of Service). Emits `crmMatch` for name inputs as one of:
 *  - "direct"   — UCPath EID matched a CRM record's UCPath EID
 *  - "date"     — UCPath effective date matched a CRM firstDayOfService (±7d)
 *  - "crm-only" — CRM had an EID but UCPath returned no SDCMP results
 *  - "none"     — CRM returned records but none matched
 *  - ""         — CRM returned no records for this name
 *
 * EID inputs skip name disambiguation (the EID already identifies the person)
 * and only fetch the CRM record — searching CRM by EID first, then by the
 * UCPath-resolved name — to stamp the Start Date.
 */
async function crossVerificationStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
  input: PersonLookupItem,
  sdcmp: EidResult[],
): Promise<void> {
  const crmPage = await ctx.page("crm");

  // EID inputs: search CRM by EID or name purely to source the Start Date.
  if (isEidInput(input)) {
    const { lastName, firstName } = splitResolvedName(String(ctx.data.searchName ?? ""));
    let crmRecords: CrmRecord[] = [];
    try {
      crmRecords = await searchCrmByEidOrName(crmPage, {
        emplId: input.emplId,
        lastName,
        firstName,
      });
    } catch (err) {
      log.error(`CRM start date: search failed for EID ${input.emplId} — ${errorMessage(err)}`);
    }
    await stampCrmStartDateAndScreenshot(ctx, crmRecords, input.emplId);
    return;
  }

  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(input.name);
  } catch (err) {
    log.error(`CRM cross-verify: invalid name "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "", startDate: "" });
    return;
  }

  let crmRecords: CrmRecord[];
  try {
    crmRecords = await searchCrmByName(crmPage, parsed.lastName, parsed.first);
  } catch (err) {
    log.error(`CRM cross-verify: search failed for "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "", startDate: "" });
    return;
  }

  if (crmRecords.length === 0) {
    log.step(`CRM: no records for "${input.name}"`);
    ctx.updateData({ crmMatch: "", startDate: "" });
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
      await stampCrmStartDateAndScreenshot(ctx, crmRecords, withEid.ucpathEmployeeId);
      return;
    }
    // CRM returned records but none had an EID — can't verify anything
    ctx.updateData({ crmMatch: "none" });
    await stampCrmStartDateAndScreenshot(ctx, crmRecords);
    return;
  }

  const { crmMatch, crmMatchedEmplId } = matchCrmEid(sdcmp, crmRecords);
  if (crmMatch === "direct") {
    log.success(`Direct EID match: ${crmMatchedEmplId}`);
  } else if (crmMatch === "date") {
    log.success(`Date match → EID ${crmMatchedEmplId}`);
  }
  ctx.updateData({ crmMatch, ...(crmMatchedEmplId ? { crmMatchedEmplId } : {}) });
  await stampCrmStartDateAndScreenshot(
    ctx,
    crmRecords,
    crmMatchedEmplId ?? String(ctx.data.emplId ?? ""),
  );
}

function stampActiveCheckFields<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
  outcome: ActiveCheckOutcome,
): void {
  ctx.updateData({
    activeStatus: outcome.activeStatus,
    hrStatus: outcome.hrStatus,
    department: outcome.department,
    ...(outcome.emplId ? { emplId: outcome.emplId } : {}),
    // Start Date is sourced from CRM (First Day of Service) in
    // cross-verification — do NOT write it here, or active-status (which runs
    // after cross-verification) would clobber the CRM value with UCPath's Last
    // Hire. Keep the UCPath date as backend-only context for audit.
    ucpathStartDate: outcome.startDate,
    effdt: outcome.effdt,
    terminationDate: outcome.terminationDate,
    expectedJobEndDate: outcome.expectedJobEndDate,
    isActive: String(outcome.isActive),
    isHdhAccepted: String(outcome.isHdhAccepted),
    candidateEids: outcome.candidateEids.join(", "),
  });
  if (outcome.activeStatus === "active") {
    log.success(`Person Lookup active status: ${outcome.emplId} is active (HDH)`);
  } else {
    log.step(`Person Lookup active status: ${outcome.searchName} → ${outcome.activeStatus}`);
  }
}

export function resolveActiveStatusResultsForPersonLookup(args: {
  input: PersonLookupItem;
  sdcmpFromSearch: EidResult[];
  crmMatchedEmplId?: string;
}): {
  deriveInput: { kind: "by-eid"; emplId: string } | { kind: "by-name"; name: string };
  results: EidResult[];
} {
  return resolvePersonLookupForEidLookup({
    input: isEidInput(args.input)
      ? { kind: "by-eid", emplId: args.input.emplId }
      : { kind: "by-name", name: args.input.name },
    sdcmpFromSearch: args.sdcmpFromSearch,
    crmMatchedEmplId: args.crmMatchedEmplId,
  }) as {
    deriveInput: { kind: "by-eid"; emplId: string } | { kind: "by-name"; name: string };
    results: EidResult[];
  };
}

/**
 * UCPath Person Org active / HDH disposition. Uses search results from
 * `searching`, except CRM-only matches where UCPath had no row — then loads
 * detail by CRM EID via the lookup primitive.
 */
async function activeStatusStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
  input: PersonLookupItem,
  sdcmpFromSearch: EidResult[],
): Promise<void> {
  const crmMatch = ctx.data.crmMatch as string | undefined;

  if (!isEidInput(input) && crmMatch === "crm-only") {
    const page = await ctx.page("ucpath");
    const eid = String(ctx.data.emplId ?? "").trim();
    if (!/^10\d{6}$/.test(eid)) {
      const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: eid }, []);
      stampActiveCheckFields(ctx, outcome);
      return;
    }
    const lookup = await lookupPersonInUcpath(page, { kind: "by-eid", emplId: eid });
    const results = lookup.results;
    await ctx.captureAndStampScreenshot("person-org-summary", "personOrgScreenshot", {
      systems: ["ucpath"],
    });
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: eid }, results);
    stampActiveCheckFields(ctx, outcome);
    return;
  }

  const { deriveInput, results } = resolveActiveStatusResultsForPersonLookup({
    input,
    sdcmpFromSearch,
    crmMatchedEmplId:
      typeof ctx.data.crmMatchedEmplId === "string" ? ctx.data.crmMatchedEmplId : undefined,
  });
  const outcome = deriveActiveCheckOutcome(deriveInput, results);
  stampActiveCheckFields(ctx, outcome);
}

/**
 * Opt-in CRM date enrichment step. Stamps `employmentDate` (CRM First Day of
 * Service) and `oathDate` (CRM Date Signed) onto the tracker row's data.
 *
 * Runs only when `input.includeCrmDates === true`; best-effort — never throws
 * and never fails the overall lookup.
 */
async function crmDatesStep<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, PersonLookupItem>,
): Promise<void> {
  const name = String(ctx.data.searchName ?? "").trim();
  if (!name) {
    log.step("CRM dates: no resolved name available — skipping");
    return;
  }

  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(name);
  } catch (err) {
    log.step(`CRM dates: could not parse name "${name}" — ${errorMessage(err)} — skipping`);
    return;
  }

  const crmPage = await ctx.page("crm");

  let crmRecords: Awaited<ReturnType<typeof searchCrmByName>>;
  try {
    crmRecords = await searchCrmByName(crmPage, parsed.lastName, parsed.first);
  } catch (err) {
    log.error(`CRM dates: search failed for "${name}" — ${errorMessage(err)}`);
    return;
  }

  if (crmRecords.length === 0) {
    log.step(`CRM dates: no record found for "${name}"`);
    return;
  }

  const resolvedEid = String(ctx.data.emplId ?? "").trim();
  const primary =
    (resolvedEid ? crmRecords.find((r) => r.ucpathEmployeeId === resolvedEid) : undefined)
    ?? crmRecords[0]!;

  ctx.updateData({
    employmentDate: primary.firstDayOfService ?? "",
    oathDate: primary.dateSigned ?? "",
  });
  log.success(
    `CRM dates: employment="${primary.firstDayOfService ?? ""}" oath="${primary.dateSigned ?? ""}"`,
  );
}

/**
 * Person Lookup kernel definition. Two systems (UCPath + CRM), four handler
 * steps: searching → cross-verification → active-status → crm-dates. CRM auth
 * is part of the batch's one-time auth chain; EID-input items skip the
 * cross-verification step at runtime; crm-dates is skipped unless
 * `input.includeCrmDates === true`.
 */
export const personLookupWorkflow = defineWorkflow({
  name: "person-lookup",
  label: "Person Lookup",
  archetype: "single",
  inputSubject: (input) => ("emplId" in input ? "eid" : "name"),
  statusExtensions: personLookupStatusExtensions,
  code: "pl",
  category: "Utils",
  iconName: "Search",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance, context) => {
        const ok = await loginToUCPath(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
    {
      id: "crm",
      login: async (page, instance, context) => {
        const ok = await loginToACTCrm(page, instance, context?.abortSignal);
        if (!ok) throw new Error("CRM authentication failed");
      },
    },
  ],
  authSteps: true,
  steps,
  schema: PersonLookupItemSchema,
  runtimePolicy: PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "searchName", label: "Search" },
    { key: "emplId", label: "EID" },
    { key: "department", label: "Dept" },
    { key: "hrStatus", label: "HR Status" },
    { key: "startDate", label: "Start Date" },
    { key: "terminationDate", label: "End Date" },
  ],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  operatorSubject: (input) =>
    isEidInput(input)
      ? buildOperatorSubject({ kind: "eid", value: input.emplId })
      : buildOperatorSubject({ kind: "person", value: input.name }),
  initialData: (input) =>
    isEidInput(input)
      ? { searchName: displayPersonLookupInput(input), emplId: input.emplId }
      : { searchName: normalizeName(input.name) },
  deriveItemId: derivePersonLookupItemId,
  handler: async (ctx: Ctx<typeof steps, PersonLookupItem>, input) => {
    if (!isEidInput(input)) {
      ctx.updateData({ searchName: normalizeName(input.name) });
    } else {
      ctx.updateData({ searchName: displayPersonLookupInput(input) });
    }
    const sdcmp = await ctx.step("searching", async () => searchingStep(ctx, input));
    // Cross-verification now runs for EID inputs too: even though the EID
    // already identifies the person, the step sources the operator-facing
    // Start Date from CRM (searching CRM by EID, then name).
    await ctx.step("cross-verification", async () => {
      await crossVerificationStep(ctx, input, sdcmp);
    });
    if (isEidInput(input)) {
      await ctx.step("active-status", async () => activeStatusStep(ctx, input, sdcmp));
      if (input.includeCrmDates !== true) {
        ctx.skipStep("crm-dates");
      } else {
        await ctx.step("crm-dates", async () => crmDatesStep(ctx));
      }
      return;
    }
    await ctx.step("active-status", async () => activeStatusStep(ctx, input, sdcmp));
    if (input.includeCrmDates !== true) {
      ctx.skipStep("crm-dates");
    } else {
      await ctx.step("crm-dates", async () => crmDatesStep(ctx));
    }
  },
});

export async function runPersonLookup(input: PersonLookupItem): Promise<void> {
  await runWorkflow(personLookupWorkflow, input);
}

export { dedupeNames, prepareNames } from "../../domain/identity/person-name.js";

/**
 * Internal daemon-mode adapter.
 *
 * Enqueues one `{name}` or `{emplId}` item per unique, normalized input to any
 * alive `person-lookup` daemon (or spawns one via `ensureDaemonsAndEnqueue`).
 * Keeps the UCPath + CRM browser session warm across batches so subsequent
 * items don't re-Duo.
 */
export const runPersonLookupCli = buildCliAdapter<[string[]], PersonLookupItem>({
  workflow: personLookupWorkflow,
  emptyMessage: "runPersonLookupCli: no names or EIDs provided",
  buildInputs: (names) => prepareNames(names).map((name) => ({ name })),
  deriveItemId: derivePersonLookupItemId,
  buildPendingData: (item, itemId) => {
    const n = "name" in item && item.name ? normalizeName(item.name) : ("emplId" in item ? item.emplId : "");
    const subject = personLookupWorkflow.config.operatorSubject?.(item);
    const parentSubject = "parentSubject" in item ? item.parentSubject : undefined;
    return {
      searchName: n,
      __name: n ?? "",
      __id: n ?? itemId,
      ...(parentSubject ? rootQueueTitleData(parentSubject) : {}),
      ...operatorSubjectData(subject),
    };
  },
});
