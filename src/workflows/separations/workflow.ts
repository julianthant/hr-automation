import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { defineWorkflow } from "../../core/index.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import type { Ctx } from "../../core/kernel/types.js";
import { isUcpathEmployeeId } from "../../domain/identity/eid.js";
import { personLookupWorkflow } from "../person-lookup/index.js";

// Auth wrappers — split into prepare (nav + fill) + submit (click + Duo)
// phases so Session.launch can pre-fill every SSO form in parallel before
// the serial Duo chain begins.
import { requireLogin, requirePrepareLogin } from "../../infra/auth/require-login.js";
import {
  kualiNavigateAndFill,
  kualiSubmitAndWaitForDuo,
  ucpathNavigateAndFill,
  ucpathSubmitAndWaitForDuo,
  newKronosNavigateAndFill,
  newKronosSubmitAndWaitForDuo,
} from "../../infra/auth/login.js";
import { getTimekeeperName } from "../../config.js";

// Kuali module
import {
  isVoluntaryTermination,
  fillTimekeeperTasks,
  updateLastDayWorked,
} from "../../systems/kuali/index.js";
import type { KualiSeparationData } from "../../systems/kuali/index.js";

// New Kronos (used for post-search scroll)
import {
  scrollNewKronosTimecardToDate,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";
import type { SeparationTimecardData } from "../../systems/new-kronos/index.js";

// UCPath (used for jobSummary result resolution)
import type { JobSummaryData } from "../../systems/ucpath/index.js";

import {
  computeTerminationEffDate,
  computeKronosDateRange,
  buildTerminationComments,
  mapReasonCode,
  validateLastDayWorked,
} from "./schema.js";
import {
  KUALI_SPACE_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
} from "./config.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";

// Step functions
import { runKualiExtract } from "./steps/kuali-extract.js";
import { runKronosSearch } from "./steps/kronos-search.js";
import { logSettledRejection, unwrapSettled } from "./settled.js";
import { runUcpathJobSummary } from "./steps/ucpath-job-summary.js";
import { runUcpathTransaction } from "./steps/ucpath-transaction.js";
import { runKualiFinalize } from "./steps/kuali-finalize.js";

/**
 * Input schema for the separations kernel workflow.
 *
 * `docId` is the Kuali document id (the operator-typed input). `dryRun` is an
 * optional safety flag (mirrors onboarding / oath-signature / emergency-contact):
 * when set, the handler runs the full READ path but halts before BOTH
 * irreversible writes — the UCPath Smart HR submit and the Kuali finalization
 * save. It MUST be declared here: Zod strips unknown keys, so without this
 * field a `dryRun: true` folded on by the dashboard's input-run toggle would be
 * silently dropped and a REAL termination would fire. See the dry-run terminal
 * in the handler below and `CLAUDE.md` → "Dry-run boundary".
 */
const SeparationInputSchema = z.object({
  docId: z.string().min(1),
  dryRun: z.boolean().optional(),
});
export type SeparationInput = z.infer<typeof SeparationInputSchema>;

const separationsSteps = [
  "kuali-extraction",
  "kronos-search",
  "ucpath-job-summary",
  "ucpath-transaction",
  "kuali-finalization",
] as const;

export const SEPARATIONS_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

/**
 * Kernel definition for the separations workflow.
 *
 * 3 systems, parallel-staggered auth: every browser's SSO form is pre-filled
 * in parallel via `prepareLogin`, then submit clicks fire 5 seconds apart
 * (Kuali at t=0, New Kronos at t=5s, UCPath at t=10s). All 3 Duo prompts pend
 * on the user's phone simultaneously — the user can approve them in any order.
 * `ctx.page(id)` awaits each system's ready promise, so phase-1 tasks start as
 * soon as their individual Duo clears (in approval order, not click order).
 *
 * Phase 1 (`kronos-search`) runs 3 tasks in parallel via `ctx.parallel`:
 *   - New Kronos timecard search (last physical punch + sick/holiday days)
 *   - UCPath Job Summary lookup
 *   - Kuali timekeeper name fill
 * Each task `await ctx.page(id)` first to block on its system's auth.
 *
 * Phase 2 (`ucpath-job-summary`): Kuali dept/payroll fill from the Job Summary.
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
  return unwrapSettled("UCPath Job Summary extraction", result);
}

/**
 * Resolve a provably-invalid Kuali EID via a person-lookup delegation.
 *
 * Operators sometimes type a short / malformed EID into the Kuali form (e.g.
 * `"1061029"` — 7 digits; a valid UCPath EID is 8 digits starting with `10`,
 * `isUcpathEmployeeId`). A short EID makes the UCPath Smart HR lookup find
 * nothing → no transaction number, so the separation fails far downstream with
 * an opaque error. This guard runs right after Kuali extraction (or the
 * edit-and-resume prefilled bypass) and BEFORE any consumer of
 * `kualiData.eid`:
 *
 *   - If the EID already passes `isUcpathEmployeeId`, it is returned unchanged
 *     (no delegation, no latency).
 *   - Otherwise it DELEGATES to `person-lookup` by the employee NAME (the name
 *     path has no EID-format constraint) to resolve the correct full EID, then
 *     continues the separation with the corrected value. person-lookup is
 *     daemon-capable, so `ctx.delegateTo` routes through its daemon, which
 *     authenticates UCPath + CRM independently — this adds latency; that is the
 *     accepted tradeoff for recovering an otherwise-doomed run.
 *   - If person-lookup returns no valid EID (failed run, or a `done` run that
 *     still produced no `isUcpathEmployeeId`-passing `emplId`), it FAILS LOUD:
 *     the error names the employee + the bad EID and tells the operator to fix
 *     the Kuali form. It does NOT silently continue with the bad EID.
 *
 * This is a deliberately-scoped exception to the "wrong Kuali EID should fail
 * loudly" rule: only PROVABLY-invalid EIDs (failing `isUcpathEmployeeId`)
 * delegate. An 8-digit-but-semantically-wrong EID still passes the guard and
 * stays the operator's problem (EID/date duplicate protection covers the rest).
 *
 * Returns the EID to use for the rest of the run. On a successful correction it
 * also `ctx.updateData({ eid })` so the corrected value persists to the tracker
 * row / final snapshot / detail panel (the caller separately threads it into
 * `kualiData`).
 */
export async function resolveSeparationEid(
  ctx: Pick<Ctx<typeof separationsSteps, Record<string, unknown>>, "delegateTo" | "updateData">,
  kualiData: KualiSeparationData,
): Promise<string> {
  if (isUcpathEmployeeId(kualiData.eid)) return kualiData.eid;

  log.warn(
    `[EID guard] Kuali EID "${kualiData.eid}" for "${kualiData.employeeName}" is not a valid ` +
    `UCPath EID (need 8 digits starting with 10) — delegating to person-lookup by name to resolve it`,
  );

  const result = await ctx.delegateTo(personLookupWorkflow, { name: kualiData.employeeName });
  const resolvedEid = result.status === "done" ? (result.data?.emplId ?? "") : "";

  if (!isUcpathEmployeeId(resolvedEid)) {
    throw new Error(
      `Short/invalid EID "${kualiData.eid}" for "${kualiData.employeeName}" — ` +
      `person-lookup returned no EID. Fix the EID in the Kuali form and retry.`,
    );
  }

  log.success(
    `[EID guard] person-lookup resolved "${kualiData.employeeName}": ` +
    `"${kualiData.eid}" → "${resolvedEid}" — continuing separation with corrected EID`,
  );
  ctx.updateData({ eid: resolvedEid });
  return resolvedEid;
}

export const separationsWorkflow = defineWorkflow({
  name: "separations",
  label: "Separations",
  archetype: "single",
  inputSubject: "kualiId",
  code: "se",
  category: "Separations",
  iconName: "UserMinus",
  systems: [
    {
      id: "kuali",
      // kualiNavigateAndFill takes (page, url) so a plain requirePrepareLogin
      // wrap can't capture the URL — keep the full closure.
      prepareLogin: async (page) => {
        const prep = await kualiNavigateAndFill(page, KUALI_SPACE_URL);
        if (prep === false) throw new Error("Kuali prepareLogin failed");
      },
      // kualiSubmitAndWaitForDuo takes (page, url, instance?, signal?) so a
      // plain requireLogin wrap can't capture the URL — keep the full closure.
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
      id: "new-kronos",
      prepareLogin: requirePrepareLogin(newKronosNavigateAndFill, "New Kronos prepareLogin failed"),
      login: requireLogin(newKronosSubmitAndWaitForDuo, "New Kronos authentication failed"),
      resetUrl: NEW_KRONOS_URL,
    },
    {
      id: "ucpath",
      prepareLogin: requirePrepareLogin(ucpathNavigateAndFill, "UCPath prepareLogin failed"),
      login: requireLogin(ucpathSubmitAndWaitForDuo, "UCPath authentication failed"),
      resetUrl: UCPATH_SMART_HR_URL,
    },
  ],
  steps: separationsSteps,
  schema: SeparationInputSchema,
  runtimePolicy: SEPARATIONS_WORKFLOW_RUNTIME_POLICY,
  // Dashboard input-run gear menu — operator-selectable "Run mode" presets.
  // The implicit "Full" preset (all 5 steps) is synthesized client-side and
  // not listed here. Each preset's `skipSteps` set surfaces in the handler via
  // `ctx.shouldSkipStep(name)`; the handler folds the check into its existing
  // skip branches (which already gate on Edit Data prefilled values).
  presets: [
    {
      id: "transactions-only",
      label: "Transactions only",
      skipSteps: ["kronos-search", "ucpath-job-summary"],
      description:
        "Skips Kronos date verification and UCPath Job Summary. Assumes the Kuali form already has Last Day Worked, Separation Date, Dept, and Payroll Code filled correctly.",
    },
  ],
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
          // Use raw Kuali string only — display values ("Vol"/"Invol") must not
          // reach isVoluntaryTermination(), which only knows raw Kuali strings.
          (ctx.data.rawTerminationType as string | undefined) ?? "",
        separationDate: ctx.data.separationDate as string,
        lastDayWorked: ctx.data.lastDayWorked as string,
        // `location` isn't read downstream — empty string is safe and keeps
        // the synthesized object structurally compatible with KualiSeparationData.
        location: "",
      };
    } else {
      kualiData = await ctx.step("kuali-extraction", () => runKualiExtract(ctx, docId));
    }

    // ─── EID guard: resolve a provably-invalid Kuali EID via person-lookup ───
    // Must run AFTER kualiData is established by EITHER path (extraction or the
    // prefilled bypass) and BEFORE any consumer of kualiData.eid (the kronos
    // date math and runKronosSearch below). A short/malformed EID is corrected
    // by delegating to person-lookup by NAME; an unresolvable one fails loud
    // (resolveSeparationEid throws). On success it rewrites kualiData.eid and
    // persists ctx.data.eid so every downstream step + the final snapshot use
    // the corrected value. See resolveSeparationEid + CLAUDE.md "Wrong Kuali EID".
    kualiData = { ...kualiData, eid: await resolveSeparationEid(ctx, kualiData) };

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
    const timekeeperName = getTimekeeperName();

    log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
    log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
    log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
    log.step(`Termination effective date: ${termEffDate} (separation date ${kualiData.separationDate} + 1 day)`);
    log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
    log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

    // ─── Step 4: kronos-search (3-way parallel) ───
    const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
      kualiData.lastDayWorked, kualiData.separationDate,
    );
    log.step(`[New Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

    // ─── Process Phase 1 results (preserve PromiseSettledResult fallback semantics) ───
    // New Kronos separation timecard: last physical punch + sick/holiday days.
    // Empty default when kronos-search is skipped (prefill / preset paths).
    let timecard: SeparationTimecardData = {
      lastPunchDate: null,
      sickDates: [],
      holidayDates: [],
    };
    let newKronosFound = false;
    let jobSummaryData: JobSummaryData | undefined;

    // Two reasons to skip kronos-search converge here:
    //   1. Edit-and-resume prefilled `lastDayWorked` (existing path).
    //   2. Operator selected the "Transactions only" preset from the
    //      InputRunPanel gear menu (asserts the Kuali form is already correct).
    // In both cases the handler falls back to `kualiData.lastDayWorked` (which
    // kuali-extraction just read from the Kuali form) for the Last Day Worked,
    // and sick/holiday stay empty — so no extra plumbing is needed.
    const presetSkippedKronos = ctx.shouldSkipStep("kronos-search");
    if (lastDayWorkedPrefilled || presetSkippedKronos) {
      ctx.skipStep("kronos-search");
      log.step(
        presetSkippedKronos
          ? `[Step: kronos-search] SKIPPED — run mode 'Transactions only' ` +
            `(operator asserts Kuali dates are correct — using kualiData.lastDayWorked='${kualiData.lastDayWorked}')`
          : `[Step: kronos-search] SKIPPED — using manual input from edit-data ` +
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

    if (phase1.newK.status === "fulfilled") {
      newKronosFound = phase1.newK.value.found;
      timecard = {
        lastPunchDate: phase1.newK.value.lastPunchDate,
        sickDates: phase1.newK.value.sickDates,
        holidayDates: phase1.newK.value.holidayDates,
      };
    } else {
      logSettledRejection("New Kronos", phase1.newK);
    }
    logSettledRejection("UCPath Job Summary", phase1.jobSummary);
    // resolveJobSummaryResult throws on rejection (classified log emitted above);
    // no duplicate log.error here — the rejection is fatal and the throw propagates.
    jobSummaryData = resolveJobSummaryResult(phase1.jobSummary);
    logSettledRejection("Kuali Timekeeper", phase1.kualiTimekeeper);

    log.step(
      `[New Kronos] ${newKronosFound ? "Found" : "Not found"} ` +
      `(lastPunch=${timecard.lastPunchDate ?? "none"}, ` +
      `sick=${timecard.sickDates.length}, holiday=${timecard.holidayDates.length})`,
    );
    } // end !lastDayWorkedPrefilled branch

    // ─── Reconcile dates (NEW MODEL) ───
    // Last Day Worked = New Kronos last physical punch (timecard ground truth),
    //   which OVERRIDES the Kuali LDW when they differ. Falls back to Kuali's
    //   LDW when New Kronos returned no punch or kronos-search was skipped.
    // Separation Date = Kuali's separationDate — AUTHORITATIVE, never overridden
    //   (it's the "last day actively employed", can be later than LDW via leave).
    // Termination Effective Date = Separation Date + 1 day.
    // Sick / holiday days drive the comment clause ONLY — never any date.
    const lastDayWorked = timecard.lastPunchDate ?? kualiData.lastDayWorked;
    const ldwChanged =
      timecard.lastPunchDate != null && timecard.lastPunchDate !== kualiData.lastDayWorked;
    // Separation Date is Kuali-authoritative; `termEffDate` (= separationDate + 1)
    // was already computed from kualiData.separationDate above — reuse both.
    const separationDate = kualiData.separationDate;

    log.step(
      `[Dates] Last Day Worked = ${lastDayWorked}` +
      (ldwChanged
        ? ` (New Kronos last punch overrides Kuali '${kualiData.lastDayWorked}')`
        : ` (Kuali LDW — no Kronos override)`),
    );
    log.step(`[Dates] Separation Date = ${separationDate} (Kuali authoritative — never overridden)`);
    log.step(`[Dates] Termination effective date = ${termEffDate} (separation date + 1 day)`);
    if (timecard.sickDates.length || timecard.holidayDates.length) {
      log.step(
        `[Dates] Leave from timecard — sick=${timecard.sickDates.length} ` +
        `holiday=${timecard.holidayDates.length} (comment clause only, no date change)`,
      );
    }

    // Position the New Kronos timecard view so the chosen Last Day Worked
    // row is CENTERED, then take a dedicated audit screenshot of ONLY the
    // new-kronos page showing that date with its neighbours above/below — so
    // the operator can verify the last physical punch without opening the
    // Kronos browser. A VIEWPORT capture (centerSelector), NOT fullPage: the
    // New Kronos timecard is a virtual-scroll grid (`.ui-grid-viewport`) —
    // fullPage only captures the rows currently rendered in the DOM, missing
    // off-screen data. The screenshot fires even when the scroll best-effort-
    // fails (it captures whatever is shown). Best-effort — neither the scroll
    // nor the shot may disrupt the rest of the run.
    try {
      const newKronosPage = await ctx.page("new-kronos");
      await scrollNewKronosTimecardToDate(newKronosPage, lastDayWorked);
      await ctx.screenshot({
        kind: 'form',
        label: 'new-kronos-last-worked-date',
        systems: ['new-kronos'],
        // The grid viewport fills the page, so centering it is a near no-op;
        // its real job is selecting the viewport-only capture path while the
        // target row stays centered from scrollNewKronosTimecardToDate above.
        centerSelector: '.ui-grid-viewport',
      });
    } catch { /* best-effort */ }

    // Early-populate separationDate so the dashboard shows it as soon as
    // date reconciliation completes (not only after the transaction submits).
    ctx.updateData({ separationDate, terminationType: isVol ? "Vol" : "Invol" });

    // ─── DRY RUN terminal — stop before EVERY irreversible write ───
    // Separations has TWO committing mutations: the UCPath Smart HR submit
    // (`clickSaveAndSubmit`, inside `ucpath-transaction`) and the Kuali
    // finalization save (`runKualiFinalize`, inside `kuali-finalization`).
    // Onboarding's dry-run only had to guard its single final UCPath submit;
    // separations halts before BOTH committing steps AND before the
    // pre-submit Kuali form writes (date corrections + dept/payroll fill) that
    // would otherwise start at the next line. The full READ path has already
    // run by here — 4-system auth (4 Duos), Kuali extraction, Kronos search,
    // UCPath Job Summary fetch, and Kronos-vs-Kuali date reconciliation — so a
    // dry run exercises everything except the writes. Result: no UCPath
    // transaction is created and the Kuali document is never finalized.
    // (One benign residual: the timekeeper-name fill bundled into the
    // `kronos-search` parallel block has already touched the UNSUBMITTED Kuali
    // draft — it commits nothing, mirroring onboarding's pre-submit I-9 create.)
    if (input.dryRun) {
      ctx.skipStep("ucpath-job-summary");
      ctx.skipStep("ucpath-transaction");
      ctx.skipStep("kuali-finalization");
      await ctx.screenshot({ kind: "form", label: "separations-dry-run-before-submit" });
      ctx.updateData({
        status: "Dry Run Complete",
        dryRun: true,
        terminationType: isVol ? "Vol" : "Invol",
        separationDate,
        lastDayWorked,
        terminationEffDate: termEffDate,
        deptId: jobSummaryData?.deptId ?? "",
        departmentDescription: jobSummaryData?.departmentDescription ?? "",
        jobCode: jobSummaryData?.jobCode ?? "",
        jobDescription: jobSummaryData?.jobDescription ?? "",
        foundInNewKronos: String(newKronosFound),
      });
      log.success(
        `DRY RUN: reached UCPath Smart HR transaction for doc #${docId} — ` +
        `Kuali writes, UCPath submit, and Kuali finalization all skipped ` +
        `(no UCPath transaction created, Kuali document not finalized)`,
      );
      return;
    }

    const kualiPage = await ctx.page("kuali");
    // Only the Last Day Worked may change (New Kronos last punch overrides
    // Kuali's). The Separation Date is Kuali-authoritative and is NEVER written
    // back — it stays exactly what the requester entered.
    if (ldwChanged) {
      log.step(`[New Kronos] Last Day Worked differs from Kuali — updating:`);
      log.step(`  Last Day Worked: ${kualiData.lastDayWorked} → ${lastDayWorked}`);
      await updateLastDayWorked(kualiPage, lastDayWorked);
    } else {
      log.step("[Dates] No Last Day Worked change needed");
    }

    const finalTermEffDate = termEffDate;
    const finalComments = buildTerminationComments(
      finalTermEffDate,
      lastDayWorked,
      docId,
      { sickDates: timecard.sickDates, holidayDates: timecard.holidayDates },
    );

    // ─── Step 5: ucpath-job-summary — fill Kuali department/payroll from
    // the UCPath Job Summary data fetched in Phase 1's parallel block.
    // The Kuali Termination Effective Date fill moved to kuali-finalization
    // (where it belongs — it's a Kuali-side fill, not a UCPath lookup). The
    // step is therefore skipped when no UCPath data is available, which
    // also covers the edit-and-resume bypass path (lastDayWorkedPrefilled →
    // kronos-search skipped → jobSummaryData undefined).
    const hasUcpathFillData = !!jobSummaryData &&
      (!!jobSummaryData.departmentDescription || !!jobSummaryData.jobCode);
    // Three reasons to skip ucpath-job-summary:
    //   1. No fillable data returned from the Phase-1 parallel fetch (existing).
    //   2. Edit-and-resume prefilled lastDayWorked → kronos-search was
    //      skipped above → jobSummaryData is undefined (existing).
    //   3. Operator selected the "Transactions only" preset (new) — they
    //      asserted dept/payroll are already in the Kuali form.
    const presetSkippedJobSummary = ctx.shouldSkipStep("ucpath-job-summary");
    if (!hasUcpathFillData || presetSkippedJobSummary) {
      ctx.skipStep("ucpath-job-summary");
      log.step(
        presetSkippedJobSummary
          ? `[Step: ucpath-job-summary] SKIPPED — run mode 'Transactions only' ` +
            `(operator asserts Kuali form has dept/payroll filled)`
          : lastDayWorkedPrefilled
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
    // TODO(separations): explicitly set UCPath Last Date Worked = lastDayWorked
    // + Override Last Date Worked checkbox (needs live UCPath selector mapping).
    // Today the reconciled lastDayWorked flows only through finalComments →
    // fillComments; the UCPath form field / override checkbox are NOT set
    // because those selectors don't exist yet (deferred — needs a live mapping).
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
        lastDayWorked,
        separationDate,
        ldwChanged,
        transactionNumber,
        finalTermEffDate,
        timekeeperName,
      }),
    );

    // Final state snapshot for the dashboard detail panel / JSONL readers.
    ctx.updateData({
      terminationType: isVol ? "Vol" : "Invol",
      separationDate,
      lastDayWorked,
      terminationEffDate: finalTermEffDate,
      deptId: jobSummaryData?.deptId ?? "",
      departmentDescription: jobSummaryData?.departmentDescription ?? "",
      jobCode: jobSummaryData?.jobCode ?? "",
      jobDescription: jobSummaryData?.jobDescription ?? "",
      foundInNewKronos: String(newKronosFound),
      transactionNumber,
    });

    log.success(`=== Separation complete for doc #${docId} ===`);
  },
});
