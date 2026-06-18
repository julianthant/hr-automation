import { log } from "../../../utils/log.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getSeparationTimecardData,
} from "../../../systems/new-kronos/index.js";
import type { SeparationTimecardData } from "../../../systems/new-kronos/index.js";
import { getJobSummaryIdentity } from "../../../systems/ucpath/index.js";
import { fillTimekeeperTasks } from "../../../systems/kuali/index.js";
import type { JobSummaryIdentity } from "../../../systems/ucpath/index.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";
import type { Page } from "playwright";

/** New Kronos branch result: search outcome + parsed separation timecard data. */
export type NewKronosResult = { found: boolean } & SeparationTimecardData;

export type KronosSearchResult = {
  newK: PromiseSettledResult<NewKronosResult>;
  jobSummary: PromiseSettledResult<JobSummaryIdentity>;
  kualiTimekeeper: PromiseSettledResult<void>;
};

const EMPTY_TIMECARD: SeparationTimecardData = {
  lastPunchDate: null,
  sickDates: [],
  holidayDates: [],
};

/**
 * New Kronos search → timecard parse for one EID. Extracted so the
 * `kronos-search` parallel block AND the identity-check re-fetch (after a
 * person-lookup EID correction) share one code path. Never throws on a
 * not-found EID — returns an empty timecard with `found: false` so the caller
 * falls back to the Kuali Last Day Worked.
 */
export async function runNewKronosTimecard(
  page: Page,
  eid: string,
  kronosStart: string,
  kronosEnd: string,
): Promise<NewKronosResult> {
  const found = await searchNewKronos(page, eid);
  log.step(`[New Kronos] EID ${eid}: ${found ? "FOUND" : "NOT FOUND"}`);
  if (!found) return { found: false, ...EMPTY_TIMECARD };
  await selectNewKronosResult(page);
  const okTimecard = await clickNewKronosGoToTimecard(page);
  if (!okTimecard) return { found: true, ...EMPTY_TIMECARD };
  await page.waitForTimeout(3_000);
  await setNewKronosDateRange(page, kronosStart, kronosEnd);
  const timecard = await getSeparationTimecardData(page);
  return { found: true, ...timecard };
}

/**
 * Body of the `kronos-search` step.
 * Runs a 3-way parallel fetch: New Kronos timecard (last physical punch +
 * sick/holiday days), UCPath Job Summary, and Kuali timekeeper name fill.
 * Returns the ctx.parallel result for the caller to process.
 */
export async function runKronosSearch(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  kualiData: KualiSeparationData,
  kronosStart: string,
  kronosEnd: string,
  timekeeperName: string,
): Promise<KronosSearchResult> {
  const t0 = Date.now();
  log.debug(`[Step: kronos-search] START eid='${kualiData.eid}'`);
  log.step("=== PHASE 1: New Kronos + Job Summary + Kuali fill (parallel) ===");
  const result = await ctx.parallel({
    newK: async (): Promise<NewKronosResult> => {
      const page = await ctx.page("new-kronos");
      // New Kronos: search by ID, go to timecard, set the date range (from the
      // Kuali separation date), parse the separation timecard — last physical
      // punch + sick / holiday days. Shared with the identity-check re-fetch.
      return runNewKronosTimecard(page, kualiData.eid, kronosStart, kronosEnd);
    },
    jobSummary: async (): Promise<JobSummaryIdentity> => {
      const page = await ctx.page("ucpath");
      log.step("[UCPath] Starting Job Summary lookup...");
      // Identity-aware, NON-throwing on a missing EID: returns `found: false`
      // so the handler's identity-check can branch (fall back to person-lookup
      // for a short EID, or fail loud for a full-8-digit miss). Reads the
      // detail-page NAME on a hit so the handler can confirm the EID resolved
      // to the expected person. Genuine selector/nav failures still throw.
      return getJobSummaryIdentity(page, kualiData.eid);
    },
    kualiTimekeeper: async () => {
      const page = await ctx.page("kuali");
      log.step("[Kuali] Filling timekeeper name...");
      await fillTimekeeperTasks(page, timekeeperName);
      log.success("[Kuali] Timekeeper name filled");
    },
  });
  log.step(
    `[Step: kronos-search] END took=${Date.now() - t0}ms `
    + `newK found=${result.newK.status === "fulfilled"} `
    + `jobSummary ok=${result.jobSummary.status === "fulfilled"} `
    + `kualiTimekeeper ok=${result.kualiTimekeeper.status === "fulfilled"}`,
  );
  return result as KronosSearchResult;
}
