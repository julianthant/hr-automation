import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { defineWorkflow } from "../../core/index.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import type { Ctx } from "../../core/kernel/types.js";
import { isUcpathEmployeeId, normalizeEid } from "../../domain/identity/eid.js";
import { displayPersonName } from "../../domain/identity/person-name.js";
import {
  classifyNameSimilarity,
  correctNameSpelling,
} from "../../services/matching/match.js";
import { isAcceptedHdhDepartment } from "../../domain/hdh/departments.js";
import { separationsStatusExtensions } from "../../domain/separations-status.js";
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
  updateSeparationDate,
  updateEmployeeName,
} from "../../systems/kuali/index.js";
import type { KualiSeparationData } from "../../systems/kuali/index.js";

// New Kronos (used for post-search scroll)
import {
  scrollNewKronosTimecardToDate,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";
import type { SeparationTimecardData } from "../../systems/new-kronos/index.js";

// UCPath (Job Summary fetch for the identity gate + identity-check re-fetch)
import { getJobSummaryIdentity } from "../../systems/ucpath/index.js";
import type { JobSummaryData } from "../../systems/ucpath/index.js";

import {
  computeTerminationEffDate,
  computeSeparationDate,
  computeKronosDateRange,
  buildTerminationComments,
  buildDuplicateTerminationComment,
  getInitials,
  joinComments,
  todayMmDdYyyy,
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
import { runTransactionCheck } from "./steps/transaction-check.js";
import { logSettledRejection } from "./settled.js";
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
  "identity-check",
  "transaction-check",
  // ucpath-job-summary now runs BEFORE kronos-search (2026-06-24): the
  // Workforce Job Summary department is resolved + filled first, and its
  // department gates kronos-search — non-HDH employees aren't timekept in New
  // Kronos, so the timecard read is skipped for them. See the handler.
  "ucpath-job-summary",
  "kronos-search",
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
 * Work-step order: `kuali-extraction → identity-check → transaction-check →
 * ucpath-job-summary → kronos-search → ucpath-transaction → kuali-finalization`.
 * The Workforce Job Summary is fetched inline before `identity-check` (it gates
 * the identity verification AND resolves the department). `ucpath-job-summary`
 * (Kuali dept/payroll fill) now runs BEFORE `kronos-search` (2026-06-24) so the
 * department can gate the timecard read:
 *   - `ucpath-job-summary`: Kuali dept/payroll fill from the Job Summary data.
 *   - DEPARTMENT GATE: only Housing/Dining/Hospitality (HDH) employees are
 *     timekept in New Kronos, so a non-HDH department SKIPS `kronos-search`
 *     (dates fall back to the Kuali form).
 *   - `kronos-search` (HDH only, 2-way `ctx.parallel`): New Kronos timecard
 *     search (last physical punch + sick/holiday days) + Kuali timekeeper fill.
 *   - `ucpath-transaction`: Smart HR UC_VOL_TERM or UC_INVOL_TERM.
 *   - `kuali-finalization`: write txn number back, fill date-change comments, save.
 *
 * Batch mode (`runWorkflowBatch` sequential): the kernel calls `session.reset(id)`
 * between docs, which navigates each system's `resetUrl` so the next doc starts
 * from a clean page state.
 */

/**
 * Outcome of the `identity-check` name-search arm (`resolveSeparationEid`):
 *
 *   - `verified`        — person-lookup confirmed the SAME EID the Kuali form
 *                         carried → trust it, proceed.
 *   - `needs-approval`  — person-lookup resolved a DIFFERENT, valid EID by name.
 *                         We do NOT silently override + submit a termination
 *                         (that once terminated the wrong person — see the
 *                         2026-06-29 EID-approval lesson). The handler PAUSES the
 *                         run into the operator EID-approval review instead.
 */
export type SeparationEidResolution =
  | { status: "verified"; eid: string }
  | {
      status: "needs-approval";
      proposedEid: string;
      proposedName: string;
      proposedDepartment: string;
      proposedPayrollTitle: string;
    };

/**
 * The "very different name" / "EID not found" arm of the `identity-check` step:
 * verify the EID via person-lookup BY NAME. The handler calls this ONLY when the
 * Workforce Job Summary result is suspicious enough to need a name search — it
 * is a CONDITIONAL check, not an every-run pass. The cases:
 *
 *   1. Job Summary FOUND the EID but the detail-page name is VERY DIFFERENT from
 *      the Kuali name (`classifyNameSimilarity` → "different") → the EID may
 *      point at the wrong person (the valid-format-but-wrong Perez `10694136`
 *      case) → look the intended person up BY NAME.
 *   2. Job Summary did NOT find the EID AND the typed EID is short (< 8 digits,
 *      incomplete) → the operator mistyped/truncated it → resolve BY NAME.
 *   3. Job Summary did NOT find the EID AND the typed EID is a complete 8 digits
 *      → nothing obviously wrong with the EID and no person to compare → FAIL
 *      LOUD (the operator fixes the upstream record; we do NOT silently look up,
 *      per `src/systems/ucpath/CLAUDE.md` "No cross-source auto-fallbacks").
 *
 * The CLOSE-variant case (Job Summary FOUND + `classifyNameSimilarity` →
 * "similar", e.g. Kuali "Balmaceda, Jaden" vs UCPath "Jayden Balmaceda") never
 * reaches here — the handler trusts the EID and fixes the Kuali NAME in place
 * (no person-lookup). And the clean-match case ("same") SKIPS this step entirely.
 *
 * **Name is NO LONGER silently authoritative.** When person-lookup resolves a
 * DIFFERENT valid EID, this returns `needs-approval` (with the proposed person's
 * context) — the handler stamps the EID-approval review and pauses. A resolved
 * EID that MATCHES the Kuali one returns `verified`; an unresolvable name still
 * FAILS LOUD. This function performs NO `ctx.updateData` — the decision to
 * accept a different EID belongs to the operator (see CLAUDE.md "EID approval
 * review").
 */
export async function resolveSeparationEid(
  ctx: Pick<Ctx<typeof separationsSteps, Record<string, unknown>>, "delegateTo">,
  kualiData: KualiSeparationData,
  jobSummary: { found: boolean; name: string },
): Promise<SeparationEidResolution> {
  const eidDigits = normalizeEid(kualiData.eid).length;

  // Case 3: not found + a complete 8-digit EID → no person to compare against
  // and the EID looks valid → fail loud instead of guessing by name.
  if (!jobSummary.found && eidDigits >= 8) {
    throw new Error(
      `Workforce Job Summary found no record for "${kualiData.employeeName}" (EID "${kualiData.eid}") ` +
      `and the EID is a complete 8 digits — cannot verify the identity. ` +
      `Fix the EID/name in the Kuali form and retry.`,
    );
  }

  // Cases 1 + 2: delegate to person-lookup BY NAME (the name path has no
  // EID-format constraint, so a short/blank EID is fine to pass through).
  const reason = jobSummary.found
    ? `Job Summary name "${jobSummary.name}" does not match Kuali "${kualiData.employeeName}"`
    : `Job Summary found no record and the Kuali EID "${kualiData.eid}" is incomplete (${eidDigits} digits)`;
  log.warn(`[identity-check] ${reason} — delegating to person-lookup by name`);

  const result = await ctx.delegateTo(personLookupWorkflow, { name: kualiData.employeeName });
  const resolvedEid = result.status === "done" ? (result.data?.emplId ?? "") : "";

  if (!isUcpathEmployeeId(resolvedEid)) {
    throw new Error(
      `Could not verify the EID for "${kualiData.employeeName}" (Kuali EID "${kualiData.eid}") — ` +
      `person-lookup resolved no UCPath EID by name. Fix the name/EID in the Kuali form and retry.`,
    );
  }

  if (resolvedEid === kualiData.eid) {
    log.success(
      `[identity-check] person-lookup confirms EID ${kualiData.eid} for "${kualiData.employeeName}"`,
    );
    return { status: "verified", eid: kualiData.eid };
  }

  // A DIFFERENT valid EID. Do NOT auto-override + submit — surface BOTH
  // identities for operator approval. person-lookup's result data already
  // carries the proposed person's name/department/payroll title (CRM-sourced),
  // so the approval card can show who the name-search actually resolved to.
  const data = (result.data ?? {});
  log.warn(
    `[identity-check] person-lookup resolved a DIFFERENT EID "${resolvedEid}" for ` +
    `"${kualiData.employeeName}" (Kuali EID "${kualiData.eid}") — PAUSING for operator approval ` +
    `(no silent override).`,
  );
  return {
    status: "needs-approval",
    proposedEid: resolvedEid,
    proposedName: typeof data.name === "string" ? data.name : "",
    proposedDepartment: typeof data.department === "string" ? data.department : "",
    proposedPayrollTitle: typeof data.payrollTitle === "string" ? data.payrollTitle : "",
  };
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
  // EID-approval review: identity-check pauses (rather than silently overriding)
  // when it resolves a DIFFERENT EID by name. The row then displays "Awaiting
  // Approval"/"Dismissed" via this rule (gated on data.eidApproval). See
  // src/domain/separations-status.ts + CLAUDE.md "EID approval review".
  statusExtensions: separationsStatusExtensions,
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
    { key: "name",              label: "Employee",        editable: true, group: "Identity"                            },
    { key: "eid",               label: "EID",             editable: true, group: "Identity",     inputKind: "id"      },
    { key: "docId",             label: "Doc ID"                                                   },
    { key: "terminationType",   label: "Term Type"                                                }, // computed (Vol/Invol) — display only
    { key: "lastDayWorked",     label: "Last Day Worked", editable: true, group: "Dates",        inputKind: "date"    },
    // Separation Date now shows in the grid (Kuali-authoritative date, never
    // overridden). Still editable for edit-and-resume. Always stamped via
    // updateData (date reconciliation + final snapshot), so it never trips the
    // "declared but never populated" warn.
    { key: "separationDate",    label: "Separation Date", editable: true, group: "Dates",        inputKind: "date"    },
    // Department name from the UCPath Workforce Job Summary (read-only). The
    // final snapshot always stamps it ("" when no Job Summary ran), so the
    // key is present on every success path — no populate warn.
    { key: "departmentDescription", label: "Department"                                           },
    // Stamped on every success path: live ("" until the UCPath submit returns a
    // number), dry-run (always "" — no submit), and the failed-no-txn snapshot.
    { key: "transactionNumber", label: "Txn #",           editable: true, group: "Transaction",  inputKind: "id"      },
    // Free-form Kuali timekeeper-comments override. Edit-and-resume only —
    // not surfaced in the LogPanel detail grid. `fillTimekeeperComments` is
    // append-aware: existing field content is preserved + a newline-joined
    // append is filled. The final/dry-run snapshots stamp it ("" when no
    // prefill) so it never trips the "declared but never populated" warn.
    { key: "comments",          label: "Comments",        editable: true, displayInGrid: false, multiline: true, group: "Notes" },
    // Read-only preview of the generated UCPath termination comment (incl.
    // sick/holiday clause). Stamped in dry-run so the operator can verify it
    // before a real termination.
    { key: "separationComment", label: "Termination Comment", displayInGrid: false, multiline: true },
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
    buildOperatorSubject({ kind: "document", value: input.docId }),
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
      && (ctx.data.lastDayWorked).length > 0;
    const txnNumberPrefilled =
      typeof ctx.data.transactionNumber === "string"
      && (ctx.data.transactionNumber).length > 0;

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
      (k) => typeof ctx.data[k] === "string" && (ctx.data[k]).length > 0,
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
        // Normalize the prefilled name too — an operator typing in Edit Data may
        // enter ALL-CAPS or "First Last"; keep the standard display convention.
        employeeName: displayPersonName(ctx.data.name as string),
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

    // ─── EID-approval re-run gate ───
    // When the operator approves a chosen EID from the EID-approval review, the
    // approve action re-enqueues this doc with `prefilledData.eidApproved` set to
    // the chosen EID. Force that EID over whatever extraction read and remember
    // it so the identity-check gate below is SKIPPED (we must not re-pause — the
    // operator already decided). The inline Job Summary fetch + the HDH kronos
    // gate below then run with the APPROVED EID, so dept/payroll/timecard are the
    // approved person's. A fresh (non-approval) run has no marker → eidPreApproved
    // is false and the normal gate runs.
    const approvedEid = typeof ctx.data.eidApproved === "string" ? ctx.data.eidApproved.trim() : "";
    const eidPreApproved = isUcpathEmployeeId(approvedEid);
    if (eidPreApproved && approvedEid !== kualiData.eid) {
      log.step(
        `[identity-check] Using operator-approved EID "${approvedEid}" ` +
        `(extraction read "${kualiData.eid}") — EID-approval review re-run`,
      );
      kualiData = { ...kualiData, eid: approvedEid };
      ctx.updateData({ eid: approvedEid });
    }

    // Preflight: reject future-dated separations so we don't waste Kronos/UCPath
    // work on a record that isn't yet actionable. Both Last Day Worked and
    // Separation Date are checked because either can be post-dated by the
    // requester.
    validateLastDayWorked(kualiData.lastDayWorked, "Last Day Worked");
    validateLastDayWorked(kualiData.separationDate, "Separation Date");

    const isVol = isVoluntaryTermination(kualiData.terminationType);
    // Provisional term-eff from the Kuali-claimed separation date — for the
    // extraction logs only. The authoritative term-eff is recomputed below from
    // the reconciled separation date (LDW + sick/holiday leave), which can
    // differ from what Kuali entered.
    const kualiTermEffDate = computeTerminationEffDate(kualiData.separationDate);
    const ucpathReason = mapReasonCode(kualiData.terminationType);
    const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
    const timekeeperName = getTimekeeperName();

    log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
    log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
    log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
    log.step(`Termination effective date (provisional): ${kualiTermEffDate} (Kuali separation date ${kualiData.separationDate} + 1 day)`);
    log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
    log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${kualiTermEffDate}`);

    // ─── kronos date range — computed from the Kuali dates, which are stable
    // across EID verification, so it's safe to compute up front. kronos-search
    // itself runs LATER (after identity-check + transaction-check +
    // ucpath-job-summary), with the verified EID — and only when the department
    // gate didn't skip it (HDH employees only). ───
    const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
      kualiData.lastDayWorked, kualiData.separationDate,
    );
    log.step(`[New Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

    // New Kronos separation timecard: last physical punch + sick/holiday days.
    // Empty default when kronos-search is skipped (prefill / preset paths) and
    // until the kronos-search step below fills it.
    let timecard: SeparationTimecardData = {
      lastPunchDate: null,
      sickDates: [],
      holidayDates: [],
    };
    let newKronosFound = false;

    // INPUT-based reasons to skip kronos-search — computed UP FRONT because the
    // Job-Summary fetch + identity-check below skip on the same conditions:
    //   1. Edit-and-resume prefilled `lastDayWorked` (existing path).
    //   2. Operator selected the "Transactions only" preset (asserts the Kuali
    //      form already has Last Day Worked / Separation Date / dept / payroll).
    // In both cases LDW falls back to `kualiData.lastDayWorked`, sick/holiday
    // stay empty, and the operator has asserted the data — so there's nothing to
    // verify (identity-check + the Job Summary fetch are skipped too).
    //
    // A THIRD, department-based reason is decided LATER (after the Job Summary
    // fetch resolves the department): a NON-HDH employee isn't timekept in New
    // Kronos, so there's no timecard to read — see the "Department gate" below.
    // `identitySkipped` depends only on the input-based reasons here; the Job
    // Summary fetch must still run to discover the department.
    const presetSkippedKronos = ctx.shouldSkipStep("kronos-search");
    const kronosSkippedByInput = lastDayWorkedPrefilled || presetSkippedKronos;

    // ─── Step 2: identity-check — conditional name↔EID verification ───
    // The Workforce Job Summary (whether the EID resolved + the detail-page
    // name) is the gate. It USED to be fetched inside kronos-search's parallel
    // block, with identity-check running after it; it now moves to an inline
    // read HERE so the EID is verified/corrected BEFORE the transaction check and
    // the timecard read use it. Only the Job Summary SOURCE moved — the
    // skip/branch semantics are unchanged:
    //   · txn prefilled OR kronos skipped → SKIP (operator prefilled/asserted the
    //     data, or UCPath already accepted the EID) — no fetch, no verify.
    //   · Job Summary FOUND + name "same"     → SKIP (EID trusted, name correct).
    //   · Job Summary FOUND + name "similar"  → RUN → trust the EID, CORRECT the
    //     misspelled Kuali name in place (no person-lookup). Jaden→Jayden case.
    //   · Job Summary FOUND + name "different" → RUN → delegate to person-lookup
    //     BY NAME (very different = wrong-person EID; name authoritative).
    //   · not found + short (<8) EID → RUN → delegate BY NAME.
    //   · not found + complete 8-digit EID → RUN → FAIL LOUD (no lookup).
    // On an EID correction we re-fetch the Job Summary (so dept/payroll is the
    // RIGHT person's). The New Kronos re-search is GONE: kronos-search runs below
    // with the corrected EID, so no re-search is needed.
    const identitySkipped = txnNumberPrefilled || kronosSkippedByInput;

    let jobSummaryData: JobSummaryData | undefined;
    let jobSummaryFound = false;
    let jobSummaryName = "";
    if (!identitySkipped) {
      const ucpathPage = await ctx.page("ucpath");
      log.step("[UCPath] Fetching Workforce Job Summary (identity gate)...");
      // Identity-aware, NON-throwing on a missing EID: returns `found: false` so
      // the branch below can act (person-lookup for a short EID, fail loud for a
      // full-8-digit miss). Reads the detail-page NAME on a hit so the name can
      // be compared. Genuine selector/nav failures still throw (fail loud).
      const js = await getJobSummaryIdentity(ucpathPage, kualiData.eid, {
        separationDate: kualiData.separationDate,
      });
      jobSummaryFound = js.found;
      jobSummaryName = js.name;
      jobSummaryData = js.data ?? undefined;
      log.step(
        `[Job Summary] ${jobSummaryFound ? `Found (name="${jobSummaryName}")` : "Not found"}`,
      );
    }

    const nameTier = jobSummaryFound
      ? classifyNameSimilarity(kualiData.employeeName, jobSummaryName)
      : "different";

    if (identitySkipped) {
      ctx.skipStep("identity-check");
      log.step(
        txnNumberPrefilled
          ? `[Step: identity-check] SKIPPED — txn # prefilled (UCPath already accepted EID '${kualiData.eid}'; no re-submit)`
          : `[Step: identity-check] SKIPPED — kronos-search skipped, no Job Summary gate (operator prefilled/asserted the data)`,
      );
    } else if (eidPreApproved) {
      // EID-approval review re-run: the operator already chose this EID, so the
      // gate must NOT re-evaluate it (a "Keep original" choice would otherwise
      // re-pause, since its Job Summary name still mismatches the form). Trust it
      // as given. The Job Summary fetch above already ran with the approved EID,
      // so dept/payroll are the approved person's.
      ctx.skipStep("identity-check");
      log.success(
        `[Step: identity-check] SKIPPED — EID ${kualiData.eid} was operator-approved via the ` +
        `EID-approval review; trusted as given (no re-verification).`,
      );
    } else if (jobSummaryFound && nameTier === "same") {
      ctx.skipStep("identity-check");
      log.success(
        `[Step: identity-check] SKIPPED — Job Summary name "${jobSummaryName}" matches Kuali ` +
        `"${kualiData.employeeName}"; EID ${kualiData.eid} trusted (no person-lookup needed)`,
      );
    } else if (jobSummaryFound && nameTier === "similar") {
      // Same person under a close spelling variant (e.g. "Balmaceda, Jaden" vs
      // "Jayden Balmaceda"). The EID found a real, clearly-matching person — so
      // TRUST IT and correct the misspelled Kuali name in place rather than
      // firing a (doomed) name search on the typo. No EID change → no re-fetch.
      await ctx.step("identity-check", async () => {
        const correctedName = correctNameSpelling(kualiData.employeeName, jobSummaryName);
        log.warn(
          `[identity-check] Job Summary name "${jobSummaryName}" is a close variant of Kuali ` +
          `"${kualiData.employeeName}" — trusting EID ${kualiData.eid}; correcting the Kuali name ` +
          `to "${correctedName}"`,
        );
        // Write the correction to the Kuali draft even in dry-run — same as the
        // timekeeper-name fill bundled into kronos-search. It touches the
        // UNSUBMITTED draft and commits nothing; the dry-run terminal still
        // skips finalization, so the document is never finalized/submitted.
        const kp = await ctx.page("kuali");
        await updateEmployeeName(kp, correctedName);
        kualiData = { ...kualiData, employeeName: correctedName };
        ctx.updateData({ name: correctedName });
      });
    } else {
      const resolution = await ctx.step("identity-check", () =>
        resolveSeparationEid(ctx, kualiData, { found: jobSummaryFound, name: jobSummaryName }),
      );
      if (resolution.status === "needs-approval") {
        // ─── PAUSE for operator EID approval ───
        // person-lookup resolved a DIFFERENT valid EID. We do NOT silently
        // override + submit a termination (doing so once terminated the wrong
        // person — a graduating student's doc carried an EID that resolved to a
        // career maint worker of the same name; see the 2026-06-29 lesson).
        // Skip every remaining step and return cleanly: the run ends `done`, so
        // the 3 browsers release and the daemon claims the NEXT queued doc while
        // this row waits in the EID-approval review. The operator approves a
        // chosen EID (re-queues the doc with `prefilledData.eidApproved`) or
        // dismisses it. Both candidate identities are stamped for the review card
        // (original from the inline Job Summary fetch above; proposed from
        // person-lookup's CRM-sourced result data).
        ctx.skipStep("transaction-check");
        ctx.skipStep("ucpath-job-summary");
        ctx.skipStep("kronos-search");
        ctx.skipStep("ucpath-transaction");
        ctx.skipStep("kuali-finalization");
        ctx.updateData({
          eidApproval: "pending",
          status: "Awaiting EID Approval",
          // Original (the EID the Kuali form carried).
          originalEid: kualiData.eid,
          originalEidName: jobSummaryFound ? jobSummaryName : "",
          originalEidDepartment: jobSummaryData?.departmentDescription ?? "",
          originalEidPayrollTitle: jobSummaryData?.jobDescription ?? "",
          originalEidFound: String(jobSummaryFound),
          // Proposed (the EID the name search resolved to).
          proposedEid: resolution.proposedEid,
          proposedEidName: resolution.proposedName,
          proposedEidDepartment: resolution.proposedDepartment,
          proposedEidPayrollTitle: resolution.proposedPayrollTitle,
        });
        log.warn(
          `[identity-check] EID mismatch for "${kualiData.employeeName}": Kuali EID ${kualiData.eid}` +
          `${jobSummaryFound ? ` (UCPath "${jobSummaryName}")` : " (not found in UCPath)"} vs ` +
          `name-resolved EID ${resolution.proposedEid}` +
          `${resolution.proposedName ? ` ("${resolution.proposedName}")` : ""}. ` +
          `PAUSED — awaiting operator approval; the queue continues with other docs.`,
        );
        return;
      }
      // verified → the resolved EID matches the Kuali one (person-lookup
      // confirmed it). No EID change, so no Job Summary re-fetch. (A DIFFERENT
      // EID no longer overrides here — it pauses for approval above.)
    }

    // ─── Step 3: transaction-check (AFTER identity-check, with the verified EID) ───
    // Search SS Smart HR for an existing termination (TER) transaction:
    //   · none      → create a new transaction downstream (normal flow).
    //   · Approved  → reuse its T#, SKIP ucpath-transaction, and file the
    //                 duplicate-termination comment (Image 7) in Kuali.
    //   · Pending   → delete it (LIVE only — the dry-run path reports the intent
    //                 but doesn't mutate), then create a fresh transaction.
    // The DELETE is the only mutation; runTransactionCheck gates it on dryRun.
    // Skipped only when a txn # is already prefilled (edit-resume — UCPath
    // already has the transaction; nothing to check).
    let approvedDuplicateTxn = "";
    if (txnNumberPrefilled) {
      ctx.skipStep("transaction-check");
      log.step(
        `[Step: transaction-check] SKIPPED — txn # prefilled (UCPath transaction already known; no check needed)`,
      );
    } else {
      const checkResult = await ctx.step("transaction-check", () =>
        runTransactionCheck(ctx, kualiData.eid, {
          dryRun: !!input.dryRun,
          separationDate: kualiData.separationDate,
        }),
      );
      if (checkResult.status === "approved") {
        approvedDuplicateTxn = checkResult.transactionNumber;
        // Reuse the approved transaction: stamp it + the duplicate-termination
        // comment onto ctx.data so BOTH the dry-run preview and live
        // kuali-finalization pick them up. The comment is newline-joined with
        // any existing edit-resume comment (fillTimekeeperComments also
        // preserves the form's current value).
        const dupComment = buildDuplicateTerminationComment(
          docId,
          getInitials(timekeeperName),
          todayMmDdYyyy(),
        );
        ctx.updateData({
          transactionNumber: approvedDuplicateTxn,
          comments: joinComments((ctx.data.comments as string | undefined) ?? "", dupComment),
        });
        ctx.recordData({
          direction: "write",
          field: "comments",
          label: "Duplicate-Termination Comment",
          value: dupComment,
          system: "Kuali",
          note: "Queued from approved transaction reuse — UCPath create skipped",
        });
        log.warn(
          `[transaction-check] Reusing APPROVED termination #${approvedDuplicateTxn} — ` +
          `ucpath-transaction will be skipped; duplicate-termination comment queued for Kuali`,
        );
      }
    }

    // ─── Department gate: skip New Kronos for non-HDH employees (2026-06-24) ───
    // Only Housing/Dining/Hospitality (HDH) employees are timekept in New
    // Kronos, so there is no timecard to read for anyone else. Now that the
    // Workforce Job Summary (fetched by the identity gate above) has resolved
    // the department, a NON-HDH department means kronos-search is skipped and the
    // dates fall back to the Kuali form — the SAME date model as the other
    // kronos-skip paths (sep date derives to the Kuali Last Day Worked).
    //
    // FAIL-SAFE: we only skip on a POSITIVE non-HDH determination — Job Summary
    // found the person AND returned a non-empty department AND it isn't HDH. When
    // the department is unknown (no Job Summary fetch ran — prefill/preset/txn
    // paths — or it came back empty) we still RUN kronos: silently skipping an
    // actual HDH employee's timecard would produce wrong dates. HDH membership
    // uses the canonical `isAcceptedHdhDepartment` (department-description keyword
    // match), the same matcher person-lookup uses for HDH disposition.
    const departmentDescription = jobSummaryData?.departmentDescription ?? "";
    const departmentKnown = departmentDescription.trim().length > 0;
    const departmentIsHdh =
      departmentKnown && isAcceptedHdhDepartment(departmentDescription);
    const nonHdhSkipsKronos = departmentKnown && !departmentIsHdh;
    if (nonHdhSkipsKronos) {
      log.step(
        `[Dept gate] "${departmentDescription}" is not HDH (Housing/Dining/` +
        `Hospitality) — skipping New Kronos timecard verification; dates fall ` +
        `back to the Kuali form`,
      );
    } else if (departmentIsHdh) {
      log.step(
        `[Dept gate] "${departmentDescription}" is HDH — running New Kronos timecard verification`,
      );
    }
    const kronosSkipped = kronosSkippedByInput || nonHdhSkipsKronos;

    // ─── Step 4: ucpath-job-summary (now BEFORE kronos-search) — fill Kuali
    // department/payroll from the UCPath Job Summary data fetched by the identity
    // gate above (and re-fetched there on an EID correction). Moved AHEAD of
    // kronos-search (2026-06-24) so the Workforce Job Summary department is
    // resolved + filled before the timecard read, and so its department can gate
    // kronos-search (the non-HDH skip above). The Kuali Termination Effective
    // Date fill stays in kuali-finalization (a Kuali-side fill, not a UCPath
    // lookup). The dept FILL is also robust to the later Kuali writes (the
    // timekeeper-name fill + date write-backs that now follow it) — the same
    // dropdown already survives kuali-finalization's edits today.
    // Skipped when:
    //   1. dryRun — the dept fill is a Kuali draft write we deliberately keep out
    //      of dry-run (the dry-run terminal below already halts before the UCPath
    //      submit + Kuali finalization). The department gate above already read
    //      the department, so skipping the FILL here doesn't affect kronos.
    //   2. No fillable Job Summary data — prefill / preset / identity-skipped
    //      paths leave `jobSummaryData` undefined or empty.
    //   3. Operator selected the "Transactions only" preset (asserted dept/payroll
    //      are already in the Kuali form).
    const hasUcpathFillData =
      !!jobSummaryData &&
      (!!jobSummaryData.departmentDescription || !!jobSummaryData.jobCode);
    const presetSkippedJobSummary = ctx.shouldSkipStep("ucpath-job-summary");
    if (input.dryRun || !hasUcpathFillData || presetSkippedJobSummary) {
      ctx.skipStep("ucpath-job-summary");
      log.step(
        input.dryRun
          ? `[Step: ucpath-job-summary] SKIPPED — dry run (no Kuali department fill)`
          : presetSkippedJobSummary
            ? `[Step: ucpath-job-summary] SKIPPED — run mode 'Transactions only' ` +
              `(operator asserts Kuali form has dept/payroll filled)`
            : lastDayWorkedPrefilled
              ? `[Step: ucpath-job-summary] SKIPPED — manual input from edit-data ` +
                `(lastDayWorked prefilled, no UCPath fetch ran)`
              : `[Step: ucpath-job-summary] SKIPPED — UCPath Job Summary returned no fillable data`,
      );
    } else {
      const kualiPageForDept = await ctx.page("kuali");
      await ctx.step("ucpath-job-summary", () =>
        runUcpathJobSummary(kualiPageForDept, jobSummaryData!, kualiData.eid),
      );
      // Provenance: department/payroll READ from the UCPath Job Summary, then
      // WRITTEN into the Kuali separation form.
      ctx.recordData([
        { direction: "read", field: "departmentDescription", label: "Department", value: jobSummaryData!.departmentDescription, system: "UCPath Job Summary" },
        { direction: "read", field: "jobCode", label: "Payroll Title Code", value: jobSummaryData!.jobCode, system: "UCPath Job Summary" },
        { direction: "read", field: "jobDescription", label: "Payroll Title", value: jobSummaryData!.jobDescription, system: "UCPath Job Summary" },
        { direction: "write", field: "department", label: "Department", value: jobSummaryData!.departmentDescription, system: "Kuali" },
        { direction: "write", field: "payrollTitle", label: "Payroll Title", value: jobSummaryData!.jobDescription, system: "Kuali" },
      ]);
    }

    // ─── Step 5: kronos-search (2-way parallel — New Kronos timecard + Kuali
    // timekeeper fill; the Job Summary moved up to the identity gate above) ───
    if (kronosSkipped) {
      ctx.skipStep("kronos-search");
      log.step(
        lastDayWorkedPrefilled
          ? `[Step: kronos-search] SKIPPED — using manual input from edit-data ` +
            `(lastDayWorked='${ctx.data.lastDayWorked}' — Kronos verification not needed)`
          : presetSkippedKronos
            ? `[Step: kronos-search] SKIPPED — run mode 'Transactions only' ` +
              `(operator asserts Kuali dates are correct — using kualiData.lastDayWorked='${kualiData.lastDayWorked}')`
            : `[Step: kronos-search] SKIPPED — department "${departmentDescription}" is not HDH ` +
              `(not timekept in New Kronos — using Kuali dates, lastDayWorked='${kualiData.lastDayWorked}')`,
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
      logSettledRejection("Kuali Timekeeper", phase1.kualiTimekeeper);
      log.step(
        `[New Kronos] ${newKronosFound ? "Found" : "Not found"} ` +
        `(lastPunch=${timecard.lastPunchDate ?? "none"}, ` +
        `sick=${timecard.sickDates.length}, holiday=${timecard.holidayDates.length})`,
      );
      // Provenance: timecard facts READ from the New Kronos separation timecard.
      ctx.recordData([
        { direction: "read", field: "lastPunchDate", label: "Last Physical Punch", value: timecard.lastPunchDate, system: "New Kronos" },
        { direction: "read", field: "sickDates", label: "Sick Days", value: timecard.sickDates, system: "New Kronos" },
        { direction: "read", field: "holidayDates", label: "Holiday Days", value: timecard.holidayDates, system: "New Kronos" },
      ]);
    }

    // ─── Reconcile dates (NEW MODEL, 2026-06-22) ───
    // Last Day Worked = New Kronos last physical punch (timecard ground truth),
    //   which OVERRIDES the Kuali LDW when they differ. Falls back to Kuali's
    //   LDW when New Kronos returned no punch or kronos-search was skipped.
    // Separation Date = the last day the employee was PAID for (worked OR on
    //   paid leave) = max(lastDayWorked, last sick date, last holiday date).
    //   It is DERIVED from the timecard, NOT taken verbatim from Kuali — "usually
    //   the same as the last day worked unless the employee has sick hours or
    //   holiday pay". With no leave it collapses to the Last Day Worked; with no
    //   Kronos data at all it falls back (via lastDayWorked) to the Kuali LDW.
    //   When the derived value differs from Kuali's, it is written back to the
    //   Kuali Separation Date field with an audit comment (live runs only).
    // Termination Effective Date = Separation Date + 1 day (recomputed here).
    // Sick / holiday days ALSO drive the comment clause (buildTerminationComments).
    const lastDayWorked = timecard.lastPunchDate ?? kualiData.lastDayWorked;
    const ldwChanged =
      timecard.lastPunchDate != null && timecard.lastPunchDate !== kualiData.lastDayWorked;
    // Separation Date: only DERIVE it (last day paid = last day worked +
    // sick/holiday leave) when a New Kronos timecard was actually READ. When
    // kronos-search was SKIPPED — non-HDH employees (not timekept in New Kronos),
    // or the prefill / "Transactions only" paths — there is NO timecard to derive
    // from, so keep the Kuali Separation Date VERBATIM. Re-deriving it from the
    // LDW in that case produced a spurious "Updated Separation Date … per Kronos
    // timesheet" comment + write-back for non-HDH employees whose Kuali separation
    // date legitimately differs from their LDW, even though Kronos was never read
    // (live: Bookstore "Nakagawa, Matthew K", 06/15 → 06/14 "per Kronos"). No
    // timecard read → no timecard-derived change → no comment. (Note: an HDH
    // employee whose timecard RAN but returned no punch still derives via the
    // LDW — that path read the timecard; only the skip paths keep Kuali's date.)
    const separationDate = kronosSkipped
      ? kualiData.separationDate
      : computeSeparationDate(lastDayWorked, timecard.sickDates, timecard.holidayDates);
    const separationDateChanged = separationDate !== kualiData.separationDate;
    const termEffDate = computeTerminationEffDate(separationDate);

    log.step(
      `[Dates] Last Day Worked = ${lastDayWorked}` +
      (ldwChanged
        ? ` (New Kronos last punch overrides Kuali '${kualiData.lastDayWorked}')`
        : ` (Kuali LDW — no Kronos override)`),
    );
    const hasLeave = timecard.sickDates.length > 0 || timecard.holidayDates.length > 0;
    log.step(
      `[Dates] Separation Date = ${separationDate}` +
      (kronosSkipped
        ? ` (Kuali Separation Date kept as-is — New Kronos not read, no timecard to derive from)`
        : hasLeave
          ? ` (last day paid — last day worked extended by sick/holiday leave; ` +
            `Kuali had '${kualiData.separationDate}')`
          : ` (= last day worked, no sick/holiday leave; Kuali had '${kualiData.separationDate}')`) +
      (separationDateChanged ? ` — will write back to Kuali` : ` — matches Kuali`),
    );
    log.step(`[Dates] Termination effective date = ${termEffDate} (separation date + 1 day)`);
    if (hasLeave) {
      log.step(
        `[Dates] Leave from timecard — sick=${timecard.sickDates.length} ` +
        `holiday=${timecard.holidayDates.length} (extends separation date + drives comment clause)`,
      );
    }

    // Build the termination comment now (a pure string) so the dry-run terminal
    // can preview the EXACT comment that would be filed to UCPath — including the
    // sick/holiday clause — letting the operator verify it before any real run.
    const finalComments = buildTerminationComments(
      termEffDate,
      lastDayWorked,
      docId,
      { sickDates: timecard.sickDates, holidayDates: timecard.holidayDates },
    );

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
    // pre-submit Kuali date write-backs that would otherwise start at the next
    // line. The full READ path has already run by here — 3-system auth (3 Duos),
    // Kuali extraction, the UCPath Job Summary identity gate, the
    // transaction-check SS Smart HR search, the department gate, Kronos search,
    // and date reconciliation — so a dry run exercises everything except the
    // writes. Result: no UCPath transaction is created, no pending transaction is
    // deleted (transaction-check guards its delete on dryRun), and the Kuali
    // document is never finalized.
    // `ucpath-job-summary` (the Kuali dept/payroll fill) now runs BEFORE this
    // terminal — it skips itself on the dryRun branch above, so the dry-run path
    // still does no department fill; the terminal only needs to skip the two
    // remaining steps.
    // (Two benign residuals on the UNSUBMITTED Kuali draft — neither commits:
    // the timekeeper-name fill bundled into `kronos-search`, and the `similar`
    // identity-check name correction — mirroring onboarding's pre-submit I-9
    // create.)
    if (input.dryRun) {
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
        separationComment: finalComments,
        // Stamp the last two declared detailFields so the dry-run path never
        // trips the "declared but never populated" warn (mirrors
        // departmentDescription). `transactionNumber` is usually "" — no UCPath
        // submit runs in dry-run — but carries the reused T# when transaction-
        // check found an APPROVED duplicate (so the preview shows it); `comments`
        // preserves any edit-and-resume prefill + the duplicate-termination note.
        transactionNumber: (ctx.data.transactionNumber) ?? "",
        comments: (ctx.data.comments) ?? "",
      });
      log.success(
        `DRY RUN: reached UCPath Smart HR transaction for doc #${docId} — ` +
        `Kuali writes, UCPath submit, and Kuali finalization all skipped ` +
        `(no UCPath transaction created, Kuali document not finalized)`,
      );
      return;
    }

    const kualiPage = await ctx.page("kuali");
    // Both reconciled dates are written back to Kuali when they differ from what
    // the requester entered: the Last Day Worked (New Kronos last punch override)
    // and the Separation Date (derived from the timecard = last day worked +
    // sick/holiday leave). Each write is gated on its own *changed flag and is
    // accompanied by an audit comment in kuali-finalization.
    if (ldwChanged) {
      log.step(`[New Kronos] Last Day Worked differs from Kuali — updating:`);
      log.step(`  Last Day Worked: ${kualiData.lastDayWorked} → ${lastDayWorked}`);
      await updateLastDayWorked(kualiPage, lastDayWorked);
    } else {
      log.step("[Dates] No Last Day Worked change needed");
    }
    if (separationDateChanged) {
      log.step(`[Dates] Separation Date differs from Kuali — updating:`);
      log.step(`  Separation Date: ${kualiData.separationDate} → ${separationDate}`);
      await updateSeparationDate(kualiPage, separationDate);
    } else {
      log.step("[Dates] No Separation Date change needed");
    }

    // (ucpath-job-summary — the Kuali department/payroll fill — already ran
    // above, BEFORE kronos-search; see "Step 4". Its department also gated the
    // kronos-search skip. Nothing to do here.)

    // ─── Step 6: UCPath Smart HR Transaction ───
    // TODO(separations): explicitly set UCPath Last Date Worked = lastDayWorked
    // + Override Last Date Worked checkbox (needs live UCPath selector mapping).
    // Today the reconciled lastDayWorked flows only through finalComments →
    // fillComments; the UCPath form field / override checkbox are NOT set
    // because those selectors don't exist yet (deferred — needs a live mapping).
    // Two reasons the UCPath transaction step is skipped with a known number:
    //   1. Edit-and-resume: a prefilled `transactionNumber` means UCPath already
    //      accepted the submit on a prior run and the user just wants Kuali
    //      finalization re-run (the failure was downstream).
    //   2. Approved duplicate: transaction-check found an ALREADY-APPROVED
    //      termination (`approvedDuplicateTxn`) — reuse it instead of creating a
    //      new one (the duplicate-termination comment was already queued onto
    //      ctx.data.comments).
    // Either way: no Smart HR navigation, no findExistingTerminationTransaction
    // probe, no submit — the known number flows straight into
    // kuali-finalization's transaction-results fill.
    let transactionNumber = txnNumberPrefilled
      ? (ctx.data.transactionNumber as string)
      : approvedDuplicateTxn; // "" when transaction-check found no approved dup
    // Tracks the specific "submit succeeded but no txn # extracted" case.
    // We must abort before kuali-finalization so we don't write a blank
    // transaction number back to the Kuali form. Raised outside the step's
    // try/catch because we want it to propagate, unlike ordinary submit
    // failures which are logged and allowed to fall through to finalization
    // (so the Kuali form gets its "left blank for manual entry" treatment).
    let submittedWithoutTxnNumber = false;

    if (txnNumberPrefilled || approvedDuplicateTxn) {
      ctx.skipStep("ucpath-transaction");
      log.step(
        txnNumberPrefilled
          ? `[Step: ucpath-transaction] SKIPPED — using manual input from edit-data ` +
            `(transactionNumber='${transactionNumber}' — UCPath submit not needed)`
          : `[Step: ucpath-transaction] SKIPPED — reusing APPROVED duplicate termination ` +
            `(transactionNumber='${transactionNumber}' — UCPath create not needed)`,
      );
      ctx.updateData({ transactionNumber });
    } else {
    await ctx.step("ucpath-transaction", async () => {
      const result = await runUcpathTransaction(
        ctx,
        kualiData,
        termEffDate,
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

    // Provenance: the UCPath Smart HR transaction number this run resolved —
    // newly created, reused from an approved duplicate, or carried over from a
    // prior run (edit-and-resume).
    ctx.recordData({
      direction: "write",
      field: "transactionNumber",
      label: "Transaction #",
      value: transactionNumber,
      system: "UCPath Smart HR",
      ...(txnNumberPrefilled
        ? { note: "prefilled (edit-and-resume)" }
        : approvedDuplicateTxn
          ? { note: "reused approved duplicate" }
          : {}),
    });

    // ─── Step 7: Kuali finalization ───
    await ctx.step("kuali-finalization", () =>
      runKualiFinalize(ctx, {
        kualiPage,
        kualiData,
        lastDayWorked,
        separationDate,
        ldwChanged,
        separationDateChanged,
        transactionNumber,
        finalTermEffDate: termEffDate,
        timekeeperName,
      }),
    );
    // Provenance: the values finalization WROTE back into the Kuali document.
    ctx.recordData([
      { direction: "write", field: "transactionNumber", label: "Transaction #", value: transactionNumber, system: "Kuali" },
      ...(ldwChanged
        ? [{ direction: "write" as const, field: "lastDayWorked", label: "Last Day Worked", value: lastDayWorked, system: "Kuali", note: `overrides Kuali '${kualiData.lastDayWorked}' (New Kronos last punch)` }]
        : []),
      ...(separationDateChanged
        ? [{ direction: "write" as const, field: "separationDate", label: "Separation Date", value: separationDate, system: "Kuali", note: `derived from timecard; Kuali had '${kualiData.separationDate}'` }]
        : []),
      { direction: "write" as const, field: "terminationEffDate", label: "Termination Eff. Date", value: termEffDate, system: "Kuali" },
    ]);

    // Final state snapshot for the dashboard detail panel / JSONL readers.
    ctx.updateData({
      terminationType: isVol ? "Vol" : "Invol",
      separationDate,
      lastDayWorked,
      terminationEffDate: termEffDate,
      deptId: jobSummaryData?.deptId ?? "",
      departmentDescription: jobSummaryData?.departmentDescription ?? "",
      jobCode: jobSummaryData?.jobCode ?? "",
      jobDescription: jobSummaryData?.jobDescription ?? "",
      foundInNewKronos: String(newKronosFound),
      separationComment: finalComments,
      transactionNumber,
      // `comments` (the edit-and-resume timekeeper-comments override) is only
      // ever set on the prefill path; stamp it here so a fresh live run doesn't
      // trip the "declared but never populated" warn (mirrors the dry-run snapshot).
      comments: (ctx.data.comments) ?? "",
    });

    // A live run that reaches this point with NO transaction number means the
    // UCPath Smart HR submit soft-failed (create/submit was rejected, or threw
    // and was caught inside the step). kuali-finalization above already prepped
    // + saved the Kuali form "blank for manual entry", but no usable UCPath
    // transaction number exists. That MUST surface as a FAILED run — not a
    // silent "Done" — so the operator notices the transaction still has to be
    // created/entered manually (mirrors a Job Summary extraction failure). This
    // throw fires AFTER the final snapshot updateData above, so the failed row
    // still carries the reconciled dates / department for the detail panel.
    //
    // The distinct "submit succeeded but the number couldn't be read" case
    // (`submittedWithoutTxnNumber`) already threw earlier, before finalization.
    // Dry-run returned long before here, and the prefilled / existing-transaction
    // paths always carry a non-empty number, so this only fires on a genuine
    // submit failure.
    if (!transactionNumber) {
      throw new Error(
        `No UCPath transaction number for doc #${docId} — the Smart HR submit failed, so ` +
        `the Kuali form was saved blank for manual entry. Create/enter the transaction number ` +
        `manually, then retry.`,
      );
    }

    log.success(`=== Separation complete for doc #${docId} ===`);
  },
});
