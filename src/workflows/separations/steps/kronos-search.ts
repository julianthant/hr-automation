import { log } from "../../../utils/log.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  verifyTimecardEmployee as verifyNewKronosTimecardEmployee,
  setDateRange as setNewKronosDateRange,
  getSeparationTimecardData,
  mmddyyyyToDate,
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
  const okTimecard = await clickNewKronosGoToTimecard(page, eid);
  if (!okTimecard) {
    // The employee WAS found in New Kronos but the Go To → Timecard navigation
    // failed — a MECHANICAL failure, NOT "this person has no Kronos timecard".
    // Returning an empty timecard here used to SILENTLY fall the handler back to
    // the Kuali Last Day Worked for an HDH employee who DOES have a timecard (the
    // timecard is ground truth for the LDW), while the browser stayed on the
    // PREVIOUS employee's timecard. Fail loud instead so the operator sees it,
    // rather than masquerading as "no punches found". New Kronos runs in a
    // settled `ctx.parallel` block, so this throw is logged + non-fatal (the run
    // still completes on the Kuali fallback) — but it is now VISIBLE, not
    // swallowed. (2026-06-24)
    throw new Error(
      `[New Kronos] EID ${eid} was found but the Go To → Timecard navigation failed — ` +
      `could not open the timecard to read the last punch / sick / holiday days. ` +
      `Not silently using the Kuali dates for a found HDH employee.`,
    );
  }
  // Confirm the timecard that opened is THIS employee's — Go To → Timecard can
  // leave the PREVIOUS employee's timecard on screen (stale selection), and
  // reading that grid would attribute the wrong person's punches to this
  // separation (live bug: search 10603110 → Yang/10832819 still displayed,
  // 2026-06-24). Fail loud on a positive wrong-person signal. This throw is
  // logged + non-fatal in the settled parallel block (the run completes on the
  // Kuali fallback) but is now VISIBLE, not silently wrong.
  const idCheck = await verifyNewKronosTimecardEmployee(page, eid);
  if (!idCheck.ok) {
    throw new Error(
      `[New Kronos] EID ${eid}: the open timecard does not show this employee` +
      (idCheck.shownEid ? ` (it shows EID ${idCheck.shownEid})` : "") +
      ` — Go To → Timecard left a stale / wrong-person timecard up. ` +
      `Not reading the wrong person's punches.`,
    );
  }
  await page.waitForTimeout(3_000);
  await setNewKronosDateRange(page, kronosStart, kronosEnd);
  // Resolve grid dates against the SAME window the view was just set to —
  // formatTimecardDate picks the year that lands inside it (fail-loud on a
  // date outside the range), instead of stamping "now"'s year (the Dec→Jan
  // year bug).
  const timecard = await getSeparationTimecardData(page, {
    start: mmddyyyyToDate(kronosStart),
    end: mmddyyyyToDate(kronosEnd),
  });
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
  return result;
}
