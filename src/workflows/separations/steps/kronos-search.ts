import { log } from "../../../utils/log.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getSeparationTimecardData,
} from "../../../systems/new-kronos/index.js";
import type { SeparationTimecardData } from "../../../systems/new-kronos/index.js";
import { fillTimekeeperTasks } from "../../../systems/kuali/index.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";
import type { Page } from "playwright";

/** New Kronos branch result: search outcome + parsed separation timecard data. */
export type NewKronosResult = { found: boolean } & SeparationTimecardData;

export type KronosSearchResult = {
  newK: PromiseSettledResult<NewKronosResult>;
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
 * Runs a 2-way parallel fetch: New Kronos timecard (last physical punch +
 * sick/holiday days) and Kuali timekeeper name fill. Returns the ctx.parallel
 * result for the caller to process.
 *
 * The UCPath Job Summary fetch is NOT here — it moved to an inline read before
 * the `identity-check` step (which now runs BEFORE this one), so identity
 * verification + EID correction happen before the timecard is read with the
 * verified EID. See the separations handler.
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
  log.step("=== PHASE 1: New Kronos + Kuali timekeeper fill (parallel) ===");
  const result = await ctx.parallel({
    newK: async (): Promise<NewKronosResult> => {
      const page = await ctx.page("new-kronos");
      // New Kronos: search by ID, go to timecard, set the date range (from the
      // Kuali separation date), parse the separation timecard — last physical
      // punch + sick / holiday days.
      return runNewKronosTimecard(page, kualiData.eid, kronosStart, kronosEnd);
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
    + `kualiTimekeeper ok=${result.kualiTimekeeper.status === "fulfilled"}`,
  );
  return result as KronosSearchResult;
}
