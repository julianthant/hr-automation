import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { classifyPlaywrightError } from "../../utils/errors.js";
import { defineWorkflow } from "../../core/index.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";

// Auth wrappers — split into prepare (nav + fill) + submit (click + Duo)
// phases so Session.launch can pre-fill every SSO form in parallel before
// the serial Duo chain begins.
import {
  kualiNavigateAndFill,
  kualiSubmitAndWaitForDuo,
  ukgNavigateAndFill,
  ukgSubmitAndWaitForDuo,
  ucpathNavigateAndFill,
  ucpathSubmitAndWaitForDuo,
  newKronosNavigateAndFill,
  newKronosSubmitAndWaitForDuo,
} from "../../infra/auth/login.js";

// Kuali module
import {
  isVoluntaryTermination,
  fillTimekeeperTasks,
  updateLastDayWorked,
  updateSeparationDate,
} from "../../systems/kuali/index.js";
import type { KualiSeparationData } from "../../systems/kuali/index.js";

// New Kronos (used for post-search scroll)
import {
  scrollNewKronosTimecardToDate,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";

// UCPath (used for jobSummary result resolution)
import type { JobSummaryData } from "../../systems/ucpath/index.js";

import {
  computeTerminationEffDate,
  computeKronosDateRange,
  buildTerminationComments,
  resolveKronosDates,
  mapReasonCode,
  validateLastDayWorked,
} from "./schema.js";
import {
  KUALI_SPACE_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
} from "./config.js";
import { PATHS, UCPATH_SMART_HR_URL } from "../../config.js";
import { getProcessIsolatedSessionDir } from "../../core/kernel/session.js";

// Step functions
import { runKualiExtract } from "./steps/kuali-extract.js";
import { runKronosSearch } from "./steps/kronos-search.js";
import { runUcpathJobSummary } from "./steps/ucpath-job-summary.js";
import { runUcpathTransaction } from "./steps/ucpath-transaction.js";
import { runKualiFinalize } from "./steps/kuali-finalize.js";

/** Input schema for the separations kernel workflow — only docId from the CLI. */
const SeparationInputSchema = z.object({
  docId: z.string().min(1),
});
export type SeparationInput = z.infer<typeof SeparationInputSchema>;

const separationsSteps = [
  "kuali-extraction",
  "kronos-search",
  "ucpath-job-summary",
  "ucpath-transaction",
  "kuali-finalization",
] as const;

/**
 * Kernel definition for the separations workflow.
 *
 * 4 systems, parallel-staggered auth: every browser's SSO form is pre-filled
 * in parallel via `prepareLogin`, then submit clicks fire 5 seconds apart
 * (Kuali at t=0, Old Kronos at t=5s, New Kronos at t=10s, UCPath at t=15s).
 * All 4 Duo prompts pend on the user's phone simultaneously — the user can
 * approve them in any order. `ctx.page(id)` awaits each system's ready
 * promise, so phase-1 tasks start as soon as their individual Duo clears
 * (in approval order, not click order).
 *
 * Phase 1 (`kronos-search`) runs 4 tasks in parallel via `ctx.parallel`:
 *   - Old Kronos timecard search
 *   - New Kronos timecard search
 *   - UCPath Job Summary lookup
 *   - Kuali timekeeper name fill
 * Each task `await ctx.page(id)` first to block on its system's auth.
 *
 * Phase 2 (`ucpath-job-summary`): Kronos date resolution + Kuali term date / dept fill.
 * Phase 3 (`ucpath-transaction`): Smart HR UC_VOL_TERM or UC_INVOL_TERM.
 * Phase 4 (`kuali-finalization`): write txn number back, fill date-change comments, save.
 *
 * Batch mode (`runWorkflowBatch` sequential): the kernel calls `session.reset(id)`
 * between docs, which navigates each system's `resetUrl` so the next doc starts
 * from a clean page state.
 */

export function resolveJobSummaryResult(
  result: PromiseSettledResult<JobSummaryData | undefined>,
): JobSummaryData | undefined {
  if (result.status === "fulfilled") return result.value;
  throw new Error(`UCPath Job Summary extraction failed: ${errorMessage(result.reason)}`);
}

export const separationsWorkflow = defineWorkflow({
  name: "separations",
  label: "Separations",
  category: "Separations",
  iconName: "UserMinus",
  systems: [
    {
      id: "kuali",
      prepareLogin: async (page) => {
        const prep = await kualiNavigateAndFill(page, KUALI_SPACE_URL);
        if (prep === false) throw new Error("Kuali prepareLogin failed");
      },
      login: async (page, instance, context) => {
        const ok = await kualiSubmitAndWaitForDuo(
          page,
          KUALI_SPACE_URL,
          instance,
          context?.abortSignal,
        );
        if (!ok) throw new Error("Kuali authentication failed");
      },
      resetUrl: KUALI_SPACE_URL,
    },
    {
      id: "old-kronos",
      prepareLogin: async (page) => {
        const prep = await ukgNavigateAndFill(page);
        if (prep === false) throw new Error("UKG prepareLogin failed");
      },
      login: async (page, instance, context) => {
        const ok = await ukgSubmitAndWaitForDuo(page, instance, context?.abortSignal);
        if (!ok) throw new Error("Old Kronos (UKG) authentication failed");
      },
      sessionDir: getProcessIsolatedSessionDir(PATHS.ukgSessionSep),
    },
    {
      id: "new-kronos",
      prepareLogin: async (page) => {
        const prep = await newKronosNavigateAndFill(page);
        if (prep === false) throw new Error("New Kronos prepareLogin failed");
      },
      login: async (page, instance, context) => {
        const ok = await newKronosSubmitAndWaitForDuo(page, instance, context?.abortSignal);
        if (!ok) throw new Error("New Kronos authentication failed");
      },
      resetUrl: NEW_KRONOS_URL,
    },
    {
      id: "ucpath",
      prepareLogin: async (page) => {
        const prep = await ucpathNavigateAndFill(page);
        if (!prep) throw new Error("UCPath prepareLogin failed");
      },
      login: async (page, instance, context) => {
        const ok = await ucpathSubmitAndWaitForDuo(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
      resetUrl: UCPATH_SMART_HR_URL,
    },
  ],
  steps: separationsSteps,
  schema: SeparationInputSchema,
  authChain: "parallel-staggered",
  batch: {
    mode: "sequential",
    betweenItems: ["reset"],
  },
  // EID is the dashboard's "Copy from prior run" lookup key. When an
  // operator opens the Edit Data tab on a row whose `data.eid` is
  // populated, the EditDataTab surfaces past separations runs sharing
  // that EID (across different doc IDs) so the operator can pull the
  // earlier run's extracted/edited values forward instead of typing
  // them again.
  matchKey: "eid",
  detailFields: [
    { key: "name",              label: "Employee",        editable: true                          },
    { key: "eid",               label: "EID",             editable: true                          },
    { key: "docId",             label: "Doc ID"                                                   },
    { key: "terminationType",   label: "Term Type"                                                }, // computed (Vol/Invol) — display only
    // separationDate stays editable for edit-and-resume but doesn't show in
    // the LogPanel detail grid — keeps the grid focused on identifiers.
    { key: "separationDate",    label: "Sep Date",        editable: true, displayInGrid: false    },
    { key: "lastDayWorked",     label: "Last Day Worked", editable: true                          },
    { key: "transactionNumber", label: "Txn #",           editable: true                          },
    // Free-form Kuali timekeeper-comments override. Edit-and-resume only —
    // not surfaced in the LogPanel detail grid. `fillTimekeeperComments` is
    // append-aware: existing field content is preserved + a newline-joined
    // append is filled.
    { key: "comments",          label: "Comments",        editable: true, displayInGrid: false, multiline: true },
    // `rawTerminationType` is intentionally NOT in detailFields — it's an
    // internal field used to reconstruct kualiData on the edit-and-resume
    // bypass path, not meant for the user. The kernel still stores it in
    // ctx.data via updateData; the run-with-data backend merges the
    // previous run's full data into prefilledData so non-editable fields
    // (rawTerminationType, terminationType) carry over.
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.docId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "document", value: input.docId, prefix: "Separation" }),
  handler: async (ctx, input) => {
    const { docId } = input;

    // Stamp docId immediately so the dashboard row shows it from step 1.
    ctx.updateData({ docId });

    // Capture edit-and-resume skip flags BEFORE any step runs. After
    // kuali-extraction completes, ctx.data.lastDayWorked is populated
    // unconditionally — these flags must be read at handler entry to
    // distinguish "user prefilled this" from "extraction filled this".
    const lastDayWorkedPrefilled =
      typeof ctx.data.lastDayWorked === "string"
      && (ctx.data.lastDayWorked as string).length > 0;
    const txnNumberPrefilled =
      typeof ctx.data.transactionNumber === "string"
      && (ctx.data.transactionNumber as string).length > 0;

    // ─── Step 1: Extract Kuali data ───
    // Kuali docs are user-editable between runs (e.g. correcting a wrong EID
    // after a failed first pass). Caching the extraction would serve stale
    // values on retry, so always re-read. See
    // docs/superpowers/specs/2026-04-23-daemon-isolation-and-separations-stability-design.md
    // Part 1.2 for the general caching rule (write-once / non-user-editable only).
    //
    // Edit-and-resume bypass: if every required field is already in
    // ctx.data (the dashboard's "Run with these values" path pre-merges
    // them via the kernel's prefilledData channel — including non-
    // editable fields carried over from the previous run's data, see
    // buildRunWithDataHandler), skip the extraction step entirely and
    // synthesize a kualiData object from those values. The downstream
    // code path is unchanged — it reads from kualiData, which now
    // mirrors what extraction would have returned.
    //
    // `rawTerminationType` is required (downstream `mapReasonCode` reads
    // it) but isn't surfaced as an editable field — it carries over from
    // the previous run's data via the run-with-data merge.
    // `rawTerminationType` is consumed only by `mapReasonCode`, which lives
    // inside the `ucpath-transaction` step. When that step is being skipped
    // (txn # prefilled — pure Kuali-finalization retry path), the field is
    // not load-bearing, so drop it from the bypass requirement. This makes
    // edit-and-resume robust against cancel-queued / save-data lineage that
    // can drop internal fields between runs.
    const requiredKualiFields = txnNumberPrefilled
      ? (["name", "eid", "separationDate", "lastDayWorked"] as const)
      : (["name", "eid", "rawTerminationType", "separationDate", "lastDayWorked"] as const);
    const allPrefilled = requiredKualiFields.every(
      (k) => typeof ctx.data[k] === "string" && (ctx.data[k] as string).length > 0,
    );

    let kualiData: KualiSeparationData;
    if (allPrefilled) {
      ctx.skipStep("kuali-extraction");
      log.step(
        `[Step: kuali-extraction] SKIPPED — using manual input from edit-data ` +
        `(name='${ctx.data.name}' eid='${ctx.data.eid}' ` +
        `lastDayWorked='${ctx.data.lastDayWorked}' separationDate='${ctx.data.separationDate}'` +
        (txnNumberPrefilled ? `; txn # prefilled — rawTerminationType not required)` : `)`),
      );
      kualiData = {
        employeeName: ctx.data.name as string,
        eid: ctx.data.eid as string,
        // Fall back chain: raw Kuali string → display-only "Vol"/"Invol" → empty.
        // The empty fallback is only reachable on the txnNumberPrefilled path
        // where mapReasonCode (the only consumer) won't run.
        terminationType:
          (ctx.data.rawTerminationType as string | undefined) ??
          (ctx.data.terminationType as string | undefined) ??
          "",
        separationDate: ctx.data.separationDate as string,
        lastDayWorked: ctx.data.lastDayWorked as string,
        // `location` isn't read downstream — empty string is safe and keeps
        // the synthesized object structurally compatible with KualiSeparationData.
        location: "",
      };
    } else {
      kualiData = await ctx.step("kuali-extraction", () => runKualiExtract(ctx, docId));
    }

    // Preflight: reject future-dated separations so we don't waste Kronos/UCPath
    // work on a record that isn't yet actionable. Both Last Day Worked and
    // Separation Date are checked because either can be post-dated by the
    // requester.
    validateLastDayWorked(kualiData.lastDayWorked, "Last Day Worked");
    validateLastDayWorked(kualiData.separationDate, "Separation Date");

    const isVol = isVoluntaryTermination(kualiData.terminationType);
    const termEffDate = computeTerminationEffDate(kualiData.separationDate);
    const ucpathReason = mapReasonCode(kualiData.terminationType);
    const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
    const timekeeperName = process.env.NAME ?? "";

    log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
    log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
    log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
    log.step(`Termination effective date: ${termEffDate} (separation date ${kualiData.separationDate} + 1 day)`);
    log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
    log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

    // ─── Step 4: kronos-search (4-way parallel) ───
    const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
      kualiData.lastDayWorked, kualiData.separationDate,
    );
    log.step(`[Old Kronos / New Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

    // ─── Process Phase 1 results (preserve PromiseSettledResult fallback semantics) ───
    let oldKronosDate: string | null = null;
    let newKronosDate: string | null = null;
    let oldKronosFound = false;
    let newKronosFound = false;
    let jobSummaryData: JobSummaryData | undefined;

    if (lastDayWorkedPrefilled) {
      // Edit-and-resume: user has supplied lastDayWorked — skip Kronos
      // verification entirely. Job Summary lookup + Kuali timekeeper-name
      // fill are also bypassed; both run on the original pass and either
      // already filled the form (subsequent retry) or are non-fatal if
      // missing (step 4 dept/payroll fill no-ops on undefined jobSummaryData;
      // timekeeper name is filled here as a best-effort to keep the form
      // complete on resume).
      ctx.skipStep("kronos-search");
      log.step(
        `[Step: kronos-search] SKIPPED — using manual input from edit-data ` +
        `(lastDayWorked='${ctx.data.lastDayWorked}' — Kronos verification not needed)`,
      );
      try {
        const kp = await ctx.page("kuali");
        await fillTimekeeperTasks(kp, timekeeperName);
        log.success("[Kuali] Timekeeper name filled (kronos-search skip path)");
      } catch (e) {
        log.warn(`[Kuali] timekeeper-name fill failed during kronos-search skip: ${errorMessage(e)}`);
      }
    } else {
    const phase1 = await ctx.step("kronos-search", () =>
      runKronosSearch(ctx, kualiData, kronosStart, kronosEnd, timekeeperName),
    );

    if (phase1.oldK.status === "fulfilled") {
      oldKronosFound = phase1.oldK.value.found;
      oldKronosDate = phase1.oldK.value.date;
    } else {
      const classified = classifyPlaywrightError(phase1.oldK.reason);
      log.error(`[Old Kronos] ${classified.kind}: ${classified.summary}`);
      log.debug(`[Old Kronos] full error: ${errorMessage(phase1.oldK.reason)}`);
    }
    if (phase1.newK.status === "fulfilled") {
      newKronosFound = phase1.newK.value.found;
      newKronosDate = phase1.newK.value.date;
    } else {
      const classified = classifyPlaywrightError(phase1.newK.reason);
      log.error(`[New Kronos] ${classified.kind}: ${classified.summary}`);
      log.debug(`[New Kronos] full error: ${errorMessage(phase1.newK.reason)}`);
    }
    if (phase1.jobSummary.status === "rejected") {
      const classified = classifyPlaywrightError(phase1.jobSummary.reason);
      log.error(`[UCPath Job Summary] ${classified.kind}: ${classified.summary}`);
      log.debug(`[UCPath Job Summary] full error: ${errorMessage(phase1.jobSummary.reason)}`);
    }
    // resolveJobSummaryResult throws on rejection (classified log emitted above);
    // no duplicate log.error here — the rejection is fatal and the throw propagates.
    jobSummaryData = resolveJobSummaryResult(phase1.jobSummary);
    if (phase1.kualiTimekeeper.status === "rejected") {
      const classified = classifyPlaywrightError(phase1.kualiTimekeeper.reason);
      log.error(`[Kuali Timekeeper] ${classified.kind}: ${classified.summary}`);
      log.debug(`[Kuali Timekeeper] full error: ${errorMessage(phase1.kualiTimekeeper.reason)}`);
    }

    log.step(`[Old Kronos] ${oldKronosFound ? "Found" : "Not found"} (${oldKronosDate ?? "no time"})`);
    log.step(`[New Kronos] ${newKronosFound ? "Found" : "Not found"} (${newKronosDate ?? "no time"})`);
    } // end !lastDayWorkedPrefilled branch

    // ─── Resolve Kronos dates (Kronos overrides Kuali — ground truth) ───
    const resolved = resolveKronosDates(
      kualiData.lastDayWorked, kualiData.separationDate,
      oldKronosDate, newKronosDate,
    );

    const prefilledOverridesKuali =
      lastDayWorkedPrefilled &&
      (ctx.data.lastDayWorked as string | undefined) !== kualiData.lastDayWorked;
    const chosenDateSource = prefilledOverridesKuali
      ? "Operator-prefilled (overrides Kuali)"
      : resolved.changed
        ? (oldKronosDate && newKronosDate
            ? (oldKronosDate >= newKronosDate ? "Old Kronos" : "New Kronos")
            : (oldKronosDate ? "Old Kronos" : "New Kronos"))
        : "Kuali (no change)";
    log.step(`[Old Kronos / New Kronos] Resolved dates — using ${chosenDateSource}`);

    // Position the New Kronos timecard view so the chosen Last Day Worked
    // is the topmost visible row. Any error screenshot taken later in the
    // run (handler-throw in ucpath-transaction / kuali-finalization) will
    // then show the operator the chosen date + every row after it, so they
    // can verify "was there actually a later date that should have been
    // picked?" without opening the Kronos browser themselves. Best-effort —
    // a scroll failure here must not disrupt the rest of the run.
    try {
      const newKronosPage = await ctx.page("new-kronos");
      await scrollNewKronosTimecardToDate(newKronosPage, resolved.lastDayWorked);
    } catch { /* best-effort */ }

    // Early-populate separationDate so the dashboard shows it as soon as
    // Kronos reconciliation completes (not only after the transaction submits).
    ctx.updateData({ separationDate: resolved.separationDate, terminationType: isVol ? "Vol" : "Invol" });

    const kualiPage = await ctx.page("kuali");
    if (resolved.changed) {
      log.step("[Old Kronos / New Kronos] Dates differ from Kuali — updating:");
      if (resolved.lastDayWorked !== kualiData.lastDayWorked) {
        log.step(`  Last Day Worked: ${kualiData.lastDayWorked} → ${resolved.lastDayWorked}`);
        await updateLastDayWorked(kualiPage, resolved.lastDayWorked);
      }
      if (resolved.separationDate !== kualiData.separationDate) {
        log.step(`  Separation Date: ${kualiData.separationDate} → ${resolved.separationDate}`);
        await updateSeparationDate(kualiPage, resolved.separationDate);
      }
    } else {
      log.step("[Dates] No date changes needed");
    }

    const finalTermEffDate = resolved.separationDate !== kualiData.separationDate
      ? computeTerminationEffDate(resolved.separationDate)
      : termEffDate;
    if (resolved.separationDate !== kualiData.separationDate) {
      log.step(`Termination effective date: ${finalTermEffDate} (updated separation date ${resolved.separationDate} + 1 day)`);
    }
    const finalComments = buildTerminationComments(finalTermEffDate, resolved.lastDayWorked, docId);

    // ─── Step 5: ucpath-job-summary — fill Kuali department/payroll from
    // the UCPath Job Summary data fetched in Phase 1's parallel block.
    // The Kuali Termination Effective Date fill moved to kuali-finalization
    // (where it belongs — it's a Kuali-side fill, not a UCPath lookup). The
    // step is therefore skipped when no UCPath data is available, which
    // also covers the edit-and-resume bypass path (lastDayWorkedPrefilled →
    // kronos-search skipped → jobSummaryData undefined).
    const hasUcpathFillData = !!jobSummaryData &&
      (!!jobSummaryData.departmentDescription || !!jobSummaryData.jobCode);
    if (!hasUcpathFillData) {
      ctx.skipStep("ucpath-job-summary");
      log.step(
        lastDayWorkedPrefilled
          ? `[Step: ucpath-job-summary] SKIPPED — manual input from edit-data ` +
            `(lastDayWorked prefilled, no UCPath fetch ran)`
          : `[Step: ucpath-job-summary] SKIPPED — UCPath Job Summary returned no fillable data`,
      );
    } else {
      await ctx.step("ucpath-job-summary", () =>
        runUcpathJobSummary(kualiPage, jobSummaryData!, kualiData.eid),
      );
    }

    // ─── Step 6: UCPath Smart HR Transaction ───
    // Edit-and-resume: a prefilled `transactionNumber` means UCPath already
    // accepted the submit on a prior run and the user just wants Kuali
    // finalization re-run (the failure was downstream). Skip the step
    // entirely — no Smart HR navigation, no findExistingTerminationTransaction
    // probe, no submit. The prefilled value flows straight into
    // kuali-finalization's transaction-results fill.
    let transactionNumber = txnNumberPrefilled
      ? (ctx.data.transactionNumber as string)
      : "";
    // Tracks the specific "submit succeeded but no txn # extracted" case.
    // We must abort before kuali-finalization so we don't write a blank
    // transaction number back to the Kuali form. Raised outside the step's
    // try/catch because we want it to propagate, unlike ordinary submit
    // failures which are logged and allowed to fall through to finalization
    // (so the Kuali form gets its "left blank for manual entry" treatment).
    let submittedWithoutTxnNumber = false;

    if (txnNumberPrefilled) {
      ctx.skipStep("ucpath-transaction");
      log.step(
        `[Step: ucpath-transaction] SKIPPED — using manual input from edit-data ` +
        `(transactionNumber='${transactionNumber}' — UCPath submit not needed)`,
      );
      ctx.updateData({ transactionNumber });
    } else {
    await ctx.step("ucpath-transaction", async () => {
      const result = await runUcpathTransaction(
        ctx,
        kualiData,
        finalTermEffDate,
        ucpathReason,
        finalComments,
        template,
        transactionNumber,
      );
      transactionNumber = result.transactionNumber;
      submittedWithoutTxnNumber = result.submittedWithoutTxnNumber;
    });

    if (submittedWithoutTxnNumber) {
      throw new Error(
        "Transaction submitted but transaction number could not be extracted — aborting before Kuali finalization writes empty value",
      );
    }
    } // end !txnNumberPrefilled branch

    // ─── Step 7: Kuali finalization ───
    await ctx.step("kuali-finalization", () =>
      runKualiFinalize(ctx, {
        kualiPage,
        kualiData,
        resolved,
        transactionNumber,
        finalTermEffDate,
        timekeeperName,
      }),
    );

    // Final state snapshot for the dashboard detail panel / JSONL readers.
    ctx.updateData({
      terminationType: isVol ? "Vol" : "Invol",
      separationDate: resolved.separationDate,
      terminationEffDate: finalTermEffDate,
      deptId: jobSummaryData?.deptId ?? "",
      departmentDescription: jobSummaryData?.departmentDescription ?? "",
      jobCode: jobSummaryData?.jobCode ?? "",
      jobDescription: jobSummaryData?.jobDescription ?? "",
      foundInOldKronos: String(oldKronosFound),
      foundInNewKronos: String(newKronosFound),
      transactionNumber,
    });

    log.success(`=== Separation complete for doc #${docId} ===`);
  },
});

// Re-export CLI runners so existing import sites (index.ts, src/cli.ts) continue working.
export { runSeparation, runSeparationBatch, runSeparationCli } from "./cli.js";
