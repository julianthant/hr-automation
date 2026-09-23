import { commentsMatchTermination, matchesSeparationJob, type SeparationJob } from "../../domain/separation-job.js";
import { readTerminationJob } from "./termination-job.js";
import type { Page, FrameLocator, Locator } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import {
  navigateToSmartHR,
  collapseSidebar,
  waitForPeopleSoftProcessing,
  dismissPeopleSoftDialog,
  readPeopleSoftDialogText,
} from "./navigate.js";
import { getContentFrame, ssSmartHRTransactions, hrTasks, smartHR, comments, jobData } from "./selectors.js";
import { safeClick, safeFill } from "../common/index.js";

/**
 * SS Smart HR Transactions — the self-service "Find an Existing Value" search
 * page (`/c/UC_EXTENSIONS.UC_SS_TBH.GBL`). Distinct from the standard Smart HR
 * Transactions create page (`transaction.ts` / `smartHR.*`). Searching by Empl
 * ID returns the employee's transaction history grid (Transaction ID /
 * Template Sequence / Name / Empl ID / Action / Approval Status / Business
 * Unit), where the Action column carries PeopleSoft codes (TER, XFR, HIR, REH)
 * and the Approval Status column carries Approved / Pending / Denied / etc.
 *
 * Separations' `transaction-check` step uses this to find an EXISTING
 * termination (Action = "TER") and read its approval status before deciding
 * whether to create a new UCPath transaction, delete a pending one, or reuse an
 * already-approved one.
 *
 * NEEDS LIVE VERIFY: the post-search settle timing was authored against the
 * screenshots of the live page. The results-grid PARSE is now dual-pass and
 * tolerant of PeopleSoft's nested/split tables — header-keyed first, then a
 * header-independent pattern pass (T-id + action + status within a row) — and
 * the parse half is pure + unit-pinned (`parseSsSmartHrRows`).
 */

/** One parsed row of the SS Smart HR Transactions search-results grid. */
export interface SsSmartHrRow {
  /** Transaction ID, e.g. "T002168945". */
  transactionId: string;
  /** PeopleSoft action code, e.g. "TER", "XFR", "HIR", "REH". */
  action: string;
  /** Approval status, e.g. "Approved", "Pending". */
  approvalStatus: string;
}

/** Result of a termination-transaction status lookup. */
export interface TerminationTransactionStatus {
  /** True when a RELEVANT TER (termination for THIS separation) exists. */
  found: boolean;
  /** Transaction number of the relevant TER (empty when not found). */
  transactionId: string;
  /** Approval status of the relevant TER (empty when not found). */
  approvalStatus: string;
  /** The TER's effective date as read from its detail page ("" if unread). */
  effectiveDate: string;
  /**
   * True when a TER existed but its effective date was OUTSIDE the separation
   * window — a prior termination for a DIFFERENT job, deliberately not reused.
   */
  priorTerminationSkipped?: boolean;
}

/** Result of a hire-transaction existence probe (onboarding idempotency). */
export interface HireTransactionStatus {
  /**
   * True ONLY when a HIGH-CONFIDENCE duplicate hire exists (matching hire action
   * + in-flight/approved status + exact effective-date match). A same-named
   * person's stale hire row or a terminal-failed hire returns `false` — see
   * {@link decideHireDuplicateSkip}.
   */
  found: boolean;
  /** Transaction number of the existing hire (empty when not found). */
  transactionId: string;
  /** Approval status of the existing hire (empty when not found). */
  approvalStatus: string;
  /**
   * Effective date read from the drilled-in hire detail page (`""` when not
   * found / unread) — carried for the audit trail; the display grid exposes no
   * effdt column so this is the drilled value.
   */
  effectiveDate?: string;
}

/**
 * The post-submit RECEIPT for a hire, read off the transaction's own SS Smart
 * HR detail page: the PAIR that proves what UCPath did with the submit.
 * Every field is `""` when it could not be proved — see
 * {@link readSubmittedHireReceipt}, which never guesses.
 */
export interface SubmittedHireReceipt {
  /** Transaction number as read from the detail page ("" when unproved). */
  transactionId: string;
  /** Approval status as read from the detail page ("" when unread). */
  approvalStatus: string;
  /** Effective date read from the detail page ("" when unread). */
  effectiveDate: string;
}

/**
 * How close (in days) a TER's effective date must be to the Kuali separation
 * date for the TER to count as THIS separation rather than a prior termination
 * for a different job. "A week or two max apart" (operator, 2026-06-24).
 */
export const SEPARATION_TERMINATION_WINDOW_DAYS = 14;

/**
 * Effective tolerance window, read at CALL time so the operator's Settings value
 * (populated onto `HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS` at config load) is
 * honored regardless of module import order. Falls back to
 * {@link SEPARATION_TERMINATION_WINDOW_DAYS} when unset/invalid.
 */
function effectiveTerminationWindowDays(): number {
  const n = Number.parseInt(
    process.env.HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS ?? "",
    10,
  );
  if (Number.isInteger(n) && n === 0) {
    log.warn(
      "[SS Smart HR] HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS is 0 — " +
      "every TER effective date will be treated as a prior termination regardless of proximity; " +
      `falling back to default ${SEPARATION_TERMINATION_WINDOW_DAYS} days`,
    );
  }
  return Number.isInteger(n) && n > 0 ? n : SEPARATION_TERMINATION_WINDOW_DAYS;
}

/**
 * Pick the termination (Action = "TER") row from a parsed results grid. When
 * more than one TER row exists, the first (newest — the grid lists newest
 * first) wins. Pure + order-insensitive on whitespace/case so it is unit
 * testable without a browser.
 */
export function pickTerminationRow(rows: SsSmartHrRow[]): SsSmartHrRow | null {
  return rows.find((r) => r.action.trim().toUpperCase() === "TER") ?? null;
}

/**
 * PeopleSoft action codes that represent a hire-family Smart HR transaction:
 * `HIR` (new hire — what `UC_FULL_HIRE` produces) and `REH` (rehire). Onboarding
 * matches either when probing for an already-filed hire.
 */
export const HIRE_ACTION_CODES = ["HIR", "REH"] as const;

/**
 * Pick the hire (Action = "HIR" or "REH") row from a parsed results grid — the
 * hire-family analogue of {@link pickTerminationRow}. When more than one exists,
 * the first (newest — the grid lists newest first) wins. Pure + order-insensitive
 * on whitespace/case so it is unit testable without a browser.
 *
 * Used by onboarding's pre-submit duplicate-hire probe: a HIR/REH row for the
 * searched person on the SS Smart HR Transactions list means a hire is already
 * in flight (a prior run submitted it), so the submit must be skipped.
 */
export function pickHireRow(rows: SsSmartHrRow[]): SsSmartHrRow | null {
  const codes = new Set<string>(HIRE_ACTION_CODES);
  return rows.find((r) => codes.has(r.action.trim().toUpperCase())) ?? null;
}

/**
 * Approval statuses that count as a hire being **in flight / succeeded** for the
 * onboarding duplicate-hire skip. These are the SS Smart HR "Approval Status"
 * values (the combobox exposes exactly `Approved`, `Denied`, `Error`, `Manually
 * Processed`, `Pending`, `Pushed Back`) that mean a submitted hire is genuinely
 * in the pipeline. A terminal-FAILED hire (`Denied`/`Error`/`Pushed Back`, and
 * the `Recycled`/`Cancelled` variants the parser also recognizes) is NOT here —
 * such a hire did NOT go through and legitimately needs resubmitting, so it must
 * never trip the "already submitted → skip" guard.
 */
export const HIRE_IN_FLIGHT_APPROVAL_STATUSES = [
  "Pending",
  "Approved",
  "Manually Processed",
] as const;

/**
 * Is an SS Smart HR approval status one of the in-flight/succeeded set
 * ({@link HIRE_IN_FLIGHT_APPROVAL_STATUSES})? Case- and whitespace-insensitive.
 * Anything else (terminal-failed, blank, or unrecognized) is `false` — the gate
 * biases to SUBMIT on any status it does not positively recognize as in-flight.
 * Pure + unit-pinned.
 */
export function isHireInFlightStatus(approvalStatus: string): boolean {
  const norm = (approvalStatus ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return HIRE_IN_FLIGHT_APPROVAL_STATUSES.some((s) => s.toLowerCase() === norm);
}

/**
 * Does a drilled-in hire row's effective date match THIS run's hire effective
 * date **exactly** (same calendar day)? Accepts the row effdt in ISO
 * (`2026-07-01`, the detail-page "Effdt:" form) or US (`07/01/2026`, the grid
 * "Start Date" form) and the run date in either form. Unlike separations'
 * termination window ({@link isWithinSeparationWindow}), a hire date is exact —
 * the onboarding run knows the precise date it submitted, so only the SAME day
 * proves the row is THIS hire (a different-dated hire is a different hire event,
 * often a different same-named person). Returns `false` on any unparseable/blank
 * date so the caller fails open (→ submit). Pure + unit-pinned.
 */
export function hireEffectiveDateMatches(rowEffdt: string, runEffectiveDate: string): boolean {
  const a = toDayNumber(rowEffdt);
  const b = toDayNumber(runEffectiveDate);
  if (a === null || b === null) return false;
  return a === b;
}

/** Outcome of the pure duplicate-hire skip gate ({@link decideHireDuplicateSkip}). */
export interface HireSkipDecision {
  /** `true` → treat as an already-submitted duplicate and SKIP the submit. */
  skip: boolean;
  /** Human-readable reason for the log + audit trail (populated on both branches). */
  reason: string;
}

/**
 * PURE decision: should onboarding SKIP the Smart HR hire submit because a
 * HIGH-CONFIDENCE duplicate already exists on the SS Smart HR list?
 *
 * Conservative by design — biases to SUBMIT (`skip:false`) on ANY uncertainty.
 * This is irreversible UCPath hire logic: a false SKIP means a legitimate new
 * hire is silently never filed, which is worse than the (probe-guarded)
 * double-submit risk the guard exists to prevent. So `skip:true` requires ALL of:
 *
 *   (a) a hire-family (`HIR`/`REH`) row matched                 [candidate != null + hire action]
 *   (b) its approval status is in-flight/succeeded (Pending / Approved / Manually
 *       Processed) — NOT a terminal-failed hire (Denied/Error/Pushed Back) that
 *       must be resubmitted                                     [isHireInFlightStatus]
 *   (c) its effective date matches THIS run's hire date EXACTLY — proving it is
 *       THIS hire, not a DIFFERENT same-named person's stale hire row
 *       [hireEffectiveDateMatches]
 *
 * A blank/undefined run date, an unreadable row effdt, a non-matching effdt, a
 * non-hire action, or a terminal-failed status all resolve to `skip:false`.
 * The hire-action analogue of {@link pickHireRow}; keeps the browser glue in
 * {@link findExistingHireTransaction} thin.
 */
export function decideHireDuplicateSkip(
  candidate: Pick<SsSmartHrRow, "action" | "approvalStatus"> | null,
  rowEffectiveDate: string,
  runEffectiveDate: string | undefined,
): HireSkipDecision {
  if (!candidate) {
    return { skip: false, reason: "no hire (HIR/REH) row on the SS Smart HR list" };
  }
  const action = candidate.action.trim().toUpperCase();
  if (!new Set<string>(HIRE_ACTION_CODES).has(action)) {
    return { skip: false, reason: `row action '${candidate.action}' is not a hire (HIR/REH) action` };
  }
  if (!isHireInFlightStatus(candidate.approvalStatus)) {
    return {
      skip: false,
      reason:
        `hire status '${candidate.approvalStatus || "<blank>"}' is not in-flight/approved ` +
        `(terminal-failed hires must be resubmitted, not skipped)`,
    };
  }
  if (!runEffectiveDate) {
    return { skip: false, reason: "no run effective date to disambiguate the hire against" };
  }
  if (!hireEffectiveDateMatches(rowEffectiveDate, runEffectiveDate)) {
    return {
      skip: false,
      reason:
        `hire effdt '${rowEffectiveDate || "<unreadable>"}' does not exactly match this run's ` +
        `effective date '${runEffectiveDate}' (different hire event / possibly a different same-named person)`,
    };
  }
  return {
    skip: true,
    reason: `high-confidence duplicate: ${action}/${candidate.approvalStatus} with matching effdt ${rowEffectiveDate}`,
  };
}

/**
 * Build the PeopleSoft "Name" search key for the SS Smart HR Transactions
 * search page: the DISPLAY name, `First Last` (e.g. `Ali Alnasser`).
 *
 * LIVE-VERIFIED 2026-08-20: `Ali Alnasser` → 1 of 1 (auto-opened its detail
 * page, T002214646 Approved); `Hao Sun` → 1-2 of 2 (grid: T002216675 HIR
 * **Pending** + an older TER for a different Hao Sun); `Lenny Salazar` /
 * `Jaden Campos` → 1 of 1. Every `Last,First` / `LAST,FIRST` / `Last`-only
 * variant returned "No matching values were found" — so from 2026-07-01 to
 * 2026-08-20 the hire probe ALWAYS fell open (never found anything) and the
 * "SS Smart HR cannot see an unprocessed hire" belief was an artefact of the
 * wrong key: with the right key the list DOES carry a Requested/Pending hire.
 *
 * New hires have no Empl ID yet (the Person ID column renders "NEW" until the
 * transaction is processed — see `clickSaveAndSubmit`), so onboarding's hire
 * probe must search by name rather than EID. Pure + unit-pinned. Returns just
 * the last (or first) name when only one is present, `""` when neither is.
 */
export function buildHireSearchName(firstName: string, lastName: string): string {
  const last = (lastName ?? "").trim();
  const first = (firstName ?? "").trim();
  if (last && first) return `${first} ${last}`;
  return last || first;
}

/** Parse `YYYY-MM-DD` (ISO) or `MM/DD/YYYY` (US) to a UTC day number, else null. */
function toDayNumber(dateStr: string): number | null {
  const s = dateStr.trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  let y: number, m: number, d: number;
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Is a TER's effective date close enough to the Kuali separation date to be THIS
 * separation (vs a prior termination for a different job)? True when the two
 * dates are within `toleranceDays` (default `SEPARATION_TERMINATION_WINDOW_DAYS`).
 * Accepts the TER effdt in ISO (`2023-10-08`, the detail-page "Effdt:" form) or
 * US (`10/08/2023`, the grid "Start Date" form) and the Kuali date in US form.
 * Returns false on an unparseable date — the caller treats that as "not a
 * confident match". Pure + unit-pinned.
 */
export function isWithinSeparationWindow(
  terEffdt: string,
  kualiSeparationDate: string,
  toleranceDays: number = effectiveTerminationWindowDays(),
): boolean {
  const a = toDayNumber(terEffdt);
  const b = toDayNumber(kualiSeparationDate);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= toleranceDays;
}

/**
 * Navigate to the SS Smart HR Transactions search page via the HR Tasks
 * sidebar (Smart HR Templates → SS Smart HR Transactions). Reuses
 * `navigateToSmartHR` to load the HR Tasks shell, then drills into the
 * self-service leaf (the exact-link selector distinguishes it from the plain
 * "Smart HR Transactions" leaf).
 */
export async function navigateToSsSmartHrTransactions(page: Page): Promise<void> {
  log.step("[SS Smart HR] Navigating to SS Smart HR Transactions...");
  await navigateToSmartHR(page);

  await safeClick(hrTasks.smartHRTemplatesLink(page), {
    timeout: 10_000,
    label: "ucpath smart hr templates sidebar link (ss)",
  });
  await page.waitForTimeout(1_000);

  await safeClick(hrTasks.ssSmartHRTransactionsLink(page), {
    timeout: 10_000,
    label: "ucpath ss smart hr transactions sidebar link",
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  await collapseSidebar(page);
  log.success("[SS Smart HR] SS Smart HR Transactions page loaded");
}

/**
 * Search SS Smart HR Transactions by Empl ID and report the employee's
 * termination (TER) transaction status. Returns `found: false` when no TER row
 * exists (the employee has no existing termination — proceed to create one).
 *
 * **Effective-date gating (2026-06-24):** an employee can be terminated for a
 * PRIOR job, leaving an old TER on the list that is NOT this separation. When
 * `opts.separationDate` is supplied, the newest TER is drilled into, its
 * effective date read, and compared to the Kuali separation date: only a TER
 * within `SEPARATION_TERMINATION_WINDOW_DAYS` ("a week or two") counts as THIS
 * separation (reuse/delete). A TER outside the window is a prior termination →
 * `found: false` (+ `priorTerminationSkipped`) so the caller creates a fresh
 * transaction. The newest TER is sufficient: if this separation is already in
 * UCPath it IS the newest TER with a matching effdt; if it isn't, the newest TER
 * is some prior termination with a different effdt → create new (and
 * `ucpath-transaction`'s own EID+effdt existence check backstops the rare
 * newer-unrelated-TER edge case). Without `opts.separationDate` (legacy callers)
 * the newest TER is used as-is.
 *
 * Scan behavior: a genuine "no TER row" returns `found: false` (the separations
 * `ucpath-transaction` step's own `findExistingTerminationTransaction` is the
 * backstop against duplicate submits). A results-grid READ failure now
 * PROPAGATES (2026-07 fail-loud audit) rather than degrading to `found: false` —
 * a failed read must not masquerade as "no existing termination".
 */
export async function findTerminationTransactionStatus(
  page: Page,
  eid: string,
  opts: { separationDate?: string; toleranceDays?: number; job?: SeparationJob; effectiveDate?: string; expectedComments?: string } = {},
): Promise<TerminationTransactionStatus> {
  if (opts.job) {
    if (!opts.effectiveDate) throw new Error("Job-scoped termination lookup requires an exact effective date");
    if (!opts.expectedComments?.trim()) throw new Error("Job-scoped termination lookup requires canonical comments");
    return findTerminationForJob(page, eid, opts.job, opts.effectiveDate, opts.expectedComments);
  }
  await navigateToSsSmartHrTransactions(page);
  const frame = getContentFrame(page);

  log.step(`[SS Smart HR] Searching transactions for Empl ID ${eid}...`);
  await safeFill(ssSmartHRTransactions.emplIdInput(frame), eid, {
    timeout: 10_000,
    label: "ss smart hr empl id input",
  });
  await safeClick(ssSmartHRTransactions.searchButton(frame), {
    timeout: 10_000,
    label: "ss smart hr search button",
  });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const rows = await scanSsSmartHrResults(frame);
  log.debug(
    `[SS Smart HR] Scanned ${rows.length} transaction row(s): ` +
    (rows.map((r) => `${r.transactionId}=${r.action}/${r.approvalStatus}`).join(", ") || "<none>"),
  );
  const ter = pickTerminationRow(rows);
  if (!ter) {
    log.step(
      `[SS Smart HR] No TER (termination) transaction found for EID ${eid} ` +
      `(${rows.length} row(s) scanned) — no existing transaction`,
    );
    return { found: false, transactionId: "", approvalStatus: "", effectiveDate: "" };
  }
  log.step(
    `[SS Smart HR] Existing TER transaction for EID ${eid}: ` +
    `txn='${ter.transactionId}' status='${ter.approvalStatus}'`,
  );

  // No Kuali separation date to compare against → legacy behavior (use the TER).
  if (!opts.separationDate) {
    return { found: true, transactionId: ter.transactionId, approvalStatus: ter.approvalStatus, effectiveDate: "" };
  }

  const tol = opts.toleranceDays ?? effectiveTerminationWindowDays();
  const effectiveDate = await readTerminationEffectiveDate(page, frame, ter.transactionId);
  if (!effectiveDate) {
    // Couldn't read the effdt → we CANNOT confirm this TER is THIS separation.
    // Do NOT reuse it: silently reusing a prior-job TER skips the real
    // termination (the 2026-06-24 T001928408 / Micah Roye incident — effdt
    // 2025-07-01 reused for an 06/17/2026 separation because the drill-in
    // selector timed out). Treat it as a prior termination and create a fresh
    // transaction. `ucpath-transaction`'s own EID+effdt existence check
    // (`findExistingTerminationTransaction`, keyed on the CURRENT effective
    // date) is the precise backstop that still prevents a duplicate submit if
    // this TER really is the current separation.
    log.warn(
      `[SS Smart HR] Could not read TER ${ter.transactionId}'s effective date — ` +
      `cannot verify it is THIS separation; creating a fresh transaction ` +
      `(ucpath-transaction's EID+effdt check backstops a true duplicate)`,
    );
    return { found: false, transactionId: "", approvalStatus: "", effectiveDate: "", priorTerminationSkipped: true };
  }
  if (isWithinSeparationWindow(effectiveDate, opts.separationDate, tol)) {
    log.step(
      `[SS Smart HR] TER ${ter.transactionId} effdt ${effectiveDate} is within ${tol} days of the ` +
      `Kuali separation date ${opts.separationDate} — this IS the current separation`,
    );
    return { found: true, transactionId: ter.transactionId, approvalStatus: ter.approvalStatus, effectiveDate };
  }
  log.warn(
    `[SS Smart HR] TER ${ter.transactionId} effdt ${effectiveDate} is NOT within ${tol} days of the ` +
    `Kuali separation date ${opts.separationDate} — this is a PRIOR termination for a different job; ` +
    `a fresh transaction is needed`,
  );
  return { found: false, transactionId: "", approvalStatus: "", effectiveDate, priorTerminationSkipped: true };
}

/**
 * Probe the SS Smart HR Transactions list for an EXISTING hire (HIR/REH)
 * transaction for a person, keyed by NAME. Onboarding's pre-submit idempotency
 * guard: a prior run can submit the Smart HR hire server-side yet die before
 * writing the terminal tracker row, and a kernel retry re-runs the handler from
 * step 0 — person-search still returns "new hire" (an unprocessed Smart HR hire
 * creates no searchable person record yet), so without this probe the retry
 * re-files the hire. The hire-family analogue of {@link findTerminationTransactionStatus};
 * matches a `HIR`/`REH` action via the pure {@link pickHireRow}.
 *
 * **Keyed by NAME, not EID.** A brand-new hire has no Empl ID — the Person ID
 * column renders "NEW" until the transaction processes (see `clickSaveAndSubmit`).
 * Onboarding reaches its transaction step ONLY for a person who was NOT found in
 * UCPath (rehires short-circuit earlier). But a NAME search is a PeopleSoft
 * begins-with match, so it can also return a DIFFERENT same-named person's hire
 * row — which is why the match is NOT name+action alone.
 *
 * **HIGH-CONFIDENCE gate (mirrors separations' effdt-gated TER reuse).** `found:
 * true` is returned ONLY when the matched hire is a confident duplicate of THIS
 * run, decided by the pure {@link decideHireDuplicateSkip}:
 *   1. a `HIR`/`REH` row exists ({@link pickHireRow}); AND
 *   2. its approval status is in-flight/approved (Pending/Approved/Manually
 *      Processed — {@link isHireInFlightStatus}); a terminal-failed hire
 *      (Denied/Error/Pushed Back) did NOT go through and must be resubmitted; AND
 *   3. the hire's effective date — read by drilling the row into Transaction
 *      Details ({@link readHireEffectiveDate}, mirroring separations'
 *      `readTerminationEffectiveDate`) — matches this run's `effectiveDate`
 *      EXACTLY ({@link hireEffectiveDateMatches}). A different-dated hire is a
 *      different hire event / a different same-named person.
 *
 * **Fail-open on uncertainty → SUBMIT.** A navigation/parse failure, an empty
 * name, an unreadable effdt, a non-matching effdt, or a terminal-failed status
 * all degrade to `found: false`. This is irreversible hire logic: a false SKIP
 * (never hiring someone) is worse than the probe-guarded double-submit risk, so
 * any uncertainty resolves to "submit," never "skip." `templateId` is logged for
 * the audit trail (the results grid exposes no template column).
 *
 * NEEDS LIVE VERIFICATION: that the SS Smart HR "Name" search returns a pending
 * hire, that the `First Last` key format ({@link buildHireSearchName}, live-verified 2026-08-20) is the
 * right one for that search box, and that a HIR row drills into a detail page
 * exposing `Effdt:` (the drill-in ROW selector + `Effdt:` read were live-verified
 * for a TER on 2026-06-24; a HIR row uses the same grid + detail shape but the
 * HIR path itself is not yet live-exercised).
 */
/**
 * What the SS Smart HR Name search landed on. PeopleSoft's Find-an-Existing-Value
 * opens the single match's Transaction Details page DIRECTLY (no grid) when
 * exactly one row matches — live 2026-08-20: `Ali Alnasser` / `Lenny Salazar` /
 * `Jaden Campos` each auto-opened their detail page, `Hao Sun` (2 matches)
 * rendered the results grid. The detail page carries the Transaction ID and
 * Approval Status spans plus the routing strip's `Effdt: YYYY-MM-DD`, and its
 * "Hire Details" grid shows the action (`HIR`).
 */
export interface SsSmartHrSearchOutcome {
  kind: "grid" | "detail" | "none";
  /** Grid rows (kind === "grid"). */
  rows: SsSmartHrRow[];
  /** The auto-opened transaction (kind === "detail"). */
  detail?: { transactionId: string; approvalStatus: string; effectiveDate: string; action: string };
}

export interface TransactionRoutingStrip {
  transactionId: string;
  eid: string;
  effectiveDate: string;
}

export interface TransactionEidLookupResult {
  transactionFound: boolean;
  transactionId: string;
  eid: string;
  approvalStatus: string;
  effectiveDate: string;
}

/** Verified PeopleSoft empty-search message; absence is not proof of no match. */
export function isSsSmartHrNoMatchText(text: string): boolean {
  return /No matching values were found/i.test(text);
}

/**
 * Parse the exact routing strip that binds a Smart HR transaction to its
 * assigned Employee ID. `NEW` / `PENDING` are valid pre-assignment values and
 * return an empty EID; any other non-numeric ID is an unreadable source value.
 */
export function parseTransactionRoutingStrip(
  text: string,
  expectedTransactionId: string,
): TransactionRoutingStrip | null {
  const match = text.match(
    /Transaction:\s*(T\d{4,})\s*,\s*ID:\s*([^,]*)\s*,\s*Effdt:\s*(\d{4}-\d{1,2}-\d{1,2})\s*,/i,
  );
  if (!match) return null;
  const transactionId = match[1].toUpperCase();
  if (transactionId !== expectedTransactionId.trim().toUpperCase()) return null;
  const rawId = match[2].trim();
  let eid = "";
  if (/^\d{5,}$/.test(rawId)) {
    eid = rawId;
  } else if (rawId && !/^(?:NEW|PENDING)$/i.test(rawId)) {
    throw new Error(
      `Transaction ${transactionId} has an unrecognized Employee ID value "${rawId}"`,
    );
  }
  return {
    transactionId,
    eid,
    effectiveDate: match[3],
  };
}

/**
 * Pure: derive the hire action from the detail page's visible text. The
 * "Hire Details" grid renders the action code (`HIR`/`REH`) and the approval
 * strip starts with the action family (`HIRE …`). Returns "" when neither is
 * present so the caller's hire-only gate fails open (no skip).
 */
export function detailPageHireAction(bodyText: string): string {
  const t = (bodyText ?? "").replace(/\s+/g, " ");
  if (/\bREH\b/.test(t) || /\bREHIRE\b/i.test(t)) return "REH";
  if (/\bHIR\b/.test(t) || /\bHIRE\b/.test(t)) return "HIR";
  return "";
}

/** Pure: ISO `Effdt: YYYY-MM-DD` from the routing strip, else the first US date, else "". */
export function detailPageEffdt(bodyText: string): string {
  const text = bodyText ?? "";
  const iso = text.match(/Effdt:\s*(\d{4}-\d{1,2}-\d{1,2})/i);
  if (iso) return iso[1];
  const us = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  return us ? us[1] : "";
}

async function readSsSmartHrSearchOutcome(
  page: Page,
  frame: FrameLocator,
  label: string,
): Promise<SsSmartHrSearchOutcome> {
  // Detail page first: its Transaction ID span exists ONLY there (exactly one
  // node). An unknown/no-match search re-renders the plain search form.
  for (const root of [page, frame] as Array<Page | FrameLocator>) {
    const idLoc = ssSmartHRTransactions.transactionDetailTxnId(root);
    const count = await idLoc.count().catch(() => 0);
    if (count !== 1) continue;
    const transactionId = (await idLoc.innerText({ timeout: 5_000 }).catch(() => "")).replace(/\s+/g, " ").trim().toUpperCase();
    if (!transactionId) continue;
    const approvalStatus = (await ssSmartHRTransactions.transactionDetailApprovalStatus(root).innerText({ timeout: 5_000 }).catch(() => ""))
      .replace(/\s+/g, " ").trim();
    const bodyText = await frame
      .locator("body") // allow-inline-selector -- body text read for the auto-opened transaction detail page
      .evaluate((b) => (b as HTMLElement).innerText ?? "")
      .catch(() => "");
    const detail = {
      transactionId,
      approvalStatus,
      effectiveDate: detailPageEffdt(bodyText),
      action: detailPageHireAction(bodyText),
    };
    log.step(
      `[SS Smart HR] ${label}: single match auto-opened its detail page — txn='${detail.transactionId}' ` +
      `status='${detail.approvalStatus || "<blank>"}' action='${detail.action || "<none>"}' effdt='${detail.effectiveDate || "<none>"}'`,
    );
    return { kind: "detail", rows: [], detail };
  }
  const rows = await scanSsSmartHrResults(frame);
  return rows.length > 0 ? { kind: "grid", rows } : { kind: "none", rows: [] };
}

async function readTransactionRoutingStrip(
  page: Page,
  frame: FrameLocator,
  transactionId: string,
): Promise<TransactionRoutingStrip> {
  for (const root of [page, frame] as Array<Page | FrameLocator>) {
    const locator = ssSmartHRTransactions.transactionDetailRoutingStrip(
      root,
      transactionId,
    );
    const count = await locator.count();
    if (count === 0) continue;
    if (count !== 1) {
      throw new Error(
        `Transaction ${transactionId}: expected exactly one routing strip, found ${count}`,
      );
    }
    const text = await locator.innerText({ timeout: 5_000 });
    const parsed = parseTransactionRoutingStrip(text, transactionId);
    if (!parsed) {
      throw new Error(
        `Transaction ${transactionId}: routing strip did not match the expected Transaction/ID/Effdt format`,
      );
    }
    return parsed;
  }
  throw new Error(
    `Transaction ${transactionId}: the detail routing strip did not resolve at page or content-frame scope`,
  );
}

/**
 * Read-only Process EID lookup. Search by the roster's lived name, then require
 * the exact roster transaction number before reading the routing strip's ID.
 * Same-named people and older transactions are never selected by position.
 */
export async function findTransactionEidByName(
  page: Page,
  opts: { livedName: string; transactionId: string },
): Promise<TransactionEidLookupResult> {
  const livedName = opts.livedName.trim();
  const transactionId = opts.transactionId.trim().toUpperCase();
  if (!livedName) throw new Error("Process EID requires a non-empty lived name");
  if (!SS_TXN_ID_RE.test(transactionId)) {
    throw new Error(`Process EID received invalid transaction number "${opts.transactionId}"`);
  }

  await navigateToSsSmartHrTransactions(page);
  const frame = getContentFrame(page);
  await safeFill(ssSmartHRTransactions.nameInput(frame), livedName, {
    timeout: 10_000,
    label: "ss smart hr lived-name input (process eid)",
  });
  await safeClick(ssSmartHRTransactions.searchButton(frame), {
    timeout: 10_000,
    label: "ss smart hr search button (process eid)",
  });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const outcome = await readSsSmartHrSearchOutcome(page, frame, "Process EID");
  if (outcome.kind === "none") {
    const bodyText = await smartHR.transactionBody(frame).innerText({
      timeout: 5_000,
    });
    if (!isSsSmartHrNoMatchText(bodyText)) {
      throw new Error(
        `Process EID search for "${livedName}" did not render transaction results, ` +
        `a transaction detail page, or the verified "No matching values were found" state`,
      );
    }
    return {
      transactionFound: false,
      transactionId,
      eid: "",
      approvalStatus: "",
      effectiveDate: "",
    };
  }

  if (outcome.kind === "detail") {
    if (!outcome.detail || outcome.detail.transactionId !== transactionId) {
      return {
        transactionFound: false,
        transactionId,
        eid: "",
        approvalStatus: "",
        effectiveDate: "",
      };
    }
  } else {
    const exactRow = outcome.rows.find(
      (row) => row.transactionId.trim().toUpperCase() === transactionId,
    );
    if (!exactRow) {
      return {
        transactionFound: false,
        transactionId,
        eid: "",
        approvalStatus: "",
        effectiveDate: "",
      };
    }
    await safeClick(ssSmartHRTransactions.transactionResultRow(frame, transactionId), {
      timeout: 10_000,
      label: "ss smart hr exact transaction row (process eid)",
    });
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 10_000);
  }

  const receipt = await readSsSmartHrReceiptFields(page, frame, transactionId);
  if (!receipt.transactionId || !receipt.approvalStatus) {
    throw new Error(
      `Transaction ${transactionId}: detail page could not prove its transaction ID and approval status`,
    );
  }
  const routing = await readTransactionRoutingStrip(page, frame, transactionId);
  log.step(
    `[SS Smart HR] Process EID: name='${livedName}' txn='${transactionId}' ` +
    `status='${receipt.approvalStatus}' eid='${routing.eid || "<pending>"}'`,
  );
  return {
    transactionFound: true,
    transactionId,
    eid: routing.eid,
    approvalStatus: receipt.approvalStatus,
    effectiveDate: routing.effectiveDate,
  };
}

export async function findExistingHireTransaction(
  page: Page,
  opts: { firstName: string; lastName: string; effectiveDate?: string; templateId?: string },
): Promise<HireTransactionStatus> {
  const none: HireTransactionStatus = { found: false, transactionId: "", approvalStatus: "" };
  const searchName = buildHireSearchName(opts.firstName, opts.lastName);
  try {
    if (!searchName) {
      log.warn("[SS Smart HR] Empty name — skipping pre-submit hire existence check");
      return none;
    }
    log.step(
      `[SS Smart HR] Checking for an existing hire transaction: name='${searchName}' ` +
      `effDate='${opts.effectiveDate ?? "<none>"}' template='${opts.templateId ?? "<none>"}'`,
    );
    await navigateToSsSmartHrTransactions(page);
    const frame = getContentFrame(page);

    await safeFill(ssSmartHRTransactions.nameInput(frame), searchName, {
      timeout: 10_000,
      label: "ss smart hr name input (hire probe)",
    });
    await safeClick(ssSmartHRTransactions.searchButton(frame), {
      timeout: 10_000,
      label: "ss smart hr search button (hire probe)",
    });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const outcome = await readSsSmartHrSearchOutcome(page, frame, "hire probe");
    if (outcome.kind === "detail" && outcome.detail) {
      // Single match → PeopleSoft auto-opened the detail page; everything the
      // grid path drills in for is already on screen.
      const d = outcome.detail;
      const candidate = { transactionId: d.transactionId, action: d.action, approvalStatus: d.approvalStatus };
      const decision = decideHireDuplicateSkip(candidate, d.effectiveDate, opts.effectiveDate);
      if (!decision.skip) {
        log.step(
          `[SS Smart HR] Single match ${d.transactionId} (${d.action || "?"}/${d.approvalStatus || "?"}, ` +
          `effdt '${d.effectiveDate || "<unreadable>"}') for name='${searchName}' is NOT a high-confidence ` +
          `duplicate of this run (${decision.reason}) — safe to submit`,
        );
        return none;
      }
      log.warn(
        `[SS Smart HR] High-confidence existing hire for name='${searchName}': txn='${d.transactionId}' ` +
        `action='${d.action}' status='${d.approvalStatus}' effdt='${d.effectiveDate}' (${decision.reason}) ` +
        `— skipping submit to avoid a duplicate hire`,
      );
      return { found: true, transactionId: d.transactionId, approvalStatus: d.approvalStatus, effectiveDate: d.effectiveDate };
    }
    const rows = outcome.rows;
    log.debug(
      `[SS Smart HR] Hire probe scanned ${rows.length} row(s): ` +
      (rows.map((r) => `${r.transactionId}=${r.action}/${r.approvalStatus}`).join(", ") || "<none>"),
    );
    const hire = pickHireRow(rows);

    // Only an IN-FLIGHT/succeeded hire is worth drilling into for the effdt
    // check. A terminal-failed hire (or no hire at all) is decided immediately —
    // biasing straight to submit — without a wasted drill-in round-trip. The
    // pure gate is still the single source of truth for the skip.
    if (!hire || !isHireInFlightStatus(hire.approvalStatus)) {
      const decision = decideHireDuplicateSkip(hire ?? null, "", opts.effectiveDate);
      log.step(
        `[SS Smart HR] No high-confidence duplicate hire for name='${searchName}' ` +
        `(${decision.reason}) — safe to submit`,
      );
      return none;
    }

    // In-flight hire → drill into the row and read its effective date so the skip
    // is gated on THIS run's exact hire date (a same-named person's stale hire row
    // carries a different effdt and must NOT trip the skip). Read-only drill-in.
    const rowEffdt = await readHireEffectiveDate(page, frame, hire.transactionId);
    const decision = decideHireDuplicateSkip(hire, rowEffdt, opts.effectiveDate);
    if (!decision.skip) {
      log.warn(
        `[SS Smart HR] A ${hire.action}/${hire.approvalStatus} hire (txn='${hire.transactionId}', ` +
        `effdt='${rowEffdt || "<unreadable>"}') exists for name='${searchName}' but is NOT a ` +
        `high-confidence duplicate of this run (${decision.reason}) — proceeding with submit`,
      );
      return none;
    }
    log.warn(
      `[SS Smart HR] High-confidence existing hire for name='${searchName}': ` +
      `txn='${hire.transactionId}' action='${hire.action}' status='${hire.approvalStatus}' ` +
      `effdt='${rowEffdt}' (${decision.reason}) — skipping submit to avoid a duplicate hire`,
    );
    return {
      found: true,
      transactionId: hire.transactionId,
      approvalStatus: hire.approvalStatus,
      effectiveDate: rowEffdt,
    };
  } catch (e) {
    log.warn(
      `[SS Smart HR] Hire existence probe threw (treating as no existing hire — will proceed with submit): ${errorMessage(e)}`,
    );
    return none;
  }
}

/**
 * PURE: does a transaction-detail page's read-back Transaction ID prove we are
 * looking at the transaction we asked for?
 *
 * The one thing that makes a detail-page read trustworthy (live-verified
 * 2026-08-04): an UNKNOWN transaction id renders the ordinary SS Smart HR
 * search form with NO error and NO banner, and the bare route URL is
 * byte-identical after a reload — so "the page loaded" and "the URL says T…"
 * both prove nothing. Only a RESOLVED Transaction ID field whose text EQUALS
 * the requested id does. A blank read (the search form: the field is not on the
 * page at all) is therefore `false`, never a pass. Case- and
 * whitespace-insensitive. Unit-pinned.
 */
export function receiptMatchesRequestedTransaction(
  readTransactionId: string | null | undefined,
  requestedTransactionId: string | null | undefined,
): boolean {
  const read = (readTransactionId ?? "").replace(/\s+/g, "").trim().toUpperCase();
  const wanted = (requestedTransactionId ?? "").replace(/\s+/g, "").trim().toUpperCase();
  if (!read || !wanted) return false;
  return read === wanted;
}

/**
 * Read ONE display-only span off the SS Smart HR transaction detail page.
 *
 * Both receipt spans were live-verified as EXACTLY ONE node each (2026-08-04,
 * across 3 templates × 3 statuses: HIR/Approved, REH/Denied, XFR/Pending), so a
 * count other than 1 means the page is not the detail page we think it is — it
 * returns `""` (a distinguishable "unread"), never a guessed value. Every empty
 * return is logged; the caller turns "" into a loud tracker marker and must
 * never read it as approval.
 */
async function readReceiptSpan(locator: Locator, label: string): Promise<string> {
  let count: number;
  try {
    count = await locator.count();
  } catch (e) {
    log.warn(`[SS Smart HR] Could not count the ${label} on the transaction detail page: ${errorMessage(e)}`);
    return "";
  }
  if (count !== 1) {
    log.warn(
      `[SS Smart HR] Expected exactly 1 ${label} node on the transaction detail page, found ${count} — ` +
      `treating the field as UNREAD`,
    );
    return "";
  }
  try {
    const text = await locator.innerText({ timeout: 5_000 });
    return text.replace(/\s+/g, " ").trim();
  } catch (e) {
    log.warn(`[SS Smart HR] Could not read the ${label} on the transaction detail page: ${errorMessage(e)}`);
    return "";
  }
}

/**
 * Read the receipt PAIR (`transactionId`, `approvalStatus`) off the SS Smart HR
 * transaction DETAIL page the caller has already drilled into, and prove it is
 * the transaction we asked for.
 *
 * **Why the id must be re-asserted (live-verified 2026-08-04).** An UNKNOWN
 * transaction id renders the ordinary search form with NO error and NO banner,
 * and the bare route URL is byte-identical after a reload — so neither "the
 * page loaded" nor the URL is state evidence. The only proof is: the Transaction
 * ID span RESOLVED **and** its text EQUALS the requested id. Anything else
 * returns empty, which the caller must treat as "no receipt".
 *
 * **Dual-root probe.** The detail route renders at TOP level (`getContentFrame()`
 * resolves to nothing there) while the results grid it was reached from is
 * served inside `#main_target_win0`. Both roots are probed for the SAME unique
 * `RECORD_FIELD` id — a scope probe, not a substituted element — and neither
 * resolving is a loud failure.
 */
async function readSsSmartHrReceiptFields(
  page: Page,
  frame: FrameLocator,
  requestedTransactionId: string,
): Promise<{ transactionId: string; approvalStatus: string }> {
  const none = { transactionId: "", approvalStatus: "" };
  const wanted = requestedTransactionId.trim().toUpperCase();
  const roots: Array<Page | FrameLocator> = [page, frame];
  for (const root of roots) {
    const readId = await readReceiptSpan(
      ssSmartHRTransactions.transactionDetailTxnId(root),
      "Transaction ID",
    );
    if (!readId) continue;
    if (!receiptMatchesRequestedTransaction(readId, wanted)) {
      log.warn(
        `[SS Smart HR] The transaction detail page reports '${readId}' but ${wanted} was requested — ` +
        `refusing to read a receipt off a DIFFERENT transaction`,
      );
      return none;
    }
    const approvalStatus = await readReceiptSpan(
      ssSmartHRTransactions.transactionDetailApprovalStatus(root),
      "Approval Status",
    );
    if (!approvalStatus) {
      log.warn(
        `[SS Smart HR] Transaction ${wanted}'s approval status could not be read — ` +
        `an unread status is NOT an approval`,
      );
      return none;
    }
    return { transactionId: readId.toUpperCase(), approvalStatus };
  }
  log.warn(
    `[SS Smart HR] Transaction ${wanted}: the detail page's Transaction ID field did not resolve at ` +
    `page OR content-frame scope — an unknown id renders the ordinary search form with no error, ` +
    `so this is NOT a receipt`,
  );
  return none;
}

/**
 * Post-submit RECEIPT read for a Smart HR hire: find the hire this run just
 * submitted on the SS Smart HR list, drill into it, and return the PAIR
 * `(transactionId, approvalStatus)` read off its own detail page.
 *
 * **Distinct from — and the inverse of — {@link findExistingHireTransaction}.**
 * That is the PRE-submit duplicate guard, which must fail OPEN (any uncertainty
 * → submit) and therefore only ever reports an in-flight/approved hire; it
 * deliberately cannot see a Denied one. Using it as the post-submit readback
 * made a REFUSED hire indistinguishable from "the number could not be read",
 * so the operator was told to go look up a number for a transaction UCPath had
 * actually rejected. This reader reports whatever status the receipt carries —
 * `Approved`, `Pending`, `Denied` alike — and the pure
 * `interpretPostSubmitTxnReadback` decides what it proves.
 *
 * **Still effdt-gated to THIS run.** A NAME search is a PeopleSoft begins-with
 * match, so a different same-named person's hire row can come back; only a hire
 * whose effective date matches this run's EXACTLY ({@link hireEffectiveDateMatches})
 * is this run's receipt. An unreadable effdt fails the gate.
 *
 * **Never throws, never guesses.** Any failure (navigation, parse, no hire row,
 * effdt mismatch, unresolved detail fields) returns all-empty, which the caller
 * turns into a loud "submitted, receipt unproven" tracker marker. It must NOT
 * throw: the hire IS already submitted at this point, and failing the run would
 * invite a retry that could file a DUPLICATE hire.
 */
export async function readSubmittedHireReceipt(
  page: Page,
  opts: { firstName: string; lastName: string; effectiveDate?: string; templateId?: string },
): Promise<SubmittedHireReceipt> {
  const none: SubmittedHireReceipt = { transactionId: "", approvalStatus: "", effectiveDate: "" };
  const searchName = buildHireSearchName(opts.firstName, opts.lastName);
  try {
    if (!searchName) {
      log.warn("[SS Smart HR] Empty name — cannot read back the submitted hire's receipt");
      return none;
    }
    log.step(
      `[SS Smart HR] Reading back the submitted hire's receipt: name='${searchName}' ` +
      `effDate='${opts.effectiveDate ?? "<none>"}' template='${opts.templateId ?? "<none>"}'`,
    );
    await navigateToSsSmartHrTransactions(page);
    const frame = getContentFrame(page);

    await safeFill(ssSmartHRTransactions.nameInput(frame), searchName, {
      timeout: 10_000,
      label: "ss smart hr name input (hire receipt readback)",
    });
    await safeClick(ssSmartHRTransactions.searchButton(frame), {
      timeout: 10_000,
      label: "ss smart hr search button (hire receipt readback)",
    });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const outcome = await readSsSmartHrSearchOutcome(page, frame, "hire receipt readback");
    if (outcome.kind === "detail" && outcome.detail) {
      const d = outcome.detail;
      if (!new Set<string>(HIRE_ACTION_CODES).has(d.action)) {
        log.warn(`[SS Smart HR] Single match ${d.transactionId} for name='${searchName}' is not a hire (action '${d.action || "<none>"}') — not this run's receipt`);
        return none;
      }
      if (opts.effectiveDate && !hireEffectiveDateMatches(d.effectiveDate, opts.effectiveDate)) {
        log.warn(
          `[SS Smart HR] Single match ${d.transactionId} has effdt '${d.effectiveDate || "<unreadable>"}', which does not ` +
          `exactly match this run's effective date '${opts.effectiveDate}' — NOT this run's receipt`,
        );
        return none;
      }
      if (!d.transactionId || !d.approvalStatus) return none;
      log.step(`[SS Smart HR] Hire receipt (detail page) for name='${searchName}': txn='${d.transactionId}' status='${d.approvalStatus}' effdt='${d.effectiveDate}'`);
      return { transactionId: d.transactionId, approvalStatus: d.approvalStatus, effectiveDate: d.effectiveDate };
    }
    const rows = outcome.rows;
    log.debug(
      `[SS Smart HR] Hire receipt readback scanned ${rows.length} row(s): ` +
      (rows.map((r) => `${r.transactionId}=${r.action}/${r.approvalStatus}`).join(", ") || "<none>"),
    );
    const hire = pickHireRow(rows);
    if (!hire) {
      log.warn(
        `[SS Smart HR] No hire (HIR/REH) row for name='${searchName}' — the submitted hire's ` +
        `receipt could not be read back`,
      );
      return none;
    }

    // Drill in — this leaves the browser on the transaction DETAIL page, which
    // is where the receipt pair lives.
    const effectiveDate = await readTransactionEffdt(page, frame, hire.transactionId, "submitted hire");
    if (opts.effectiveDate && !hireEffectiveDateMatches(effectiveDate, opts.effectiveDate)) {
      log.warn(
        `[SS Smart HR] Hire row ${hire.transactionId} has effdt '${effectiveDate || "<unreadable>"}', which ` +
        `does not exactly match this run's effective date '${opts.effectiveDate}' — it is a DIFFERENT hire ` +
        `event (possibly a different same-named person), so it is NOT this run's receipt`,
      );
      return none;
    }

    const fields = await readSsSmartHrReceiptFields(page, frame, hire.transactionId);
    if (!fields.transactionId || !fields.approvalStatus) return none;
    log.step(
      `[SS Smart HR] Hire receipt for name='${searchName}': txn='${fields.transactionId}' ` +
      `status='${fields.approvalStatus}' effdt='${effectiveDate}'`,
    );
    return {
      transactionId: fields.transactionId,
      approvalStatus: fields.approvalStatus,
      effectiveDate,
    };
  } catch (e) {
    log.warn(
      `[SS Smart HR] Hire receipt readback threw — the submit is NOT confirmed and the receipt stays ` +
      `unproven (the run is deliberately not failed here: the hire is already submitted and a retry ` +
      `could file a duplicate): ${errorMessage(e)}`,
    );
    return none;
  }
}

/**
 * Drill into a transaction from the SS Smart HR results grid (by its Transaction
 * ID) and read its effective date. SHARED browser glue for both the termination
 * effdt read (separations' approved-reuse gate) and the hire effdt read
 * (onboarding's duplicate-hire gate). The detail page's approval strip reads
 * `… Effdt: 2023-10-08, …` (ISO); a `Start Date` cell (`MM/DD/YYYY`) is the
 * fallback. Read via page text + regex so it doesn't hinge on an exact cell
 * selector. Read-only (drilling into a detail view) — safe in dry-run. Returns
 * "" if the transaction couldn't be opened or no date was found. `label` only
 * tunes the log wording.
 *
 * The results-grid drill-in target (`transactionResultRow`) and the detail
 * page's `Effdt:` text were live-verified via playwright-cli on 2026-06-24
 * (EID 10797079 → row T001928408 → "Effdt: 2025-07-01"). The clickable element
 * is the result ROW `<tr>`, not a hyperlink — the Transaction ID cell is a
 * display-only `<span>`, which is why the old link selector timed out and the
 * step silently fell back to reusing a prior-job TER.
 */
async function readTransactionEffdt(
  page: Page,
  frame: FrameLocator,
  transactionId: string,
  label: string,
): Promise<string> {
  try {
    await safeClick(ssSmartHRTransactions.transactionResultRow(frame, transactionId), {
      timeout: 10_000,
      label: "ss smart hr transaction drill-in row",
    });
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 10_000);
    const text = await frame
      .locator("body") // allow-inline-selector -- body text read for the transaction detail effdt
      .evaluate((b) => (b as HTMLElement).innerText ?? "")
      .catch(() => "");
    const iso = text.match(/Effdt:\s*(\d{4}-\d{1,2}-\d{1,2})/i);
    if (iso) return iso[1];
    const us = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    return us ? us[1] : "";
  } catch (e) {
    log.warn(`[SS Smart HR] Could not open ${label} ${transactionId} to read its effective date: ${errorMessage(e)}`);
    return "";
  }
}

/**
 * Termination-flavored effdt read (separations' approved-reuse gate) — thin
 * wrapper over {@link readTransactionEffdt}. See that helper for the live-verified
 * drill-in mechanism.
 */
async function readTerminationEffectiveDate(
  page: Page,
  frame: FrameLocator,
  transactionId: string,
): Promise<string> {
  return readTransactionEffdt(page, frame, transactionId, "TER");
}

/**
 * Hire-flavored effdt read (onboarding's duplicate-hire gate) — thin wrapper over
 * {@link readTransactionEffdt}, mirroring {@link readTerminationEffectiveDate}. A
 * HIR row uses the same results grid + detail-page shape as a TER, so the same
 * drill-in ROW selector + `Effdt:` read apply. Read-only — safe in dry-run.
 * NEEDS LIVE VERIFICATION on a real HIR detail page (the TER path is verified;
 * the HIR path is not yet live-exercised).
 */
async function readHireEffectiveDate(
  page: Page,
  frame: FrameLocator,
  transactionId: string,
): Promise<string> {
  return readTransactionEffdt(page, frame, transactionId, "hire");
}

/** PeopleSoft transaction id, e.g. "T002168976". */
const SS_TXN_ID_RE = /^T\d{4,}$/i;
/** A 3-letter action code (TER / HIR / REH / XFR …) — excludes BU "SDCMP" (5). */
const SS_ACTION_RE = /^[A-Z]{3}$/;
/** Approval-status keywords seen on the SS Smart HR grid. */
const SS_STATUS_RE =
  /^(approved|pending|denied|cancel(?:l?ed)?|error|pushed\s*back|manually\s*processed|processed|saved|recycled|needs?\s*(?:review|correction))$/i;

/**
 * Parse the SS Smart HR Transactions results grid (collected as a cell-text
 * matrix — one inner array per `<tr>`) into transaction rows. PURE + unit-pinned
 * so the parse is testable without a browser.
 *
 * Two passes, deduped by transaction id (first occurrence wins — the grid lists
 * newest first):
 *   A. HEADER-KEYED — find the header row (cells carrying "Transaction ID",
 *      "Action", "Approval Status"), map those columns by position, read the
 *      data rows whose mapped Transaction ID column looks like a real T-id.
 *   B. PATTERN (header-independent) — any row carrying a T-id cell + a status
 *      keyword (and, when present, a 3-letter action code), regardless of column
 *      order or a missing/merged header. This is what makes the parse survive
 *      PeopleSoft nesting/splitting that broke the header-only scan (an APPROVED
 *      TER for EID 10759273 was missed live → transaction-check wrongly created a
 *      duplicate that UCPath then rejected, 2026-06-24).
 */
export function parseSsSmartHrRows(rows: string[][]): SsSmartHrRow[] {
  const norm = (s: string): string => (s ?? "").replace(/\s+/g, " ").trim();
  const out: SsSmartHrRow[] = [];
  const seen = new Set<string>();

  // Pass A — header-keyed.
  let headerIdx = -1, txIdx = -1, actIdx = -1, statIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(norm);
    const tx = cells.findIndex((t) => /transaction id/i.test(t));
    const act = cells.findIndex((t) => /^action$/i.test(t));
    const st = cells.findIndex((t) => /approval\s*status/i.test(t));
    if (tx >= 0 && act >= 0 && st >= 0) {
      headerIdx = i; txIdx = tx; actIdx = act; statIdx = st;
      break;
    }
  }
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = rows[i].map(norm);
      if (cells.length <= Math.max(txIdx, actIdx, statIdx)) continue;
      const transactionId = cells[txIdx] ?? "";
      if (!SS_TXN_ID_RE.test(transactionId) || seen.has(transactionId)) continue;
      seen.add(transactionId);
      out.push({ transactionId, action: cells[actIdx] ?? "", approvalStatus: cells[statIdx] ?? "" });
    }
  }

  // Pass B — pattern fallback (header-independent).
  for (const raw of rows) {
    const cells = raw.map(norm);
    const transactionId = cells.find((c) => SS_TXN_ID_RE.test(c)) ?? "";
    if (!transactionId || seen.has(transactionId)) continue;
    const approvalStatus = cells.find((c) => SS_STATUS_RE.test(c)) ?? "";
    if (!approvalStatus) continue;
    const action = cells.find((c) => SS_ACTION_RE.test(c)) ?? "";
    seen.add(transactionId);
    out.push({ transactionId, action, approvalStatus });
  }

  return out;
}

/**
 * Scan the SS Smart HR Transactions results grid. The DOM step only collects a
 * cell-text matrix (each `<tr>`'s direct cells); the dual-pass parse is the pure
 * `parseSsSmartHrRows`. Returns `[]` when the grid genuinely has no rows (the
 * `evaluate` resolves with an empty matrix). A THROWN `evaluate` (the DOM read
 * itself failing) is NOT swallowed here — it propagates to the caller instead of
 * masquerading as "no results found" (fail loud: a caller must not read a
 * failed probe as a confident empty grid).
 */
async function scanSsSmartHrResults(frame: FrameLocator): Promise<SsSmartHrRow[]> {
  const matrix = await frame.locator("body").evaluate((body) => { // allow-inline-selector -- body scan for SS Smart HR results grid
    const out: string[][] = [];
    for (const tr of Array.from(body.querySelectorAll("tr"))) {
      const cells = Array.from(tr.querySelectorAll(":scope > th, :scope > td")).map(
        (c) => (c.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
      if (cells.length) out.push(cells);
    }
    return out;
  });
  return parseSsSmartHrRows(matrix);
}


/** Read every TER candidate's actual employment record and position before reuse. */
async function findTerminationForJob(page: Page, eid: string, job: SeparationJob, effectiveDate: string, expectedComments: string): Promise<TerminationTransactionStatus> {
  matchesSeparationJob(job, job); // Reject an incomplete target before any navigation.
  await navigateToSsSmartHrTransactions(page);
  const frame = getContentFrame(page);
  await safeFill(ssSmartHRTransactions.emplIdInput(frame), eid, { label: "termination job employee" });
  await safeClick(ssSmartHRTransactions.searchButton(frame), { label: "termination job search" });
  await waitForPeopleSoftProcessing(frame, 15_000);
  await page.waitForLoadState("networkidle");
  let candidates: string[];
  if (await ssSmartHRTransactions.transactionDetailTxnId(frame).count() === 1) {
    const body = await smartHR.transactionBody(frame).innerText();
    candidates = /\bTER\b/.test(body) ? [(await ssSmartHRTransactions.transactionDetailTxnId(frame).innerText()).trim()] : [];
  } else {
    const rows = await scanSsSmartHrResults(frame);
    if (rows.length >= 100) throw new Error(`SS Smart HR results for ${eid} may be truncated; cannot establish termination uniqueness`);
    if (!rows.length && !/No matching values/i.test(await smartHR.transactionBody(frame).innerText())) {
      throw new Error(`SS Smart HR search for ${eid} did not render a verified result`);
    }
    candidates = rows.filter(r => r.action.trim() === "TER").map(r => r.transactionId);
  }
  const openReceipt = async (id: string): Promise<{ status: string; effectiveDate: string }> => {
    await navigateToSsSmartHrTransactions(page);
    await safeFill(ssSmartHRTransactions.txnNumberTextbox(frame), id, { label: "termination receipt number" });
    await safeClick(ssSmartHRTransactions.searchButton(frame), { label: "termination receipt search" });
    await ssSmartHRTransactions.transactionDetailTxnId(frame).filter({ hasText: id }).waitFor();
    const actualId = (await ssSmartHRTransactions.transactionDetailTxnId(frame).innerText()).trim();
    const status = (await ssSmartHRTransactions.transactionDetailApprovalStatus(frame).innerText()).trim();
    if (actualId !== id || !status) throw new Error(`Cannot verify termination receipt ${id}`);
    const receiptEffectiveDate = detailPageEffdt(await smartHR.transactionBody(frame).innerText());
    if (!hireEffectiveDateMatches(receiptEffectiveDate, effectiveDate)) {
      // This receipt has a different effective date, so it cannot be this
      // separation. Its detail page need not expose a mutable job form.
      log.step(
        `[SS Smart HR] Receipt ${id} effdt '${receiptEffectiveDate || "<unreadable>"}' does not match ` +
        `this separation's effective date '${effectiveDate}' — prior termination skipped`,
      );
      return { status, effectiveDate: receiptEffectiveDate };
    }
    await safeClick(ssSmartHRTransactions.detailPersonLink(frame), { label: "termination receipt employee" });
    await waitForPeopleSoftProcessing(frame, 15_000);
    const dialogText = await readPeopleSoftDialogText(page);
    if (dialogText) {
      await dismissPeopleSoftDialog(page);
      throw new Error(`UCPath dialog on receipt ${id}: "${dialogText}"`);
    }
    const employmentRecord = smartHR.employmentRecordSelect(frame);
    if (await employmentRecord.count() === 1) {
      await safeClick(smartHR.continueButton(frame), { label: "termination receipt continue" });
      await waitForPeopleSoftProcessing(frame, 15_000);
      await page.waitForLoadState("networkidle");
    } else if (await jobData.positionNumberInput(frame).count() !== 1) {
      const postDialog = await readPeopleSoftDialogText(page);
      if (postDialog) {
        await dismissPeopleSoftDialog(page);
        throw new Error(`UCPath dialog on receipt ${id}: "${postDialog}"`);
      }
      throw new Error(
        `Termination receipt ${id} did not open a verified job form after employee drill-in: ` +
        "Employment Record Number and Position Number are both absent",
      );
    } else {
      // A one-record receipt opens its termination form directly: no record chooser
      // or Continue button is rendered. `readTerminationJob` below still proves the
      // EID, employment record, position, and effective date before reuse.
      log.step(`[SS Smart HR] Receipt ${id} opened its job form directly (single employment record)`);
    }
    return { status, effectiveDate: receiptEffectiveDate };
  };
  const matches: TerminationTransactionStatus[] = [];
  for (const id of candidates) {
    const receipt = await openReceipt(id);
    if (!hireEffectiveDateMatches(receipt.effectiveDate, effectiveDate)) continue;
    const actual = await readTerminationJob(frame);
    if (actual.eid !== eid) throw new Error(`Receipt ${id} belongs to ${actual.eid}, expected ${eid}`);
    if (!matchesSeparationJob(actual, job)) continue;
    if (receipt.status === "Pending" && actual.effectiveDate !== effectiveDate) {
      throw new Error(`Pending termination ${id} for record ${job.emplRecord}, position ${job.positionNumber} has effective date ${actual.effectiveDate}, expected ${effectiveDate}; resolve that transaction before creating another`);
    }
    if (actual.effectiveDate !== effectiveDate) continue;
    if (receipt.status === "Approved" || receipt.status === "Pending") {
      const commVal = await comments.commentsTextarea(frame).inputValue();
      const initVal = await comments.initiatorCommentsTextarea(frame).inputValue();
      if (!commentsMatchTermination(commVal, expectedComments) || !commentsMatchTermination(initVal, expectedComments)) {
        throw new Error(`Termination ${id} has incorrect Comments or Initiator Comments; correct it before reuse`);
      }
      matches.push({ found: true, transactionId: id, approvalStatus: receipt.status, effectiveDate });
    } else if (!/^(Denied|Cancelled|Canceled|Refused)$/.test(receipt.status)) {
      throw new Error(`Unrecognized termination status ${receipt.status} for ${id}`);
    }
  }
  if (matches.length > 1) throw new Error(`Multiple terminations match ${eid}/${job.emplRecord}/${job.positionNumber}/${effectiveDate}: ${matches.map(m => m.transactionId).join(", ")}`);
  const match = matches[0];
  if (match && match.transactionId !== candidates.at(-1)) {
    const receipt = await openReceipt(match.transactionId);
    const actual = await readTerminationJob(frame);
    const commVal = await comments.commentsTextarea(frame).inputValue();
    const initVal = await comments.initiatorCommentsTextarea(frame).inputValue();
    if (receipt.status !== match.approvalStatus || !hireEffectiveDateMatches(receipt.effectiveDate, effectiveDate) || actual.eid !== eid || actual.effectiveDate !== effectiveDate || !matchesSeparationJob(actual, job)
      || !commentsMatchTermination(commVal, expectedComments) || !commentsMatchTermination(initVal, expectedComments)) {
      throw new Error(`Termination ${match.transactionId} changed while restoring its audit receipt`);
    }
  }
  return match ?? { found: false, transactionId: "", approvalStatus: "", effectiveDate: "" };
}
