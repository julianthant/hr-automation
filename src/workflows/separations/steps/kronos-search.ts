import type { Page } from "playwright";
import { log } from "../../../utils/log.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  setDateRange as setOldKronosDateRange,
  clickGoToTimecard as clickOldKronosGoToTimecard,
  getTimecardLastDate as getOldKronosTimecardLastDate,
} from "../../../systems/old-kronos/index.js";
import { modalDismiss } from "../../../systems/old-kronos/selectors.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getTimecardLastDate as getNewKronosTimecardLastDate,
} from "../../../systems/new-kronos/index.js";
import { getJobSummaryData } from "../../../systems/ucpath/index.js";
import { fillTimekeeperTasks } from "../../../systems/kuali/index.js";
import type { JobSummaryData } from "../../../systems/ucpath/index.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

/**
 * Helper: detect "No matches were found" modal on Old Kronos after an EID search
 * and dismiss it. Returns false when the modal appeared (i.e. EID not found).
 */
async function checkOldKronosResult(page: Page): Promise<boolean> {
  let found = true;
  for (const f of page.frames()) {
    const noMatch = await modalDismiss.noMatchesText(f).count().catch(() => 0);
    if (noMatch > 0) {
      found = false;
      try { await modalDismiss.okButton(f).click({ timeout: 3_000 }); } catch { /* ok */ }
      break;
    }
  }
  return found;
}

export type KronosSearchResult = {
  oldK: PromiseSettledResult<{ found: boolean; date: string | null }>;
  newK: PromiseSettledResult<{ found: boolean; date: string | null }>;
  jobSummary: PromiseSettledResult<JobSummaryData | undefined>;
  kualiTimekeeper: PromiseSettledResult<void>;
};

/**
 * Body of the `kronos-search` step.
 * Runs a 4-way parallel fetch: Old Kronos timecard, New Kronos timecard,
 * UCPath Job Summary, and Kuali timekeeper name fill.
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
  log.step("=== PHASE 1: Kronos + Job Summary + Kuali fill (parallel) ===");
  const result = await ctx.parallel({
    oldK: async () => {
      const page = await ctx.page("old-kronos");
      // Old Kronos: set date range FIRST, then search by ID
      const iframe = await getGeniesIframe(page);
      await dismissModal(page, iframe);
      await setOldKronosDateRange(page, iframe, kronosStart, kronosEnd);
      await searchOldKronos(page, iframe, kualiData.eid);
      await page.waitForTimeout(3_000);
      const found = await checkOldKronosResult(page);
      log.step(`[Old Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
      if (!found) return { found: false, date: null as string | null };
      await clickEmployeeRow(page, iframe, kualiData.eid);
      const okTimecard = await clickOldKronosGoToTimecard(page, iframe);
      if (!okTimecard) return { found: true, date: null as string | null };
      await page.waitForTimeout(3_000);
      await dismissModal(page, iframe);
      const date = await getOldKronosTimecardLastDate(page);
      return { found: true, date };
    },
    newK: async () => {
      const page = await ctx.page("new-kronos");
      // New Kronos: search by ID first, then go to timecard, then set date range
      const found = await searchNewKronos(page, kualiData.eid);
      log.step(`[New Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
      if (!found) return { found: false, date: null as string | null };
      await selectNewKronosResult(page);
      const okTimecard = await clickNewKronosGoToTimecard(page);
      if (!okTimecard) return { found: true, date: null as string | null };
      await page.waitForTimeout(3_000);
      await setNewKronosDateRange(page, kronosStart, kronosEnd);
      const date = await getNewKronosTimecardLastDate(page);
      return { found: true, date };
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
    + `oldK found=${result.oldK.status === "fulfilled"} `
    + `newK found=${result.newK.status === "fulfilled"} `
    + `jobSummary ok=${result.jobSummary.status === "fulfilled"} `
    + `kualiTimekeeper ok=${result.kualiTimekeeper.status === "fulfilled"}`,
  );
  return result as KronosSearchResult;
}
