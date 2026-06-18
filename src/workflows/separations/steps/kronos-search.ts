import { log } from "../../../utils/log.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getSeparationTimecardData,
} from "../../../systems/new-kronos/index.js";
import type { SeparationTimecardData } from "../../../systems/new-kronos/index.js";
import { getJobSummaryData } from "../../../systems/ucpath/index.js";
import { fillTimekeeperTasks } from "../../../systems/kuali/index.js";
import type { JobSummaryData } from "../../../systems/ucpath/index.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

/** New Kronos branch result: search outcome + parsed separation timecard data. */
export type NewKronosResult = { found: boolean } & SeparationTimecardData;

export type KronosSearchResult = {
  newK: PromiseSettledResult<NewKronosResult>;
  jobSummary: PromiseSettledResult<JobSummaryData | undefined>;
  kualiTimekeeper: PromiseSettledResult<void>;
};

const EMPTY_TIMECARD: SeparationTimecardData = {
  lastPunchDate: null,
  sickDates: [],
  holidayDates: [],
};

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
      // New Kronos: search by ID first, then go to timecard, set the date
      // range (computed from the Kuali separation date), then parse the
      // separation timecard data — last physical punch + sick / holiday days.
      const found = await searchNewKronos(page, kualiData.eid);
      log.step(`[New Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
      if (!found) return { found: false, ...EMPTY_TIMECARD };
      await selectNewKronosResult(page);
      const okTimecard = await clickNewKronosGoToTimecard(page);
      if (!okTimecard) return { found: true, ...EMPTY_TIMECARD };
      await page.waitForTimeout(3_000);
      await setNewKronosDateRange(page, kronosStart, kronosEnd);
      const timecard = await getSeparationTimecardData(page);
      return { found: true, ...timecard };
    },
    jobSummary: async (): Promise<JobSummaryData | undefined> => {
      const page = await ctx.page("ucpath");
      log.step("[UCPath] Starting Job Summary lookup...");
      // Throws with a clear "verify EID in Kuali" message if Workforce
      // Job Summary returns no results. No cross-source fallbacks —
      // wrong EIDs get surfaced, not silently corrected.
      return getJobSummaryData(page, kualiData.eid);
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
