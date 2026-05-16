import type { Dialog } from "playwright";
import { log } from "../../../utils/log.js";
import {
  openActionList,
  clickDocument,
  extractSeparationData,
  isVoluntaryTermination,
} from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

/**
 * Body of the `kuali-extraction` step.
 * Opens the Kuali action list, clicks the given docId, extracts separation
 * data, and calls ctx.updateData with extracted fields.
 */
export async function runKualiExtract(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  docId: string,
): Promise<Awaited<ReturnType<typeof extractSeparationData>>> {
  const t0 = Date.now();
  log.debug(`[Step: kuali-extraction] START docId='${docId}'`);
  const kualiPage = await ctx.page("kuali");
  // Auto-dismiss PeopleSoft dialogs on UCPath — important when a previous
  // doc's transaction leaves a confirmation modal up (batch mode state).
  // Registered per-invocation and removed in finally so batch mode doesn't
  // stack N handlers on the same long-lived page.
  const ucpathPage = await ctx.page("ucpath");
  const dialogHandler = (d: Dialog) => d.accept().catch(() => {});
  ucpathPage.on("dialog", dialogHandler);
  try {
    await openActionList(kualiPage);
    await clickDocument(kualiPage, docId);
    const result = await extractSeparationData(kualiPage);
    // Write extracted fields onto the tracker row BEFORE the step returns.
    // Anything that throws downstream (validateLastDayWorked, Kronos, Kuali
    // finalize, etc.) still leaves a populated detail grid instead of a row
    // of em-dashes. `rawTerminationType` is the un-mapped Kuali string —
    // edit-and-resume needs it for `mapReasonCode()` on the bypass path.
    ctx.updateData({
      name: result.employeeName,
      eid: result.eid,
      rawTerminationType: result.terminationType,
      separationDate: result.separationDate,
      lastDayWorked: result.lastDayWorked,
      terminationType: isVoluntaryTermination(result.terminationType) ? "Vol" : "Invol",
    });
    log.step(
      `[Step: kuali-extraction] END took=${Date.now() - t0}ms `
      + `employeeName='${result.employeeName}' eid='${result.eid}' `
      + `lastDayWorked='${result.lastDayWorked}' separationDate='${result.separationDate}'`,
    );
    return result;
  } finally {
    ucpathPage.off("dialog", dialogHandler);
  }
}
