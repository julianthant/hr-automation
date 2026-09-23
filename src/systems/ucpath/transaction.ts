import { commentsMatchTermination, matchesSeparationJob, type SeparationJob } from "../../domain/separation-job.js";
import { findTerminationTransactionStatus } from "./ss-smart-hr.js";
import { readTerminationJob, verifyTerminationJob } from "./termination-job.js";
import type { Page, FrameLocator, Locator } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import type { TransactionResult } from "./types.js";
import {
  waitForPeopleSoftProcessing,
  navigateToSmartHR,
  collapseSidebar,
  dismissPeopleSoftDialog,
  readPeopleSoftDialogText,
} from "./navigate.js";
import {
  smartHR,
  hrTasks,
  ssSmartHRTransactions,
  personalData as personalDataSelectors,
  comments as commentsSelectors,
  termination as terminationSelectors,
  jobData as jobDataSelectors,
  getContentFrame,
} from "./selectors.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";

// ─── Transaction outcome verification (error banner vs success marker) ───────

/**
 * Pure decision for one poll tick of {@link waitForTransactionOutcome}: given
 * whether the error banner and the success marker are currently visible,
 * classify this tick. An error banner takes precedence over a success marker (a
 * PeopleSoft form can briefly paint both mid-render; the error banner is the
 * authoritative failure signal). Unit-pinned.
 */
export function classifyOutcomeSignals(
  errorVisible: boolean,
  successVisible: boolean,
): "error" | "success" | "pending" {
  if (errorVisible) return "error";
  if (successVisible) return "success";
  return "pending";
}

/**
 * Poll for a DEFINITIVE transaction outcome — the error banner appearing OR a
 * success marker (a positive next-page element) appearing — instead of sampling
 * `errorBanner.count()` ONCE right after a fixed sleep. A banner that renders
 * late read `count() === 0` at that single instant and wrongly returned
 * `{ success: true }` for a transaction that actually errored. Returns
 * `"timeout"` when neither resolves in the window so callers can fall back to
 * the legacy point-in-time check (behavior never regresses below today's).
 */
export async function waitForTransactionOutcome(
  errorLocator: Locator,
  successLocator: Locator,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<"error" | "success" | "timeout"> {
  const { timeoutMs = 20_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errorVisible = (await errorLocator.count().catch(() => 0)) > 0;
    const successVisible = await successLocator.first().isVisible().catch(() => false);
    const signal = classifyOutcomeSignals(errorVisible, successVisible);
    if (signal !== "pending") return signal;
    await sleep(pollMs);
  }
  return "timeout";
}

// ─── Submit-time "Person Match Found" page (PeopleSoft Search/Match review) ──
//
// Save and Submit can land on UCPath's own Search/Match review page instead of
// the confirmation dialog when the hire's name/DOB/SSN resembles an existing
// person. Until 2026-08-20 the automation had no signal for it: the submit
// "timed out with no error banner and no confirmation OK dialog" (live runs
// 99d5012c Hao Sun — 10 same-surname candidates; ebd5d59e Emily Robles — one
// namesake with a different SSN + DOB). Nothing is persisted on that page, so
// the hire simply never filed.
//
// The decision is deliberately narrow and fail-loud. We click "Not a Match -
// Continue with Hire" ONLY when EVERY listed candidate is excluded by one of:
//   (1) a HARD identifier that is known on both sides and DIFFERS — the
//       Date of Birth month/day (UCPath masks the year) or the National ID
//       last-4 (UCPath masks the rest); a name is never evidence (Search/Match
//       is fuzzy on names by design, see LESSONS.md 2026-08-06), or
//   (2) the operator having REVIEWED that exact Person ID and confirmed it is
//       not this hire (`notMatchEids`, supplied via the `prefilledData`
//       channel — `data.notMatchEids`, comma-separated EIDs).
// Anything else (a candidate with no comparable identifier, or one the operator
// never saw) refuses to continue: the run fails with the candidate table in the
// error so the operator can review and re-run with the reviewed EIDs. A
// candidate that merely "looks different by name" is NOT excluded — that is the
// wrong-person risk this page exists to catch.

export interface PersonMatchCandidate {
  /** UCPath Person ID (EID) of the possible match. */
  personId: string;
  firstName: string;
  lastName: string;
  /** Last 4 digits of the masked National ID (`*****9035` → `9035`); "" when unknown (`*****XXXX`/blank). */
  nationalIdLast4: string;
  /** Masked Date of Birth as shown (`10/8/****`) normalized to `M/D`; "" when blank. */
  dobMonthDay: string;
}

/** The hire's own comparable identifiers (from CRM), as known to this run. */
export interface PersonMatchHireIdentity {
  /** Last 4 of the hire's REAL SSN; "" / undefined when the hire has no SSN. */
  ssnLast4?: string;
  /** The hire's DOB in any `M/D/YYYY` / `MM/DD/YYYY` form; "" / undefined when unknown. */
  dob?: string;
}

/** `*****9035` → `9035`; `*****XXXX`, blank, or anything without 4 trailing digits → "". */
export function normalizeNationalIdLast4(raw: string | null | undefined): string {
  const m = /(\d{4})\s*$/.exec((raw ?? "").trim());
  return m ? m[1] : "";
}

/** `10/8/****`, `08/26/2007`, `8/26` → `8/26`; anything unparseable → "". */
export function normalizeDobMonthDay(raw: string | null | undefined): string {
  const m = /^\s*(\d{1,2})\/(\d{1,2})(?:\/|\s|$)/.exec(raw ?? "");
  if (!m) return "";
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${month}/${day}`;
}

/** Last 4 digits of an SSN in any punctuation (`123-45-6789` → `6789`); "" when absent. */
export function ssnLast4(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/**
 * A candidate is excluded by a HARD identifier when a comparable value is known
 * on BOTH sides and differs. Unknown on either side → not excluded (we cannot
 * tell them apart, so we must not continue blind). Names are never consulted.
 */
export function candidateExcludedByHardIdentifier(
  candidate: PersonMatchCandidate,
  hire: PersonMatchHireIdentity,
): boolean {
  const hireDob = normalizeDobMonthDay(hire.dob);
  const candDob = normalizeDobMonthDay(candidate.dobMonthDay);
  if (hireDob && candDob && hireDob !== candDob) return true;
  const hireSsn4 = ssnLast4(hire.ssnLast4);
  const candSsn4 = normalizeNationalIdLast4(candidate.nationalIdLast4);
  if (hireSsn4 && candSsn4 && hireSsn4 !== candSsn4) return true;
  return false;
}

export interface PersonMatchDecision {
  /** true ⇢ click "Not a Match - Continue with Hire"; false ⇢ fail loud for review. */
  proceed: boolean;
  /** Candidates that nothing excluded (empty when `proceed`). */
  unresolved: PersonMatchCandidate[];
  /** Per-candidate reason, for the log/tracker. */
  reasons: Array<{ personId: string; reason: "hard-identifier-mismatch" | "operator-reviewed" | "unresolved" }>;
}

/**
 * Pure decision for the Person Match Found page. `proceed` requires at least one
 * candidate (an empty grid is an unexpected page state → review) AND every
 * candidate excluded by a hard identifier or by an operator-reviewed EID.
 * Unit-pinned.
 */
export function decidePersonMatchContinue(
  candidates: readonly PersonMatchCandidate[],
  hire: PersonMatchHireIdentity,
  notMatchEids: readonly string[],
): PersonMatchDecision {
  const reviewed = new Set(notMatchEids.map((e) => e.trim()).filter(Boolean));
  const reasons: PersonMatchDecision["reasons"] = [];
  const unresolved: PersonMatchCandidate[] = [];
  for (const c of candidates) {
    if (candidateExcludedByHardIdentifier(c, hire)) {
      reasons.push({ personId: c.personId, reason: "hard-identifier-mismatch" });
    } else if (c.personId && reviewed.has(c.personId)) {
      reasons.push({ personId: c.personId, reason: "operator-reviewed" });
    } else {
      reasons.push({ personId: c.personId, reason: "unresolved" });
      unresolved.push(c);
    }
  }
  return { proceed: candidates.length > 0 && unresolved.length === 0, unresolved, reasons };
}

/** One-line, log/tracker-friendly rendering of a candidate. */
export function formatPersonMatchCandidate(c: PersonMatchCandidate): string {
  return `${c.personId || "<no id>"} ${c.firstName} ${c.lastName}`.trim()
    + ` (NID ***${c.nationalIdLast4 || "????"}, DOB ${c.dobMonthDay || "?"})`;
}

/**
 * Pure per-tick classification of the submit signals. Priority: error banner,
 * then Person Match Found, then Select an Action (inactive-instance choice),
 * then the confirmation OK marker. The confirmation OK locator
 * (`getByRole("button", { name: "OK" })`) can resolve to unrelated OK-named
 * controls on a busy page, so named review pages must be checked BEFORE the
 * generic success marker. Unit-pinned.
 */
export function classifySubmitSignals(
  errorVisible: boolean,
  personMatchVisible: boolean,
  successVisible: boolean,
  selectActionVisible = false,
): "error" | "person-match" | "select-action" | "success" | "pending" {
  if (errorVisible) return "error";
  if (personMatchVisible) return "person-match";
  if (selectActionVisible) return "select-action";
  if (successVisible) return "success";
  return "pending";
}

/**
 * Read the "Possible Person Matches" grid off the Person Match Found page.
 * Columns are mapped by HEADER TEXT (Person ID / Legal First Name / Legal Last
 * Name / National ID / Date of Birth) so a column reorder cannot silently shift
 * a value into the wrong field; a data row is any row in that table whose first
 * cell holds the "Select" button. Throws when the header row cannot be found —
 * an unreadable grid must never be mistaken for "no candidates".
 */
export async function readPersonMatchCandidates(frame: FrameLocator): Promise<PersonMatchCandidate[]> {
  const rows = await smartHR.personMatchCandidateRows(frame).evaluateAll((trs) => {
    // No named bindings in here: esbuild keep-names would wrap them in
    // `__name(...)`, undefined inside the page (architecture guard).
    if (trs.length === 0) return { error: "no candidate rows (no row with a Select button)", rows: [] as string[][] };
    const table = (trs[0] as HTMLElement).closest("table");
    if (!table) return { error: "candidate row has no enclosing table", rows: [] as string[][] };
    // Header row: the first row in this table whose cells include "Person ID".
    let headers: string[] | null = null;
    for (const tr of Array.from(table.querySelectorAll("tr"))) {
      const cells = Array.from(tr.children).map((c) => ((c as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim());
      if (cells.some((c) => /^Person ID$/i.test(c)) && cells.some((c) => /Legal Last/i.test(c))) {
        headers = cells;
        break;
      }
    }
    if (!headers) return { error: "header row with 'Person ID' + 'Legal Last Name' not found", rows: [] as string[][] };
    const data: string[][] = [];
    for (const tr of trs) {
      const cells = Array.from((tr as HTMLElement).children).map((c) => ((c as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim());
      data.push(cells);
    }
    return { error: "", headers, rows: data };
  });
  if (rows.error) throw new Error(`Person Match Found grid unreadable: ${rows.error}`);
  const headers = rows.headers as string[];
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const iPid = col(/^Person ID$/i);
  const iFirst = col(/Legal First/i);
  const iLast = col(/Legal Last/i);
  const iNid = col(/National ID/i);
  const iDob = col(/Date of Birth/i);
  if (iPid < 0 || iFirst < 0 || iLast < 0 || iNid < 0 || iDob < 0) {
    throw new Error(
      `Person Match Found grid headers unexpected: [${headers.join(" | ")}] — refusing to map columns by guess`,
    );
  }
  return rows.rows
    .map((cells) => ({
      personId: (cells[iPid] ?? "").trim(),
      firstName: (cells[iFirst] ?? "").trim(),
      lastName: (cells[iLast] ?? "").trim(),
      nationalIdLast4: normalizeNationalIdLast4(cells[iNid]),
      dobMonthDay: normalizeDobMonthDay(cells[iDob]),
    }))
    .filter((c) => c.personId.length > 0);
}

/**
 * Bounded best-effort wait for a NAMED page condition — a specific element
 * becoming visible (default) or hidden (`state: "hidden"`, e.g. "the wizard
 * left the reason-code page") — as a drop-in replacement for a fixed
 * `waitForTimeout` sleep. Returns whether the condition was observed within
 * the cap.
 *
 * On timeout it logs and returns `false` so the caller PROCEEDS: the very next
 * `safeClick`/`safeFill` carries its own actionability wait (the backstop that
 * existed before too). It never throws, so worst-case behavior is strictly no
 * worse than the fixed sleep it replaces — and on the happy path it returns as
 * soon as the real post-condition is met instead of always burning the full
 * fixed interval. Caps are set ≥ 2× the sleep they replace.
 */
export async function waitForNamedCondition(
  locator: Locator,
  opts: { timeoutMs: number; label: string; state?: "visible" | "hidden" },
): Promise<boolean> {
  const { timeoutMs, label, state = "visible" } = opts;
  const seen = await locator
    .first()
    .waitFor({ state, timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    log.step(
      `[wait] '${label}' not confirmed within ${timeoutMs}ms — proceeding `
      + `(the next safeClick/safeFill actionability wait is the backstop)`,
    );
  }
  return seen;
}

// ─── STEP 1: Navigate sidebar → Smart HR Templates → Smart HR Transactions ───

/**
 * Click "Smart HR Templates" in the sidebar to expand it, then click
 * "Smart HR Transactions" child link. Loads the transaction form in the iframe.
 *
 * After clicking, must collapse navigation sidebar so it doesn't block
 * buttons in the iframe (PeopleSoft overlay issue).
 */
export async function clickSmartHRTransactions(page: Page): Promise<void> {
  log.step("Clicking Smart HR Templates in sidebar...");

  await safeClick(hrTasks.smartHRTemplatesLink(page), {
    timeout: 10_000,
    label: "ucpath smart hr templates sidebar link",
  });
  await page.waitForTimeout(1_000);

  log.step("Clicking Smart HR Transactions...");
  await safeClick(hrTasks.smartHRTransactionsLink(page), {
    timeout: 10_000,
    label: "ucpath smart hr transactions sidebar link",
  });
  // Replaces a fixed 5s sleep: wait for the actual post-condition — the Smart HR
  // Transactions form rendering inside the content iframe (its "Select Template"
  // textbox is present on this page for every caller, both the create flow and
  // the list-scan callers). networkidle guards the iframe load; the template
  // input becoming visible is the named confirmation the form is interactive.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForNamedCondition(smartHR.templateInput(getContentFrame(page)), {
    timeoutMs: 15_000,
    label: "smart hr transactions form (Select Template textbox)",
  });

  // Collapse the sidebar navigation to prevent overlay blocking iframe buttons
  log.step("Collapsing sidebar navigation...");
  await collapseSidebar(page);

  log.success("Smart HR Transactions page loaded");
}

// ─── STEP 2: Select template + effective date + Create Transaction ───

/**
 * Fill the template input with e.g. UC_FULL_HIRE.
 */
export async function selectTemplate(
  frame: FrameLocator,
  templateId: string,
): Promise<void> {
  log.step(`Selecting template: ${templateId}`);

  await safeFill(smartHR.templateInput(frame), templateId, {
    timeout: 10_000,
    label: "ucpath smart hr template input",
  });

  log.step(`Template: "${templateId}" selected for this transaction`);
  log.success(`Template "${templateId}" selected`);
}

/**
 * Fill the effective date field.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param date - Date string in MM/DD/YYYY format
 */
export async function enterEffectiveDate(
  frame: FrameLocator,
  date: string,
): Promise<void> {
  log.step(`Entering effective date: ${date}`);

  await safeFill(smartHR.effectiveDateInput(frame), date, {
    timeout: 10_000,
    label: "ucpath smart hr effective date",
  });

  log.success("Effective date entered");
}

/**
 * Click the Create Transaction button and wait for the form to load.
 *
 * @param _page - Playwright page (kept for call-site arity/API stability; the
 *   create round-trip is now observed via frame-scoped waits, so the page
 *   handle itself is unused since the fixed 5s sleep was removed 2026-07-06)
 * @param frame - PeopleSoft content iframe FrameLocator
 * @returns TransactionResult indicating success or failure
 */
export async function clickCreateTransaction(
  _page: Page,
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Create Transaction...");

  await safeClick(smartHR.createTransactionButton(frame), {
    timeout: 10_000,
    label: "ucpath create transaction button",
  });

  // Wait for PeopleSoft server round-trip. The prior fixed 5s sleep sat BEFORE
  // waitForPeopleSoftProcessing, so by the time the spinner wait ran the spinner
  // had usually already come and gone (it no-op'd on its 2s appear-timeout).
  // Dropping the sleep lets waitForPeopleSoftProcessing actually observe the
  // create round-trip's spinner appear→disappear, and the DEFINITIVE named
  // condition — the reason-code page rendering vs. the error banner — is the
  // waitForTransactionOutcome poll below (20s cap, the real success marker).
  log.step("Waiting for PeopleSoft to process transaction creation...");
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Decide on a DEFINITIVE outcome — error banner vs the reason-code page (the
  // next step's dropdown) rendering — rather than sampling errorBanner.count()
  // once (a late-rendering banner read 0 at that instant and returned success
  // for a failed create). On timeout, fall back to the legacy point-in-time
  // check so behavior never regresses.
  const errorLocator = smartHR.errorBanner(frame);
  const successMarker = smartHR.reasonCodeSelect(frame);
  // 30s cap (was 20s): the fixed 5s pre-sleep above was removed, so the poll
  // starts earlier — the longer cap keeps the definitive-outcome window ≥ the
  // old sleep+poll total (worst case strictly no worse).
  const outcome = await waitForTransactionOutcome(errorLocator, successMarker, { timeoutMs: 30_000 });
  if (outcome === "error" || (outcome === "timeout" && (await errorLocator.count().catch(() => 0)) > 0)) {
    const errorText = await errorLocator.nth(0).textContent({ timeout: 5_000 }).catch(() => null);
    log.error(`Transaction creation error: ${errorText ?? "Unknown error"}`);
    return { success: false, error: errorText ?? "Unknown error" };
  }

  // A timeout is NOT a confirmation. If the poll window expired with no error
  // banner, do one last direct check of the reason-code page itself before
  // reporting success — a PeopleSoft hang with no visible error banner must
  // not be reported as a successful transaction creation.
  if (outcome === "timeout") {
    const confirmed = await successMarker.first().isVisible().catch(() => false);
    if (!confirmed) {
      throw new Error(
        "Create Transaction timed out with no error banner and no reason-code page " +
        "confirmation — PeopleSoft's outcome is unknown, refusing to report success.",
      );
    }
  }

  log.success("Transaction created");
  return { success: true };
}

// ─── STEP 3: Reason code + Continue ───

/**
 * Select the reason code from the dropdown and click Continue.
 *
 * @param page - Playwright page (for dismissing dialogs)
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param reasonLabel - Visible label text, e.g. "Hire - No Prior UC Affiliation"
 */
export async function selectReasonCode(
  page: Page,
  frame: FrameLocator,
  reasonLabel: string,
): Promise<void> {
  log.step(`Selecting reason code: ${reasonLabel}`);

  await smartHR
    .reasonCodeSelect(frame)
    .selectOption(reasonLabel, { timeout: 10_000 });
  log.step(`Reason: "${reasonLabel}" selected`);
  log.step("Reason code selected");

  await page.waitForTimeout(2_000);

  // Dismiss pt_modalMask raised by the dropdown round-trip before clicking Continue.
  // Without this the mask intercepts the click for the full 5s timeout and the
  // JS fallback below has to fire every time (2026-06-17).
  await dismissPeopleSoftModalMask(page);

  // Click Continue — may need force or JS due to sidebar overlay
  log.step("Clicking Continue...");
  try {
    await safeClick(smartHR.continueButton(frame), {
      timeout: 5_000,
      label: "ucpath reason continue button",
    });
  } catch {
    // Fallback: use PeopleSoft submitAction if sidebar overlay blocks click
    log.step("Regular click blocked — using JS submitAction...");
    await frame.locator("body").evaluate(() => { // allow-inline-selector -- root for JS-eval-only path (no click/fill)
      const w = window as unknown as { submitAction_win0: (form: unknown, name: string) => void };
      const d = document as unknown as { win0?: unknown };
      w.submitAction_win0(d.win0, "HR_TBH_WRK_TBH_NEXT");
    });
  }

  // Continue advances the wizard OFF the reason-code page. Replaces a fixed 8s
  // sleep with two named conditions: (1) the PeopleSoft processing overlay
  // lifecycle for the Continue round-trip (the old sleep ran BEFORE this wait,
  // so the spinner had usually come and gone and the wait no-op'd on its 2s
  // appear-timeout); (2) the Reason Code dropdown itself leaving the page
  // (hidden/detached) — the one post-condition common to BOTH callers, since
  // onboarding lands on the Personal Data form while separations lands on the
  // transaction form (different next pages, so no single next-page element can
  // be asserted here). The downstream fill (fillPersonalData / fillComments,
  // each with a 10s actionability wait) remains the positive backstop. Cap 16s
  // (≥ 2× the old 8s sleep).
  await waitForPeopleSoftProcessing(frame, 20_000);
  await waitForNamedCondition(smartHR.reasonCodeSelect(frame), {
    timeoutMs: 16_000,
    label: "wizard advanced past reason-code page (Reason Code dropdown gone)",
    state: "hidden",
  });

  log.success("Reason code selected and continued");
}

// ─── EID-bearing templates: "Enter Transaction Details" (UC_CONC_HIRE, …) ───

/**
 * Fill the Empl ID on the "Enter Transaction Details" page and read back the
 * person NAME PeopleSoft resolves for it (`#PERSON_NAME_NAME_DISPLAY`).
 *
 * The readback is load-bearing: a mistyped/bogus EID resolves to SOME real
 * person (live 2026-08-21: `10000001` → an unrelated employee), and Continue
 * then files the transaction against THAT person. The caller MUST compare the
 * returned name with the expected person before continuing. Throws when no
 * name resolves (unknown EID / page never refreshed) — never returns "".
 */
export async function fillTransactionDetailsEmplId(
  page: Page,
  frame: FrameLocator,
  emplId: string,
): Promise<string> {
  log.step(`Filling Empl ID ${emplId} on "Enter Transaction Details"...`);
  await safeFill(ssSmartHRTransactions.emplIdInput(frame), emplId, {
    timeout: 10_000,
    label: "ucpath transaction details empl id",
  });
  // Blur → PeopleSoft round-trip that resolves the person name next to the field.
  await page.keyboard.press("Tab");
  await waitForPeopleSoftProcessing(frame, 20_000);
  const nameLocator = smartHR.transactionDetailsPersonName(frame);
  await waitForNamedCondition(nameLocator, {
    timeoutMs: 15_000,
    label: "transaction details resolved person name (PERSON_NAME_NAME_DISPLAY)",
  });
  const deadline = Date.now() + 15_000;
  let name = "";
  while (Date.now() < deadline) {
    name = ((await nameLocator.textContent({ timeout: 5_000 }).catch(() => null)) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (name) break;
    await sleep(500);
  }
  if (!name) {
    throw new Error(
      `UCPath resolved NO person name for Empl ID ${emplId} on "Enter Transaction Details" — `
      + `the EID may be unknown or the page never refreshed. Refusing to continue.`,
    );
  }
  log.step(`Empl ID ${emplId} resolved to "${name}" on Enter Transaction Details`);
  return name;
}

/**
 * Acknowledge the "Person ID <eid> already exists in the system for <name>.
 * Select OK to continue the hire process with this Person ID." dialog that the
 * EID-bearing HIRE templates (UC_CONC_HIRE — live 2026-08-21) raise right after
 * Continue on "Enter Transaction Details". Only THAT dialog, naming THIS EID,
 * is acknowledged; no dialog, or any other dialog, throws — the page state is
 * unknown and clicking OK blind could accept a validation refusal as if it were
 * this confirmation. Returns the dialog text for the log.
 */
export async function acknowledgePersonIdExistsDialog(
  page: Page,
  emplId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await readPeopleSoftDialogText(page);
    if (text) break;
    await sleep(500);
  }
  if (!text) {
    throw new Error(
      `Expected the "Person ID ${emplId} already exists" confirmation after Continue on `
      + `"Enter Transaction Details", but no PeopleSoft dialog appeared within ${timeoutMs}ms — `
      + `page state unknown, refusing to proceed.`,
    );
  }
  if (!/already exists in the system/i.test(text) || !text.includes(emplId)) {
    throw new Error(
      `Unexpected PeopleSoft dialog after Continue on "Enter Transaction Details" (expected `
      + `"Person ID ${emplId} already exists in the system … Select OK to continue"): "${text.slice(0, 300)}"`,
    );
  }
  const clicked = await dismissPeopleSoftDialog(page);
  if (!clicked) {
    throw new Error(`Could not click OK on the "Person ID ${emplId} already exists" dialog`);
  }
  log.step(`Acknowledged PeopleSoft dialog: ${text.slice(0, 200)}`);
  return text;
}

/**
 * Wait until the transaction form has landed on its Job Data tab (the Position
 * Number textbox is the named post-condition). UC_CONC_HIRE opens on Job Data
 * (tabs: Job Data → Earns Dist → Personal Data — live 2026-08-21).
 */
export async function waitForJobDataForm(frame: FrameLocator, timeoutMs = 30_000): Promise<void> {
  await waitForPeopleSoftProcessing(frame, timeoutMs);
  await waitForNamedCondition(jobDataSelectors.positionNumberInput(frame), {
    timeoutMs,
    label: "transaction form Job Data tab (Position Number textbox)",
  });
  log.success("Transaction form loaded on Job Data");
}

/**
 * Read the Legal First / Legal Last name textboxes off the Personal Data tab.
 * On EID-bearing templates they are PRE-FILLED from the existing person record,
 * so they are a second wrong-person readback (after the Enter Transaction
 * Details name). Throws if either is blank — an unreadable name must not pass
 * a safety check by accident.
 */
export async function readPersonalDataLegalName(
  frame: FrameLocator,
): Promise<{ firstName: string; lastName: string }> {
  const firstName = (await personalDataSelectors.legalFirstName(frame).inputValue({ timeout: 10_000 })).trim();
  const lastName = (await personalDataSelectors.legalLastName(frame).inputValue({ timeout: 10_000 })).trim();
  if (!firstName || !lastName) {
    throw new Error(
      `Personal Data tab legal name is blank (first='${firstName}', last='${lastName}') — cannot verify the person`,
    );
  }
  return { firstName, lastName };
}

/**
 * Discard the in-progress transaction draft via the form's Cancel button and
 * wait for the Smart HR Transactions landing form (Select Template textbox) to
 * return. Live 2026-08-21: a cancelled UC_CONC_HIRE draft left NO
 * "Transactions in Progress" row; no confirmation dialog was raised (one is
 * acknowledged if it appears).
 */
export async function cancelTransactionDraft(page: Page, frame: FrameLocator): Promise<void> {
  log.step("Cancelling the transaction draft...");
  await dismissPeopleSoftModalMask(page);
  await safeClick(smartHR.cancelTransactionButton(frame), {
    timeout: 10_000,
    label: "ucpath transaction cancel button",
  });
  await sleep(2_000);
  const dialogText = await readPeopleSoftDialogText(page);
  if (dialogText) {
    log.step(`Cancel raised a dialog — acknowledging: ${dialogText.slice(0, 160)}`);
    await dismissPeopleSoftDialog(page);
  }
  await waitForPeopleSoftProcessing(frame, 20_000);
  await waitForNamedCondition(smartHR.templateInput(frame), {
    timeoutMs: 20_000,
    label: "smart hr transactions form after cancel (Select Template textbox)",
  });
  log.success("Transaction draft cancelled — back on Smart HR Transactions");
}

// ─── STEP 4: Fill personal data ───

export interface PersonalDataInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  dob: string;
  ssn?: string; // without dashes — just digits; optional for international students
  address: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  i9ProfileId?: string;
  preferredFirstName?: string;
  preferredLastName?: string;
  preferredMiddleName?: string;
}

/**
 * Fill all personal data fields on the Smart HR Transaction form.
 *
 * Fields: legal first/last/middle name, preferred first/last/middle name
 * (uses preferred name if provided, else mirrors legal name), DOB, national ID (SSN),
 * address, phone (Mobile - Personal), email (Home), tracker profile ID.
 */
export async function fillPersonalData(
  page: Page,
  frame: FrameLocator,
  data: PersonalDataInput,
): Promise<void> {
  log.step("Filling personal data...");

  // --- Legal Name ---
  log.step("Filling legal first name...");
  await safeFill(personalDataSelectors.legalFirstName(frame), data.firstName, {
    timeout: 10_000,
    label: "ucpath legal first name",
  });

  log.step("Filling legal last name...");
  await safeFill(personalDataSelectors.legalLastName(frame), data.lastName, {
    timeout: 10_000,
    label: "ucpath legal last name",
  });

  if (data.middleName) {
    log.step("Filling legal middle name...");
    await safeFill(personalDataSelectors.legalMiddleName(frame), data.middleName, {
      timeout: 10_000,
      label: "ucpath legal middle name",
    });
  }

  // --- Preferred / Lived Name (uses preferred name if provided, else mirrors legal name) ---
  const prefFirst = data.preferredFirstName || data.firstName;
  const prefLast = data.preferredLastName || data.lastName;
  const prefMiddle = data.preferredMiddleName ?? data.middleName;

  log.step("Filling preferred first name...");
  await safeFill(personalDataSelectors.preferredFirstName(frame), prefFirst, {
    timeout: 10_000,
    label: "ucpath preferred first name",
  });

  log.step("Filling preferred last name...");
  await safeFill(personalDataSelectors.preferredLastName(frame), prefLast, {
    timeout: 10_000,
    label: "ucpath preferred last name",
  });

  if (prefMiddle) {
    log.step("Filling preferred middle name...");
    await safeFill(personalDataSelectors.preferredMiddleName(frame), prefMiddle, {
      timeout: 10_000,
      label: "ucpath preferred middle name",
    });
  }

  // --- Date of Birth ---
  log.step("Filling date of birth...");
  await safeFill(personalDataSelectors.dateOfBirth(frame), data.dob, {
    timeout: 10_000,
    label: "ucpath date of birth",
  });

  // --- National ID (SSN) ---
  if (data.ssn) {
    log.step("Filling national ID...");
    await safeFill(personalDataSelectors.nationalId(frame), data.ssn, {
      timeout: 10_000,
      label: "ucpath national id",
    });
  } else {
    log.step("No SSN — skipping national ID field");
  }

  // --- Address ---
  log.step("Filling address...");
  await safeFill(personalDataSelectors.addressLine1(frame), data.address, {
    timeout: 10_000,
    label: "ucpath address line 1",
  });

  if (data.city) {
    await safeFill(personalDataSelectors.city(frame), data.city, {
      timeout: 10_000,
      label: "ucpath city",
    });
  }

  if (data.state) {
    await safeFill(personalDataSelectors.state(frame), data.state, {
      timeout: 10_000,
      label: "ucpath state",
    });
  }

  if (data.postalCode) {
    await safeFill(personalDataSelectors.postalCode(frame), data.postalCode, {
      timeout: 10_000,
      label: "ucpath postal code",
    });
  }

  // --- Phone ---
  if (data.phone) {
    log.step("Selecting phone type: Mobile - Personal...");
    await personalDataSelectors
      .phoneTypeSelect(frame)
      .selectOption("Mobile - Personal", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Phone type selected");

    log.step("Filling phone number...");
    await safeFill(personalDataSelectors.phoneNumberInput(frame), data.phone, {
      timeout: 10_000,
      label: "ucpath phone number",
    });

    log.step("Checking Preferred checkbox...");
    await personalDataSelectors
      .phonePreferredCheckbox(frame)
      .check({ timeout: 5_000 });
    log.step("Preferred checkbox checked");
  }

  // --- Email ---
  if (data.email) {
    log.step("Selecting email type: Home...");
    await personalDataSelectors
      .emailTypeSelect(frame)
      .selectOption("Home", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Email type selected");

    log.step("Filling email address...");
    await safeFill(personalDataSelectors.emailAddressInput(frame), data.email, {
      timeout: 10_000,
      label: "ucpath email address",
    });
  }

  // --- Tracker Profile ID (I9) ---
  if (data.i9ProfileId) {
    log.step("Filling tracker profile ID...");
    await safeFill(personalDataSelectors.trackerProfileIdInput(frame), data.i9ProfileId, {
      timeout: 10_000,
      label: "ucpath tracker profile id",
    });
  }

  log.success("Personal data filled");
}

// ─── STEP 5: Comments + Initiator Comments ───

/**
 * Fill the Comments and Initiator Comments fields.
 *
 * @param page - Playwright page (for dismissing the pt_modalMask overlay)
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param comments - Comment text (same for both fields)
 */
export async function fillComments(
  page: Page,
  frame: FrameLocator,
  commentsText: string,
): Promise<void> {
  log.step("Filling comments...");

  // Dismiss pt_modalMask that can linger after tab switches / round-trips
  // before attempting to fill the textarea (2026-06-17).
  await dismissPeopleSoftModalMask(page);

  await safeFill(commentsSelectors.commentsTextarea(frame), commentsText, {
    timeout: 10_000,
    label: "ucpath comments textarea",
  });

  log.step("Filling initiator comments...");
  await safeFill(commentsSelectors.initiatorCommentsTextarea(frame), commentsText, {
    timeout: 10_000,
    label: "ucpath initiator comments textarea",
  });

  await commentsSelectors.commentsTextarea(frame).press("Tab");
  await commentsSelectors.initiatorCommentsTextarea(frame).press("Tab");
  await page.waitForLoadState("networkidle");
  const actual = await commentsSelectors.commentsTextarea(frame).inputValue();
  const initiator = await commentsSelectors.initiatorCommentsTextarea(frame).inputValue();
  if (!commentsText.trim() || actual !== commentsText || initiator !== commentsText) throw new Error("UCPath Comments and Initiator Comments were not both retained; refusing submission");
  log.success("Comments and Initiator Comments verified");
}

/** Positive readback gate for the termination Last Date Worked controls. */
export function assertTerminationLastDateWorkedReadback(
  overrideChecked: boolean,
  actualValue: string,
  expectedValue: string,
): void {
  if (!overrideChecked) {
    throw new Error("UCPath Last Date Worked override is not checked after the write");
  }
  const actual = actualValue.trim();
  const expected = expectedValue.trim();
  if (!actual) {
    throw new Error("UCPath Last Date Worked readback is blank after the write");
  }
  if (actual !== expected) {
    throw new Error(
      `UCPath Last Date Worked readback mismatch: expected "${expected}", got "${actual}"`,
    );
  }
}

/** @internal Exported so delayed/no-spinner fragment-refresh behavior is regression tested. */
export async function requirePeopleSoftControlRefresh(
  locator: Locator,
  action: () => Promise<void>,
  label: string,
): Promise<void> {
  const handle = await locator.elementHandle({ timeout: 10_000 });
  if (!handle) {
    throw new Error(`UCPath ${label} control was not attached before the write`);
  }
  const refreshResult = handle
    .waitForElementState("hidden", { timeout: 15_000 })
    .then(() => null, (error: unknown) => error);
  try {
    await action();
    const refreshError = await refreshResult;
    if (refreshError) {
      throw new Error(
        `UCPath ${label} did not detach/hide during its PeopleSoft fragment refresh: ` +
        errorMessage(refreshError),
      );
    }
  } finally {
    await handle.dispose();
  }
}

/**
 * Check the termination override, write Last Date Worked, then re-resolve and
 * positively verify both controls before the transaction is submitted.
 *
 * The two controls behave DIFFERENTLY, live-verified 2026-07-28 on the editable
 * UC_VOL_TERM form (Smart HR → Enter Transaction Information):
 * - The override checkbox's `onclick` runs `submitAction_win0(...)` — a real
 *   PeopleSoft round-trip that re-renders the fragment and DETACHES the old
 *   checkbox node. So checking it must wait for that refresh, or the readback
 *   races a fragment that is still being replaced.
 * - The Last Date Worked input's only handler is `onchange="addchg_win0(this)"`
 *   — dirty-tracking, NO round-trip. After fill + Tab the SAME input node is
 *   still connected, so this write must NOT require a detach/hide (that wait
 *   could only ever time out). Its posted value IS the input's DOM value, which
 *   the readback below asserts exactly.
 *
 * On this template UCPath pre-checks the override and pre-fills the date with
 * (effective date − 1); we still write and verify our own reconciled date
 * rather than trusting the default.
 */
export async function fillTerminationLastDateWorked(
  page: Page,
  frame: FrameLocator,
  expectedDate: string,
): Promise<void> {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(expectedDate)) {
    throw new Error(
      `UCPath Last Date Worked "${expectedDate}" is malformed (expected MM/DD/YYYY)`,
    );
  }
  await dismissPeopleSoftModalMask(page);

  const initialOverride = terminationSelectors.overrideLastDateWorkedCheckbox(frame);
  if (!(await initialOverride.isChecked({ timeout: 10_000 }))) {
    await requirePeopleSoftControlRefresh(
      initialOverride,
      () => initialOverride.check({ timeout: 10_000 }),
      "Last Date Worked override",
    );
    await waitForPeopleSoftProcessing(frame, 30_000);
  }

  // Re-resolved AFTER the override's fragment refresh above — the pre-refresh
  // input node would be stale on the check-it-ourselves path.
  const input = terminationSelectors.lastDateWorkedInput(frame);
  await safeFill(input, expectedDate, {
    timeout: 10_000,
    label: "ucpath termination last date worked",
  });
  // Blur commits the value: `fill` raises `input`, only the blur raises the
  // `change` that runs `addchg_win0` and marks the field dirty for the post.
  // No detach wait here — see the header note (this field has no round-trip).
  await input.press("Tab");
  await waitForPeopleSoftProcessing(frame, 30_000);

  const refreshedOverride = terminationSelectors.overrideLastDateWorkedCheckbox(frame);
  const refreshedInput = terminationSelectors.lastDateWorkedInput(frame);
  await refreshedInput.waitFor({ state: "visible", timeout: 15_000 });
  const checked = await refreshedOverride.isChecked({ timeout: 10_000 });
  const actual = await refreshedInput.inputValue({ timeout: 10_000 });
  assertTerminationLastDateWorkedReadback(checked, actual, expectedDate);
  log.success(`Last Date Worked verified as ${expectedDate} with override checked`);
}

// ─── STEP 6: Click Job Data tab ───

/**
 * Click the Job Data tab to proceed to the next section.
 *
 * @param page - Playwright page
 * @param frame - PeopleSoft content iframe FrameLocator
 */
export async function clickJobDataTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  log.step("Clicking Job Data tab...");
  await dismissPeopleSoftModalMask(page);

  await safeClick(smartHR.tab.jobData(frame), {
    timeout: 10_000,
    label: "ucpath job data tab",
  });
  // Replaces a fixed 5s sleep: the tab click triggers a PeopleSoft round-trip
  // (observed by waitForPeopleSoftProcessing), and the named post-condition is
  // the Job Data tab's first field — the Position Number textbox — rendering
  // (fillJobData fills it next, so it must be present).
  await waitForPeopleSoftProcessing(frame, 15_000);
  await waitForNamedCondition(jobDataSelectors.positionNumberInput(frame), {
    timeoutMs: 15_000,
    label: "job data tab (Position Number textbox)",
  });

  log.success("Job Data tab loaded");
}

// ─── STEP 6b: Fill Job Data tab fields ───

export interface JobDataInput {
  positionNumber: string;
  employeeClassification: string; // from CRM Appointment field (usually "5")
  compRateCode: string; // constant "UCHRLY"
  compensationRate: string; // pay rate from CRM (numeric, e.g. "17.75")
  expectedJobEndDate: string; // constant "06/30/2026"
}

/**
 * Fill a PeopleSoft field and PROVE the value stuck, retrying on a freshly
 * resolved locator.
 *
 * Why this exists: `safeFill` only proves the `.fill()` call succeeded. On the
 * Job Data grid that is not enough — filling Comp Rate Code blurs into a
 * PeopleSoft round-trip that REPLACES the pay-components row, so the very next
 * fill can land on a detached node. The call returns clean, the log says
 * "Job Data filled", and the field is actually EMPTY. UCPath then refuses to
 * enable Save and Submit with "Please fill the highlighted Compensation Related
 * fields", and the run dies later at the save with a misleading "tab walk
 * likely incomplete" message (live 2026-08-18, Alnasser + Campos).
 *
 * Re-resolving and re-filling is a retry of the SAME operation — it never
 * substitutes a different value — and an unverifiable field THROWS rather than
 * letting a half-filled transaction reach a submit.
 *
 * @param resolve - resolves the locator fresh on every attempt (grid ids mutate)
 * @param equals - value comparison; defaults to exact string match after trim
 */
export async function fillVerified(
  page: Page,
  resolve: () => Locator,
  value: string,
  opts: {
    label: string;
    attempts?: number;
    settleMs?: number;
    equals?: (actual: string, expected: string) => boolean;
  },
): Promise<void> {
  const { label, attempts = 3, settleMs = 1_500 } = opts;
  const equals = opts.equals ?? ((a, b) => a.trim() === b.trim());

  let lastSeen = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const target = resolve();
    await safeFill(target, value, { timeout: 10_000, label });
    await page.waitForTimeout(500);
    // Blur so PeopleSoft commits + validates the value.
    await page.keyboard.press("Tab");
    await page.waitForTimeout(settleMs);

    // Re-resolve: the blur round-trip may have replaced the node.
    lastSeen = await resolve().inputValue().catch(() => "");
    if (equals(lastSeen, value)) {
      if (attempt > 1) log.success(`${label}: value confirmed on attempt ${attempt}`);
      return;
    }
    log.warn(
      `${label}: value did not stick (wanted "${value}", field reads "${lastSeen}") — `
      + `attempt ${attempt}/${attempts}, re-resolving and refilling.`,
    );
  }

  throw new Error(
    `${label}: could not set the field to "${value}" after ${attempts} attempts — it still reads `
    + `"${lastSeen}". PeopleSoft would refuse the transaction ("Please fill the highlighted ... `
    + `fields") and Save and Submit would stay disabled, so this fails here rather than at the save.`,
  );
}

/**
 * Fill Job Data tab fields: position number, employee classification,
 * comp rate code, compensation rate, expected job end date.
 *
 * NOTE: Position number fill triggers a PeopleSoft page refresh which changes
 * the grid input IDs from $11 to $0. Selectors in the registry use fallback
 * chains (`.or()`) that cover both states.
 */
export async function fillJobData(
  page: Page,
  frame: FrameLocator,
  data: JobDataInput,
): Promise<void> {
  log.step("Filling Job Data...");

  log.step("Filling position number...");
  await safeFill(jobDataSelectors.positionNumberInput(frame), data.positionNumber, {
    timeout: 10_000,
    label: "ucpath position number",
  });
  // Position number fill triggers a PeopleSoft page refresh (grid input IDs
  // mutate $11 → $0). Replaces a fixed 5s sleep: waitForPeopleSoftProcessing
  // observes the refresh spinner, and the named post-condition is the next
  // field on the refreshed grid — the Employee Classification textbox — being
  // present (fillJobData fills it next). Cap 12s (≥ 2× the old 5s sleep).
  await waitForPeopleSoftProcessing(frame, 15_000);
  await waitForNamedCondition(jobDataSelectors.employeeClassificationInput(frame), {
    timeoutMs: 12_000,
    label: "job data grid settled (Employee Classification textbox)",
  });
  log.step("Position number filled — page refreshed, grid indices may have changed");

  log.step("Filling employee classification...");
  await safeFill(jobDataSelectors.employeeClassificationInput(frame), data.employeeClassification, {
    timeout: 10_000,
    label: "ucpath employee classification",
  });
  await page.waitForTimeout(2_000);

  log.step("Filling comp rate code: UCHRLY...");
  await safeFill(jobDataSelectors.compRateCodeInput(frame), data.compRateCode, {
    timeout: 10_000,
    label: "ucpath comp rate code",
  });
  await page.waitForTimeout(1_000);
  // Blur to trigger PeopleSoft validation
  await page.keyboard.press("Tab");
  await waitForPeopleSoftProcessing(frame, 15_000).catch(() => {});
  await page.waitForTimeout(1_500);

  log.step("Filling compensation rate...");
  // VERIFIED fill: the Comp Rate Code blur above round-trips and replaces this
  // grid row, so a plain safeFill can silently land on a detached node and
  // leave the field empty. PeopleSoft echoes the rate back padded
  // ("17.75" -> "17.750000"), so compare numerically, not textually.
  await fillVerified(page, () => jobDataSelectors.compensationRateInput(frame), data.compensationRate, {
    label: "ucpath compensation rate",
    settleMs: 2_000,
    equals: (actual, expected) => {
      const a = Number(actual.replace(/,/g, ""));
      const b = Number(expected.replace(/,/g, ""));
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    },
  });

  // Fill Compensation Frequency ("H" for Hourly) — required field, sometimes not auto-populated
  log.step("Filling compensation frequency: H (Hourly)...");
  const compFreq = jobDataSelectors.compensationFrequencyInput(frame);
  const freqValue = await compFreq.inputValue().catch(() => "");
  if (!freqValue || freqValue.trim() === "") {
    await safeFill(compFreq, "H", {
      timeout: 10_000,
      label: "ucpath compensation frequency",
    });
    await page.waitForTimeout(1_000);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(2_000);
  } else {
    log.step(`Compensation Frequency already set: ${freqValue}`);
  }

  log.step("Filling expected job end date...");
  // Also verified: this field sits in the same validation group PeopleSoft
  // highlights, and it was flagged red alongside the empty rate on the live
  // failure — so prove it committed rather than assuming.
  await fillVerified(page, () => jobDataSelectors.expectedJobEndDateInput(frame), data.expectedJobEndDate, {
    label: "ucpath expected job end date",
  });

  // Verify compensation rate did not get reset by subsequent field round-trips
  const finalRate = await jobDataSelectors.compensationRateInput(frame).inputValue().catch(() => "");
  const numFinal = Number(finalRate.replace(/,/g, ""));
  const numExpected = Number(data.compensationRate.replace(/,/g, ""));
  if (!Number.isFinite(numFinal) || numFinal !== numExpected) {
    log.warn(
      `[fillJobData] Compensation rate was reset (reads "${finalRate}", expected "${data.compensationRate}") — refilling...`,
    );
    await fillVerified(page, () => jobDataSelectors.compensationRateInput(frame), data.compensationRate, {
      label: "ucpath compensation rate (post-check)",
      settleMs: 2_000,
      equals: (actual, expected) => {
        const a = Number(actual.replace(/,/g, ""));
        const b = Number(expected.replace(/,/g, ""));
        return Number.isFinite(a) && Number.isFinite(b) && a === b;
      },
    });
  }

  log.success("Job Data filled");
}

// ─── STEP 7: Click through remaining tabs ───

/**
 * Click the Earns Dist tab (no fields to fill, just visit it).
 */
export async function clickEarnsDistTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  await clickTransactionTab(page, frame, "Earns Dist", smartHR.tab.earnsDist(frame));
}

/**
 * Click the Employee Experience tab (no fields to fill, just visit it).
 */
export async function clickEmployeeExperienceTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  await clickTransactionTab(page, frame, "Employee Experience", smartHR.tab.employeeExperience(frame));
}

/**
 * Click the Personal Data tab. On UC_FULL_HIRE it is the landing tab (re-clicked
 * at the end of the walk); on UC_CONC_HIRE it is the LAST tab of the walk
 * (Job Data → Earns Dist → Personal Data) and visiting it is what enables
 * Save and Submit (live 2026-08-21).
 */
export async function clickPersonalDataTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  await clickTransactionTab(page, frame, "Personal Data", smartHR.tab.personalData(frame));
}

async function clickTransactionTab(
  page: Page,
  frame: FrameLocator,
  tabName: string,
  locator: Locator,
): Promise<void> {
  log.step(`Clicking ${tabName} tab...`);
  await dismissPeopleSoftModalMask(page);
  await safeClick(locator, {
    timeout: 10_000,
    label: `ucpath ${tabName.toLowerCase()} tab`,
  });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 10_000);
  log.success(`${tabName} tab loaded`);
}

// ─── STEP 8: Save and Submit ───

export async function waitForSaveEnabled(
  btn: Locator,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 15_000, pollMs = 500 } = opts;
  await btn.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await btn.isEnabled().catch(() => false)) return;
    await sleep(pollMs);
  }
  throw new Error(
    "Save and Submit remained disabled after 15 s — tab walk likely incomplete (visit all 4 Smart HR tabs + fill Initiator Comments + re-click Personal Data before save)",
  );
}

/**
 * @param employeeId - EID used to match the transaction row by its Person
 *   ID column after submit. Required to read back the transaction number;
 *   if omitted, the post-submit txn# readback is skipped. Onboarding
 *   omits it because new-hire rows show Person ID "NEW" until the
 *   transaction is fully processed — no EID exists to match against.
 */
export async function clickSaveAndSubmit(
  page: Page,
  frame: FrameLocator,
  employeeId?: string,
  opts: {
    personName?: string;
    terminationJob?: SeparationJob;
    terminationEffectiveDate?: string;
    terminationComments?: string;
    /**
     * The hire's own comparable identifiers, used ONLY if the submit lands on
     * the "Person Match Found" page — see `decidePersonMatchContinue`. Omitted
     * (separations / EID-bearing flows) ⇒ any Person Match page fails loud.
     */
    hireIdentity?: PersonMatchHireIdentity;
    /** Operator-reviewed "not this person" EIDs (`data.notMatchEids`). */
    notMatchEids?: readonly string[];
  } = {},
): Promise<TransactionResult> {
  log.step("Clicking Save and Submit...");
  await dismissPeopleSoftModalMask(page);

  const btn = smartHR.saveAndSubmitButton(frame);

  // Identify the control we are about to click. The transaction landing in
  // "Transactions in Progress" (saved, not submitted) means the click behaved
  // like Save-for-Later, so prove WHICH element this resolves to rather than
  // assuming the role-name match picked the right one.
  const btnCount = await btn.count().catch(() => -1);
  const btnInfo = await btn.evaluate((el) => ({
    id: (el as HTMLElement).id,
    name: (el as HTMLInputElement).name ?? "",
    value: (el as HTMLInputElement).value ?? "",
    text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim(),
    tag: el.tagName,
  })).catch(() => null);
  log.step(
    `[Submit] resolved save control: matches=${btnCount} `
    + (btnInfo
      ? `tag=${btnInfo.tag} id='${btnInfo.id}' name='${btnInfo.name}' value='${btnInfo.value}' text='${btnInfo.text}'`
      : "<could not read>"),
  );
  // Also enumerate every button on the action bar, so a mis-resolution is
  // obvious from the log alone.
  const allButtons = await frame.locator("input[type=button], input[type=submit], button, a[role=button]") // allow-inline-selector -- diagnostic enumeration of the transaction action bar
    .evaluateAll((els) => els
      .map((el) => ({
        id: (el as HTMLElement).id,
        value: (el as HTMLInputElement).value ?? "",
        text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((b) => /save|submit|cancel/i.test(`${b.value} ${b.text}`)))
    .catch(() => []);
  for (const b of allButtons) {
    log.step(`[Submit]   action-bar button: id='${b.id}' value='${b.value}' text='${b.text}'`);
  }
  // Any ad-hoc save-disabled screenshot lives on the handler side via
  // ctx.screenshot() — keeping this module ctx-free means separations /
  // onboarding / etc can attach their own labeling + kind without
  // teaching this low-level function about the kernel.
  await waitForSaveEnabled(btn, { timeoutMs: 15_000 });
  await safeClick(btn, {
    timeout: 10_000,
    label: "ucpath save and submit button",
  });
  // Dropped the fixed 5s pre-sleep so waitForPeopleSoftProcessing observes the
  // submit round-trip's spinner. The DEFINITIVE named condition — the
  // confirmation OK dialog vs. the error banner — is the waitForTransactionOutcome
  // poll below (20s cap, the real success marker for this irreversible submit).
  await waitForPeopleSoftProcessing(frame, 30_000);

  // ── Intermediate submit pages can replace the confirmation ──
  // Poll named signals together: error banner, Person Match Found, Select an
  // Action (inactive Employee Instances), then confirmation OK. Before
  // 2026-08-20 only error + OK were watched (Person Match timed out blind);
  // 2026-09-17 added Select an Action (Juriana Garcia concurrent hire).
  {
    const personMatchHeading = smartHR.personMatchFoundHeading(frame);
    const selectActionHeading = smartHR.selectAnActionHeading(frame);
    const errorLoc = smartHR.errorBanner(frame);
    const okLoc = smartHR.confirmationOkButton(frame);
    const deadline = Date.now() + 30_000;
    let handledSelectAction = false;
    while (Date.now() < deadline) {
      const errorVisible = (await errorLoc.count().catch(() => 0)) > 0;
      const matchVisible = await personMatchHeading.first().isVisible().catch(() => false);
      const selectVisible = await selectActionHeading.first().isVisible().catch(() => false);
      const okVisible = await okLoc.first().isVisible().catch(() => false);
      const signal = classifySubmitSignals(errorVisible, matchVisible, okVisible, selectVisible);
      if (signal === "person-match") {
        const candidates = await readPersonMatchCandidates(frame);
        log.warn(
          `[Submit] UCPath raised "Person Match Found" — ${candidates.length} possible person match(es) `
          + `for ${opts.personName ?? employeeId ?? "<unknown>"}:`,
        );
        for (const c of candidates) log.warn(`[Submit]   ${formatPersonMatchCandidate(c)}`);
        const decision = decidePersonMatchContinue(candidates, opts.hireIdentity ?? {}, opts.notMatchEids ?? []);
        for (const r of decision.reasons) log.step(`[Submit]   ${r.personId}: ${r.reason}`);
        if (!decision.proceed) {
          const unresolved = decision.unresolved.map(formatPersonMatchCandidate).join("; ");
          const unresolvedEids = decision.unresolved.map((c) => c.personId).join(",");
          // Nothing is persisted on this page (live 2026-08-20: no Transactions-in-
          // Progress row after it) — leave it; a re-run recreates the transaction.
          return {
            success: false,
            error:
              `UCPath raised "Person Match Found" on submit and ${decision.unresolved.length} of `
              + `${candidates.length} candidate(s) could not be excluded by a hard identifier `
              + `(DOB month/day or SSN last-4): ${unresolved || "<none>"}. The hire was NOT filed. `
              + `Review each in UCPath (Person Org Summary); if none is this person, re-run with `
              + `prefilledData.notMatchEids="${unresolvedEids}" (comma-separated EIDs the operator `
              + `confirmed are NOT this hire); if one IS this person, this is a rehire — do not file.`,
          };
        }
        log.success(
          `[Submit] every Person Match candidate is excluded (hard-identifier mismatch or operator-reviewed) `
          + `— clicking "Not a Match - Continue with Hire".`,
        );
        await dismissPeopleSoftModalMask(page);
        await safeClick(smartHR.personMatchNotAMatchButton(frame), {
          timeout: 10_000,
          label: "ucpath person match: not a match - continue with hire",
        });
        await waitForPeopleSoftProcessing(frame, 30_000);
        // Keep polling — Select an Action can follow Person Match on concurrent hires.
        continue;
      }
      if (signal === "select-action") {
        if (handledSelectAction) {
          return {
            success: false,
            error:
              `UCPath "Select an Action" page still present after Save and Submit `
              + `(${opts.personName ?? employeeId ?? "<unknown>"}) — refusing to click again.`,
          };
        }
        handledSelectAction = true;
        // PeopleSoft does not expose the Hire radio via getByRole("radio")
        // (live timeout 2026-09-17); the option arrives pre-selected. Prove
        // the Hire label is on the page, then click Save and Submit again.
        const hireOption = smartHR.createNewEmployeeInstanceHireOption(frame);
        const hireVisible = await hireOption.first().isVisible().catch(() => false);
        if (!hireVisible) {
          return {
            success: false,
            error:
              `UCPath "Select an Action" page is missing the expected Hire option `
              + `"Create a new employee instance using Hire as the action." `
              + `(${opts.personName ?? employeeId ?? "<unknown>"}) — refusing to submit.`,
          };
        }
        log.step(
          `[Submit] Select an Action (inactive Employee Instances) — `
          + `Hire option present (pre-selected); clicking Save and Submit again.`,
        );
        await dismissPeopleSoftModalMask(page);
        await waitForSaveEnabled(btn, { timeoutMs: 15_000 });
        await safeClick(btn, {
          timeout: 10_000,
          label: "ucpath save and submit after select an action",
        });
        await waitForPeopleSoftProcessing(frame, 30_000);
        continue;
      }
      if (signal !== "pending") break;
      await sleep(500);
    }
  }

  // Decide on a DEFINITIVE outcome — error banner vs the post-submit confirmation
  // OK dialog — rather than sampling errorBanner.count() once after a fixed sleep
  // (a banner that renders late read 0 at that instant and returned
  // { success: true } for a submit that actually errored). On timeout, fall back
  // to the legacy point-in-time check so behavior never regresses. On success the
  // confirmation OK is already visible, so the txn# readback flow below proceeds
  // immediately.
  const errorLocator = smartHR.errorBanner(frame);
  const okMarker = smartHR.confirmationOkButton(frame);
  // 30s cap (was 20s): the fixed 5s pre-sleep above was removed, so the poll
  // starts earlier — the longer cap keeps the definitive-outcome window ≥ the
  // old sleep+poll total (worst case strictly no worse).
  const outcome = await waitForTransactionOutcome(errorLocator, okMarker, { timeoutMs: 30_000 });
  if (outcome === "error" || (outcome === "timeout" && (await errorLocator.count().catch(() => 0)) > 0)) {
    const errorText = await errorLocator.nth(0).textContent({ timeout: 5_000 }).catch(() => null);
    log.error(`Save and Submit error: ${errorText ?? "Unknown error"}`);
    return { success: false, error: errorText ?? "Unknown error" };
  }

  // A timeout is NOT a confirmation. If the poll window expired with no error
  // banner, do one last direct check of the confirmation OK button itself
  // before reporting success — a PeopleSoft hang with no visible error banner
  // must not be reported as a successful save/submit (this is the real UCPath
  // termination/hire mutation).
  if (outcome === "timeout") {
    const confirmed = await okMarker.first().isVisible().catch(() => false);
    if (!confirmed) {
      throw new Error(
        `Save and Submit timed out with no error banner and no confirmation OK dialog` +
        `${employeeId ? ` (EID ${employeeId})` : ""} — PeopleSoft's outcome is unknown, ` +
        "refusing to report success.",
      );
    }
  }

  log.success("Transaction saved and submitted");

  // Mapped via playwright-cli 2026-04-01:
  // Flow to extract transaction number:
  //   1. Confirmation page appears → click OK
  //   2. Back on Smart HR Transactions list → click employee name link
  //   3. Enter Transaction Details → click Continue
  //   4. Enter Transaction Information → "Transaction ID:" shows actual number (e.g. T002114817)
  let transactionNumber = "";
  try {
    // Step 1: Acknowledge the post-submit confirmation dialog.
    //
    // This MUST go through the `#ICOK` evaluate escape hatch, not a Playwright
    // click. Live 2026-08-18 the role-based click failed every time for two
    // independent reasons: (a) `pt_modalMask` sits over the page and
    // "intercepts pointer events", which is the documented PeopleSoft overlay
    // problem; and (b) `getByRole("button", { name: "OK" }).first()` resolved
    // to the WRONG element entirely — the `Look up Legal Suffix` prompt anchor
    // (`HR_TBH_SCR_WRK_TBH_SH_PROMPT2$prompt$1`), not the confirmation button.
    // The submit was left unacknowledged, no transaction number could be read,
    // and the hire did not appear on the SS Smart HR list afterwards.
    //
    // `dismissPeopleSoftDialog` clicks `#ICOK` inside `frame.evaluate`, which
    // is unaffected by the mask — the same escape hatch `deletePendingTransaction`
    // already relies on.
    await page.waitForTimeout(2_000);

    // Diagnostic: name the dialog we are about to acknowledge. A submit that
    // "succeeds" and leaves Transaction ID = NEW means we acknowledged the
    // wrong thing (a validation warning rather than the submit confirmation),
    // and without this the logs cannot tell those apart.
    for (const f of page.frames()) {
      const info = await f.evaluate(() => {
        const ok = document.getElementById("#ICOK");
        if (!ok) return null;
        // PeopleSoft renders its modal in a ptMod* container, not in an
        // ancestor of the OK button — walk out far enough to find real text.
        const candidates: string[] = [];
        for (const sel of ["[id^=ptModContainer]", "[id^=ptMod]", "[role=dialog]", ".ps-modal"]) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const t = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
            if (t) candidates.push(t.slice(0, 400));
          }
        }
        let node: HTMLElement | null = ok.parentElement;
        for (let i = 0; i < 8 && node; i++) {
          const t = (node.innerText ?? "").replace(/\s+/g, " ").trim();
          if (t) { candidates.push(`ancestor${i}: ${t.slice(0, 400)}`); break; }
          node = node.parentElement;
        }
        // Any visible PeopleSoft error/warning banner on the page.
        for (const sel of [".PSERROR", "#ALERTMSG", ".ps_alert-error", "[id^=win0divPSERROR]"]) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const t = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
            if (t) candidates.push(`banner: ${t.slice(0, 400)}`);
          }
        }
        return { okValue: (ok as HTMLInputElement).value ?? "", candidates };
      }).catch(() => null);
      if (info) {
        log.step(`[Submit] confirmation dialog present — OK='${info.okValue}'`);
        for (const c of info.candidates.slice(0, 6)) log.step(`[Submit]   ${c}`);
        if (info.candidates.length === 0) log.step("[Submit]   (no readable dialog text found)");
        break;
      }
    }

    // DRAIN the dialog chain. PeopleSoft can raise more than one #ICOK in
    // sequence here (save confirmation, then submit confirmation); dismissing
    // only the first leaves the second one up, and the caller then navigates
    // away with the submit never committed — the page keeps reading
    // "Transaction ID: NEW" (live 2026-08-18).
    // READ the dialog before acknowledging it. UCPath raises BLOCKING error
    // modals here that are indistinguishable from a submit confirmation on the
    // automation's side — live 2026-08-18 the dialog said "Expected Job End
    // Date cannot be before Job Effective Date", we clicked OK, and reported a
    // successful submit for a transaction that never left "Transaction ID: NEW".
    // A refusal must fail loud, not be clicked past.
    const dialogText = await readPeopleSoftDialogText(page);
    if (dialogText) {
      log.step(`[Submit] dialog text: "${dialogText}"`);
      if (/cannot|invalid|must be|required|error|not valid/i.test(dialogText)) {
        await dismissPeopleSoftDialog(page);
        throw new Error(
          `UCPath REFUSED the Smart HR submit with a blocking dialog: "${dialogText}". `
          + `The transaction was NOT filed (it stays at Transaction ID: NEW).`,
        );
      }
    }

    let acknowledged = false;
    for (let round = 1; round <= 5; round++) {
      const clicked = await dismissPeopleSoftDialog(page);
      if (!clicked) break;
      acknowledged = true;
      log.step(`[Submit] acknowledged confirmation dialog (round ${round})`);
      await page.waitForTimeout(2_500);
      await waitForPeopleSoftProcessing(frame, 20_000).catch(() => {});
    }

    if (!acknowledged) {
      // Fall back to the role-based button only if no #ICOK dialog exists.
      const okButton = smartHR.confirmationOkButton(frame);
      await okButton.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      acknowledged = await clickIfPresent(okButton, {
        timeout: 5_000,
        label: "ucpath save confirmation ok button",
      });
    }

    if (acknowledged) {
      log.step("Acknowledged the post-submit confirmation dialog...");

      // The #ICOK click fires the actual submit POST. Let PeopleSoft finish it
      // BEFORE anything navigates away — the caller drives straight off to the
      // SS Smart HR list next, and leaving mid-round-trip abandons the submit:
      // live 2026-08-18 the post-submit page still read "Transaction ID: NEW"
      // and the hire never appeared on the list. Poll the readback area until
      // the id resolves to a real T-number.
      await waitForPeopleSoftProcessing(frame, 30_000);
      const deadline = Date.now() + (opts.terminationJob ? 0 : 30_000);
      while (Date.now() < deadline) {
        await scrollToTransactionReadbackArea(frame).catch(() => false);
        const seen = await readTxnNumberFromDetailPage(frame);
        if (seen) {
          transactionNumber = seen;
          log.success(`[Submit] transaction id resolved after submit: ${seen}`);
          break;
        }
        await page.waitForTimeout(2_000);
      }
      if (!transactionNumber) {
        log.warn(
          "[Submit] the transaction id still had not resolved 30s after acknowledging the "
          + "confirmation — the submit may not have committed (the page can still read "
          + "'Transaction ID: NEW').",
        );
      }

      // New hires have no EID, so the readback matches the Transactions in
      // Progress row by NAME. This is the path that actually yields the
      // T-number: row link -> Continue -> the id below the action bar.
      if (!opts.terminationJob && !transactionNumber && (employeeId || opts.personName)) {
        transactionNumber = await readLatestTransactionNumber(page, employeeId ?? "", {
          ...(opts.personName ? { personName: opts.personName } : {}),
        });
      }
    } else {
      log.warn(
        "No post-submit confirmation dialog could be acknowledged — the submit may not have been "
        + "committed. Verify the transaction in UCPath before treating this hire as filed.",
      );
    }

    if (!transactionNumber) {
      log.step("Transaction number not found — will need manual entry");
    }
  } catch (e) {
    log.step(`Transaction number extraction failed: ${errorMessage(e)}`);
  }

  if (opts.terminationJob) {
    if (!employeeId || !opts.terminationEffectiveDate || !opts.terminationComments) throw new Error("Termination receipt requires EID, job, date, and comments");
    let receiptTxn = "";
    try {
      const receipt = await findExistingTerminationForJob(page, employeeId, opts.terminationEffectiveDate, opts.terminationJob, opts.terminationComments);
      receiptTxn = receipt.txnNumber ?? "";
    } catch (e) {
      log.warn(`[Submit] in-progress receipt verification threw: ${errorMessage(e)} — attempting SS Smart HR recovery`);
    }
    if (!receiptTxn) {
      log.step(`[Submit] In-progress grid yielded no receipt — recovering via SS Smart HR for ${employeeId}/${opts.terminationJob.emplRecord}...`);
      try {
        const ssReceipt = await findTerminationTransactionStatus(page, employeeId, {
          job: opts.terminationJob,
          effectiveDate: opts.terminationEffectiveDate,
          expectedComments: opts.terminationComments,
        });
        if (ssReceipt.found && ssReceipt.transactionId) {
          log.success(`[Submit] Recovered submitted receipt ${ssReceipt.transactionId} from SS Smart HR`);
          receiptTxn = ssReceipt.transactionId;
        }
      } catch (e) {
        log.warn(`[Submit] SS Smart HR receipt recovery threw: ${errorMessage(e)}`);
      }
    }
    if (!receiptTxn) throw new Error(`Submitted termination for ${employeeId}/${opts.terminationJob.emplRecord} has no verified receipt; do not resubmit without checking UCPath`);
    transactionNumber = receiptTxn;
  }
  return { success: true, transactionNumber };
}

/**
 * Re-navigate to Smart HR Transactions, find the employee's most recent
 * transaction row, and extract its `T######` transaction number.
 *
 * Used both by `clickSaveAndSubmit` (immediately after OK on the confirmation
 * dialog) and by retry/recovery paths that know a transaction was submitted
 * but didn't capture the number on the first pass. Returns empty string when
 * the lookup fails — callers should treat that as "couldn't read back",
 * never as "no transaction exists".
 *
 * Row match is by the Person ID column (EID) — deterministic and
 * unambiguous. Name matching was removed because upstream records (Kuali)
 * can disagree with UCPath's stored display name (nicknames like "Aki" vs
 * "Akitsugu", Last/First column confusion, spelling variants) and a
 * name-miss here cascades to "submit with no txn#" → retry → duplicate.
 *
 * Polls the Transactions list for up to 15s — the newly-submitted
 * transaction takes a beat to appear.
 */
export async function readLatestTransactionNumber(
  page: Page,
  employeeId: string,
  opts: { personName?: string } = {},
): Promise<string> {
  log.step("Re-navigating to Smart HR Transactions...");
  await navigateToSmartHR(page);
  await clickSmartHRTransactions(page);
  // clickSmartHRTransactions already awaits networkidle — no extra sleep needed.
  const txnFrame = getContentFrame(page);

  // A new hire has no EID (Person ID renders "NEW"), so the Transactions in
  // Progress row is located by NAME instead. Only a run with neither is stuck.
  const personName = opts.personName?.trim() ?? "";
  if (!employeeId && !personName) {
    log.warn("[Txn Readback] No EID and no name provided — cannot locate the submitted transaction");
    return "";
  }
  const rowKey = employeeId || personName;

  const deadline = Date.now() + 15_000;
  let linkText = "";
  while (!linkText && Date.now() < deadline) {
    // This poll is a best-effort post-submit readback (the transaction was
    // already submitted) — retry on a transient scan error the same as a
    // "not found yet" tick, rather than aborting the poll early. Unlike
    // findExistingTerminationTransaction's pre-submit duplicate guard, a
    // failure here does not risk a duplicate create.
    try {
      linkText = (await findTransactionRowLinkByEid(txnFrame, employeeId, { personName })) ?? "";
    } catch (e) {
      log.warn(`[Txn Readback] Row scan threw while polling for ${rowKey} — retrying: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!linkText) await page.waitForTimeout(1_500);
  }
  if (!linkText) {
    log.step(`Transaction row for ${rowKey} not found after 15s poll`);
    return "";
  }

  log.step(`Clicking transaction row for ${rowKey} (link='${linkText}')`);
  const link = txnFrame.getByRole("link", { name: linkText }); // allow-inline-selector -- dynamic matched-name link
  if (!(await clickIfPresent(link, {
    timeout: 5_000,
    label: "ucpath transaction row link",
  }))) {
    log.warn(`[Txn Readback] Row matched but link '${linkText}' disappeared before click`);
    return "";
  }
  // Wait for PeopleSoft to render the transaction detail page.
  await waitForPeopleSoftProcessing(txnFrame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Click Continue on transaction details page
  const continueBtn = smartHR.continueButton(txnFrame);
  if (!(await clickIfPresent(continueBtn, {
    timeout: 5_000,
    label: "ucpath transaction detail continue button",
  }))) return "";
  // Wait for PeopleSoft to load the Enter Transaction Information page.
  await waitForPeopleSoftProcessing(txnFrame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Extract "Transaction ID: T002XXXXXX" from the re-opened form.
  // The ID is below the comments/save area on the readback page, so
  // scroll there first. This also leaves the page positioned where the
  // workflow-level audit screenshot can show the T-number.
  await scrollToTransactionReadbackArea(txnFrame);
  const txnNumber = await readTxnNumberFromDetailPage(txnFrame);
  if (txnNumber) {
    log.step(`Transaction number: ${txnNumber}`);
    return txnNumber;
  }
  return "";
}

/** Result returned by `findExistingTerminationTransaction`. */
export interface ExistingTerminationResult {
  /** Transaction number if a matching row was found; `null` otherwise. */
  txnNumber: string | null;
  /**
   * `true` when the function left the page positioned at the Smart HR
   * Transactions list — i.e. it successfully navigated there but found no
   * matching row. The caller can skip a redundant
   * navigateToSmartHR + clickSmartHRTransactions when this is `true`.
   */
  alreadyAtSmartHR: boolean;
}

/**
 * Look up an existing Smart HR termination transaction for a given
 * employee. Returns an `ExistingTerminationResult` whose `txnNumber` is
 * the existing transaction number (e.g. "T002126379") if a row was found,
 * or `null` if no matching row exists.
 *
 * Used as a pre-submit idempotence check: before creating a new
 * termination transaction, callers check whether one already exists for
 * this EID + effective date. A hit means the prior run already submitted
 * (possibly without capturing the txn# locally) — return the number,
 * skip the resubmit, propagate it to downstream steps (e.g. Kuali
 * finalization).
 *
 * `alreadyAtSmartHR` is set to `true` when no row was found but the
 * function successfully navigated to Smart HR Transactions. The caller can
 * use this to skip a redundant double navigation (~12s saving per doc).
 *
 * Match semantics: row's Person ID column equals `employeeId`, row text
 * contains the effective date (MM/DD/YYYY), and row text contains
 * "Terminat" (covers "Terminatn"/"Termination" Action display variants —
 * avoids false positives on non-termination JOB rows like transfers for
 * the same employee on the same day). Name is NOT used for matching
 * because upstream records can disagree with UCPath's stored display
 * name (nicknames like "Aki" vs "Akitsugu", Last/First column confusion,
 * spelling variants) — the previous name+template approach silently
 * missed duplicates and produced real dupes (EID 10794813 Aki Uchida,
 * 2026-04-24).
 *
 * This is the pre-submit duplicate-termination guard, so a genuine scan
 * that finds no matching row returns `{ txnNumber: null }` — but a THROWN
 * navigation/scan/click error does NOT degrade to that same shape. Reading
 * "the lookup failed" as "no existing transaction found" would clear the
 * way for a second real duplicate termination, so an unresolved failure
 * now propagates instead of being swallowed here.
 */
export async function findExistingTerminationTransaction(
  page: Page,
  employeeId: string,
  effectiveDate: string,
  job?: SeparationJob,
  expectedComments?: string,
): Promise<ExistingTerminationResult> {
  if (job) return findExistingTerminationForJob(page, employeeId, effectiveDate, job, expectedComments);
  try {
    log.step(`[Txn Lookup] Checking for existing termination: eid='${employeeId}' effDate='${effectiveDate}'`);
    if (!employeeId) {
      log.warn(`[Txn Lookup] Empty EID — skipping pre-submit existence check`);
      return { txnNumber: null, alreadyAtSmartHR: false };
    }
    await navigateToSmartHR(page);
    await clickSmartHRTransactions(page);
    // clickSmartHRTransactions already awaits networkidle — no extra sleep needed.
    const frame = getContentFrame(page);

    const linkText = await findTransactionRowLinkByEid(frame, employeeId, {
      effectiveDate,
      requireTerminationAction: true,
    });
    if (!linkText) {
      log.step(`[Txn Lookup] No existing termination found for eid=${employeeId} date=${effectiveDate}`);
      // Caller can skip re-navigation — page is already at Smart HR Transactions.
      return { txnNumber: null, alreadyAtSmartHR: true };
    }
    log.step(`[Txn Lookup] Matching row found (link='${linkText}') — reading txn #`);

    // This is the pre-submit duplicate guard — `clickIfPresent` would swallow
    // a genuine click failure (element present, click throws) into the same
    // `false` as "row genuinely absent," and the code below would then treat
    // that as "no existing transaction," clearing the way for a duplicate
    // termination submit (the exact risk the outer catch below exists to
    // prevent). So only a true absence (count === 0 — the row vanished
    // between the scan and the click) is treated as "no match" here; once the
    // row is confirmed present, the click is a hard `safeClick` that THROWS
    // on failure and reaches the outer catch's fail-loud error.
    const link = frame.getByRole("link", { name: linkText }); // allow-inline-selector -- dynamic matched-name link
    if ((await link.count().catch(() => 0)) === 0) {
      log.warn(`[Txn Lookup] Row matched but link '${linkText}' disappeared before click — treating as no match`);
      return { txnNumber: null, alreadyAtSmartHR: true };
    }
    await safeClick(link.first(), {
      timeout: 5_000,
      label: "ucpath existing transaction row link",
    });
    // Wait for PeopleSoft to render the transaction detail page.
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    // Same reasoning as the row-link click above: Continue is a required
    // navigation step to reach the page that carries the Transaction ID, not
    // an optional affordance — a click failure here must propagate (not be
    // read as "no existing transaction").
    const continueBtn = smartHR.continueButton(frame);
    if ((await continueBtn.count().catch(() => 0)) === 0) {
      throw new Error(
        `[Txn Lookup] Continue button not found on the transaction detail page for eid=${employeeId} — ` +
        "cannot confirm whether an existing termination transaction exists",
      );
    }
    await safeClick(continueBtn.first(), {
      timeout: 5_000,
      label: "ucpath existing transaction continue button",
    });
    // Wait for PeopleSoft to load the transaction form after Continue.
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const txnNumber = await readTxnNumberFromDetailPage(frame);
    if (txnNumber) {
      log.success(`[Txn Lookup] Existing transaction #${txnNumber} found for eid=${employeeId}`);
      return { txnNumber, alreadyAtSmartHR: false };
    }
    log.warn(`[Txn Lookup] Matched row but couldn't extract Transaction ID from detail page — treating as no match`);
    return { txnNumber: null, alreadyAtSmartHR: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[Txn Lookup] Existing-termination lookup threw for eid=${employeeId} effDate=${effectiveDate} — ` +
      `result unknown, refusing to report "no existing transaction found" (would clear the way for a ` +
      `duplicate termination): ${message}`,
      { cause: e },
    );
  }
}

/**
 * Delete EVERY pending termination transaction for an employee from the Smart HR
 * Transactions page's "Transactions in Progress" grid, REGARDLESS of effective
 * date.
 *
 * Used by separations' `transaction-check` step before a fresh termination is
 * created. This is the real duplicate guard: a prior run can leave a pending
 * termination whose computed effective date DIFFERS from this run's, which both
 * the SS-Smart-HR effdt gate (it only reuses/flags a TER within ~14 days of THIS
 * separation) AND `findExistingTerminationTransaction`'s exact-effdt match miss —
 * so the stale pending survives and a second create produces a visible duplicate
 * in this grid (Erick Guzman 10779506: 06/14 + 06/20, 2026-06-24). The
 * in-progress grid only holds UNPROCESSED transactions, so ANY "Terminat" row
 * here for this person is a superseded prior attempt that must go before the new
 * create. (An APPROVED prior-job termination is processed and never appears in
 * this grid, so the date-agnostic sweep cannot touch it — the SS Smart HR effdt
 * gate still owns the approved-reuse decision upstream.)
 *
 * Navigates to Smart HR Transactions, ticks the Select checkbox of EVERY
 * in-progress row whose Person ID cell equals `employeeId` AND whose row text
 * contains "Terminat" (names/transaction-id columns aren't shown on this grid),
 * clicks "Delete Selected Transactions" once (it deletes all checked rows), and
 * confirms the PeopleSoft dialog (#ICOK).
 *
 * Returns the COUNT of rows deleted — `0` means a genuine "no matching pending
 * row" scan. A THROWN error (navigation/click/scan failure) is NOT swallowed
 * into that same `0`: this is the real duplicate guard the caller uses to
 * decide whether it's safe to create a fresh transaction, so reading "the
 * sweep failed" as "0 pending rows, nothing to delete" would leave a stale
 * pending termination in place while a new one gets created on top of it. The
 * checkboxes are clicked inside `frame.evaluate` because PeopleSoft's overlay
 * can intercept a Playwright click — the same escape hatch used for the #ICOK
 * dialog.
 *
 * LIVE-VERIFIED 2026-06-24 (playwright-cli, real UCPath): the EID + "Terminat"
 * exact-cell match selects precisely the right rows (real duplicate EID 10629763
 * selected both its rows; a single-row EID selected 1; an absent EID 0);
 * `checkbox.click()` inside `evaluate` flips the real PeopleSoft grid checkboxes;
 * `Delete Selected Transactions` resolves to exactly 1 button; the confirm dialog
 * is the `#ICOK` element (`document.getElementById("#ICOK")`, value "OK", text
 * "Select Ok to confirm deletion of this transaction…"). A real stale duplicate
 * row was deleted and the keeper preserved.
 */
export async function deletePendingTransaction(
  page: Page,
  employeeId: string,
): Promise<number> {
  try {
    log.step(`[Txn Delete] Deleting pending termination(s) for eid='${employeeId}'`);
    if (!employeeId) {
      log.warn(`[Txn Delete] Empty EID — skipping delete`);
      return 0;
    }
    await navigateToSmartHR(page);
    await clickSmartHRTransactions(page);
    const frame = getContentFrame(page);

    const checkedCount = await checkPendingTransactionRowsByEid(frame, employeeId);
    if (checkedCount === 0) {
      log.step(
        `[Txn Delete] No in-progress Terminatn row found for eid=${employeeId} — nothing to delete`,
      );
      return 0;
    }
    await page.waitForTimeout(1_000);

    await safeClick(smartHR.deleteSelectedTransactionsButton(frame), {
      timeout: 10_000,
      label: "ucpath delete selected transactions button",
    });
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 15_000);

    // Confirm the PeopleSoft "Delete this transaction?" dialog (OK = #ICOK).
    if (await dismissPeopleSoftDialog(page)) log.step("[Txn Delete] Confirmed delete dialog");
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    log.success(`[Txn Delete] Deleted ${checkedCount} pending termination row(s) for eid=${employeeId}`);
    return checkedCount;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[Txn Delete] Pending-termination sweep threw for eid=${employeeId} — result unknown, refusing ` +
      `to report "0 pending rows" (would leave a stale pending termination in place for a fresh ` +
      `create to duplicate): ${message}`,
      { cause: e },
    );
  }
}

/**
 * Scan the "Transactions in Progress" grid and tick the Select checkbox of EVERY
 * row whose Person ID cell equals `employeeId` and whose text contains
 * "Terminat". Returns the number of checkboxes clicked. The clicks happen inside
 * `frame.evaluate` (PeopleSoft overlay can intercept Playwright clicks).
 *
 * Checks ALL matching rows (not just the first) so a single "Delete Selected
 * Transactions" submit clears every accumulated duplicate for the EID at once.
 *
 * A genuine scan that matches zero rows already returns `0` via the normal
 * return path below — that's a real "nothing pending" result. A THROWN
 * error (frame detached, evaluate failure, etc.) is NOT swallowed into that
 * same `0`: this count backs the pending-termination sweep, so misreading
 * "the scan failed" as "0 pending rows" would leave a stale pending
 * termination in place while a new one gets created on top of it.
 */
async function checkPendingTransactionRowsByEid(
  frame: FrameLocator,
  employeeId: string,
): Promise<number> {
  return await frame.locator("body").evaluate( // allow-inline-selector -- body scan + checkbox clicks on transactions-in-progress grid
    (body, eid: string) => {
      let checked = 0;
      const tables = body.querySelectorAll("table");
      for (const table of Array.from(tables)) {
        for (const row of Array.from((table).rows)) {
          const rowText = row.textContent ?? "";
          if (!/Terminat/i.test(rowText)) continue;
          const hasEidCell = Array.from(row.cells).some(
            (c) => (c.textContent ?? "").trim() === eid,
          );
          if (!hasEidCell) continue;
          const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            checked++;
          }
        }
      }
      return checked;
    },
    employeeId,
  );
}

/**
 * Pure predicate: a "Transactions in Progress" row matches the target when
 * some cell's trimmed text exactly equals the EID **and** the full row text
 * reads as a termination action.
 *
 * This encodes the same rule used inside `checkPendingTransactionRowByEid`'s
 * `frame.evaluate(...)` browser context — extracted as a Node-side pure
 * function so it can be unit-pinned. (The checkbox click must remain inside
 * `evaluate` because PeopleSoft's overlay intercepts Playwright clicks; a
 * Node-side rewire would require splitting the evaluate into two round-trips
 * and is therefore left as-is.)
 *
 * Pure — unit-pinned by tests/unit/systems/ucpath/transaction.test.ts.
 */
export function rowMatchesTerminationEid(
  cellTexts: readonly string[],
  rowText: string,
  eid: string,
): boolean {
  return cellTexts.some((c) => c.trim() === eid) && /Terminat/i.test(rowText);
}

/**
 * SS Smart HR approval statuses that PROVE UCPath accepted the submitted
 * transaction. The Approval Status combobox exposes exactly six values
 * (`ssSmartHRTransactions.approvalStatusSelect`, verified 2026-04-24):
 * Approved / Denied / Error / Manually Processed / Pending / Pushed Back.
 */
export const TXN_RECEIPT_ACCEPTED_STATUSES = ["Approved", "Manually Processed"] as const;

/**
 * The one LEGITIMATE INTERMEDIATE status. A freshly submitted Smart HR
 * transaction sits in `Pending` until an approver acts — the submit itself
 * succeeded, but the transaction has NOT been accepted yet. Modeled as its own
 * outcome so callers neither collapse it into failure nor report it as a
 * finished, accepted transaction.
 */
export const TXN_RECEIPT_PENDING_STATUSES = ["Pending"] as const;

/**
 * Statuses that mean UCPath REFUSED the transaction — it did not go through and
 * a human must decide what happens next. `Recycled`/`Cancelled` are not in the
 * combobox but are recognized by the SS Smart HR grid parser
 * (`parseSsSmartHrRows`), so they are classified here rather than left unknown.
 */
export const TXN_RECEIPT_REFUSED_STATUSES = [
  "Denied",
  "Error",
  "Pushed Back",
  "Recycled",
  "Cancelled",
  "Canceled",
] as const;

/**
 * What a post-submit receipt PAIR proves about the submitted transaction.
 *
 * - `accepted` — UCPath accepted it (`Approved` / `Manually Processed`).
 * - `pending`  — submitted and awaiting approval (`Pending`). A real, expected
 *                intermediate; the caller must surface it distinctly, NOT as a
 *                finished success and NOT as a failure.
 * - `refused`  — UCPath refused it (`Denied` / `Error` / `Pushed Back` / …).
 * - `unknown`  — the pair does not prove anything: no readable transaction
 *                number, or a number with a blank/unrecognized status. Never
 *                degrade this into "assume approved" (fail-loud rule).
 */
export type PostSubmitTxnOutcome = "accepted" | "pending" | "refused" | "unknown";

/** Interpreted post-submit receipt (see {@link interpretPostSubmitTxnReadback}). */
export interface PostSubmitTxnReadback {
  /** The readback transaction number, normalized — `""` when unreadable. */
  transactionNumber: string;
  /** The readback approval status, whitespace-collapsed — `""` when unread. */
  approvalStatus: string;
  /** What the PAIR proves. */
  outcome: PostSubmitTxnOutcome;
  /** True when no real transaction number could be read back at all. */
  submittedWithoutTxnNumber: boolean;
  /**
   * True ONLY for `accepted`. The single boolean a caller may treat as "this
   * transaction is a successful receipt".
   */
  accepted: boolean;
}

/**
 * Pure: classify an SS Smart HR approval status. Case- and
 * whitespace-insensitive. Anything not POSITIVELY recognized — blank, `Saved`,
 * `Needs Review`, a truncated scrape — is `unknown`, never optimistically
 * accepted. Unit-pinned.
 */
export function classifyTxnApprovalStatus(
  approvalStatus: string | null | undefined,
): PostSubmitTxnOutcome {
  const norm = (approvalStatus ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm) return "unknown";
  const has = (set: readonly string[]): boolean =>
    set.some((s) => s.toLowerCase() === norm);
  if (has(TXN_RECEIPT_ACCEPTED_STATUSES)) return "accepted";
  if (has(TXN_RECEIPT_PENDING_STATUSES)) return "pending";
  if (has(TXN_RECEIPT_REFUSED_STATUSES)) return "refused";
  return "unknown";
}

/**
 * Pure decision for stamping a post-submit Smart HR transaction readback into
 * tracker data.
 *
 * **Success is proved by the PAIR `(transactionNumber, approvalStatus)`, never
 * by the number alone.** UCPath issues a `T…` number for a transaction
 * REGARDLESS of its outcome — live `T002204014` is a well-formed number on a
 * **Denied** transaction — so the old number-only shape stamped a refused
 * UCPath transaction as a successful receipt (fixed 2026-08-04; the number-only
 * signature is gone rather than deprecated so no caller can re-enter the bug).
 *
 * The number is still validated first (`T` + ≥6 digits, e.g. `T002114817`);
 * anything else — empty, `"NEW"` (what the Person ID column renders for an
 * unprocessed hire), whitespace, a stray grid value — maps to the explicit
 * `submittedWithoutTxnNumber` marker instead of being stamped as if it were a
 * number, mirroring separations' pattern. A valid number with an
 * unreadable/unrecognized status is a DIFFERENT distinguishable state
 * (`outcome: "unknown"`, `submittedWithoutTxnNumber: false`) — the caller must
 * surface it, never assume approval. Unit-pinned.
 */
export function interpretPostSubmitTxnReadback(
  txnNumber: string | null | undefined,
  approvalStatus: string | null | undefined,
): PostSubmitTxnReadback {
  const normalizedNumber = (txnNumber ?? "").trim().toUpperCase();
  const normalizedStatus = (approvalStatus ?? "").replace(/\s+/g, " ").trim();
  if (!/^T\d{6,}$/.test(normalizedNumber)) {
    return {
      transactionNumber: "",
      approvalStatus: normalizedStatus,
      outcome: "unknown",
      submittedWithoutTxnNumber: true,
      accepted: false,
    };
  }
  const outcome = classifyTxnApprovalStatus(normalizedStatus);
  return {
    transactionNumber: normalizedNumber,
    approvalStatus: normalizedStatus,
    outcome,
    submittedWithoutTxnNumber: false,
    accepted: outcome === "accepted",
  };
}

export function extractSmartHrTransactionNumber(text: string): string | null {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");
  const match =
    normalized.match(/Transaction\s+ID\s*:?\s*(T\d{6,})/i)
    ?? normalized.match(/Transaction\s*:?\s*(T\d{6,})/i)
    ?? normalized.match(/\b(T\d{6,})\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

async function readTxnNumberFromDetailPage(frame: FrameLocator): Promise<string | null> {
  const body = frame.locator("body"); // allow-inline-selector -- body readback for PeopleSoft transaction detail scrape
  const bodyText = await body.innerText({ timeout: 5_000 }).catch(() => "");
  const textContent = await body.evaluate((el) => el.textContent ?? "").catch(() => "");
  return extractSmartHrTransactionNumber(`${bodyText}\n${textContent}`);
}

export async function scrollToTransactionReadbackArea(frame: FrameLocator): Promise<boolean> {
  return await frame.locator("body").evaluate((body) => { // allow-inline-selector -- body-scoped scroll to Smart HR readback markers
    const markerRe = /Transaction\s*(?:ID)?\s*:|\bT\d{6,}\b/i;
    const all = Array.from(body.querySelectorAll<HTMLElement>("span, div, td, th, label, a, textarea"));
    const target = all.find((el) => markerRe.test(el.textContent ?? ""));
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      return true;
    }
    const doc = body.ownerDocument;
    doc.defaultView?.scrollTo(0, Math.max(body.scrollHeight, doc.documentElement.scrollHeight));
    return false;
  }).catch(() => false);
}

/**
 * Scan the Smart HR Transactions list inside `frame` for a row whose
 * Person ID cell equals `employeeId`. Returns the row's employee-link
 * text (which callers can pass to `getByRole("link", { name })` for
 * clicking) or `null` if no row matches.
 *
 * EID match is done by exact cell content (`cell.textContent.trim() ===
 * employeeId`) rather than substring-of-row-text to avoid false positives
 * from dept IDs / location codes that might incidentally contain the EID
 * digits.
 *
 * A genuine scan that finds no matching row returns `null` via the normal
 * return path above. A THROWN scan error (frame detached, evaluate
 * failure, etc.) is NOT swallowed into that same `null` here — one caller
 * (`findExistingTerminationTransaction`) uses this as a pre-submit
 * duplicate-termination guard, where "scan failed" misread as "no row"
 * would clear the way for a duplicate create. Callers that want a
 * best-effort degrade (e.g. `readLatestTransactionNumber`'s post-submit
 * readback poll) catch locally at their own call site instead.
 */
async function findTransactionRowLinkByEid(
  frame: FrameLocator,
  employeeId: string,
  opts?: { effectiveDate?: string; requireTerminationAction?: boolean; personName?: string },
): Promise<string | null> {
  return await frame.locator("body").evaluate( // allow-inline-selector -- body scan for smart-hr-transactions list
    (body, { eid, date, requireTerm, name }: { eid: string; date?: string; requireTerm?: boolean; name?: string }) => {
      const tables = body.querySelectorAll("table");
      for (const table of Array.from(tables)) {
        for (const row of Array.from((table).rows)) {
          const rowText = row.textContent ?? "";
          if (date && !rowText.includes(date)) continue;
          if (requireTerm && !/Terminat/i.test(rowText)) continue;
          const cells = Array.from(row.cells).map((c) => (c.textContent ?? "").trim());
          // A brand-new hire's Person ID renders "NEW", so there is no EID to
          // match — fall back to the Name cell, which the Transactions in
          // Progress grid always carries.
          const matched = eid
            ? cells.some((c) => c === eid)
            : Boolean(name) && cells.some((c) => c.toUpperCase() === (name ?? "").toUpperCase());
          if (!matched) continue;
          const link = row.querySelector("a");
          const linkText = (link?.textContent ?? "").trim();
          if (!linkText) continue;
          return linkText;
        }
      }
      return null;
    },
    {
      eid: employeeId,
      date: opts?.effectiveDate,
      requireTerm: opts?.requireTerminationAction,
      name: opts?.personName,
    },
  );
}

// ─── Helpers ───

/**
 * Extract numeric pay rate from CRM wage string.
 * e.g. "$17.75 per hour" → "17.75"
 */
export function parsePayRate(wage: string): string {
  // First number-like token, commas included — wages arrive as "$17.75 per
  // hour", "$1,250.00 biweekly", or bare "20". The previous /[\d.]+/ stopped at
  // the first comma, so "$1,250.00" silently parsed as "1" — a wrong rate typed
  // into a real UCPath transaction.
  const match = wage.match(/\$?\s*([\d,]*\d(?:\.\d+)?)/);
  if (!match) {
    // Fail loud: a non-numeric wage ("TBD", "Negotiable", "N/A") must NOT be
    // typed verbatim into the UCPath Compensation Rate field. Surface it so the
    // upstream CRM record gets fixed, rather than silently submitting garbage.
    throw new Error(
      `parsePayRate: no numeric rate found in wage string "${wage}" — refusing to submit an unparseable pay rate to UCPath`,
    );
  }
  const token = match[1];
  // Commas must be well-formed thousands groups ("1,250" / "12,345.67").
  // Stripping the comma from a malformed token like "1,25.00" would silently
  // submit 125 — refuse instead so the source record gets fixed.
  if (token.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) {
    throw new Error(
      `parsePayRate: ambiguous digit separators in wage string "${wage}" — refusing to submit an unparseable pay rate to UCPath`,
    );
  }
  return token.replace(/,/g, "");
}

/**
 * Build the comments string for a new hire transaction.
 *
 * When SSN is present:
 *   "New Dining Student Hire Effective {date}. Job number #{num}."
 *
 * When SSN is missing (international student):
 *   "New Dining Student Hire Effective {date}. Job number #{num}. EE does not have an SSN yet, we will add it as soon as it is provided."
 */
export function buildCommentsText(
  effectiveDate: string,
  recruitmentNumber: string,
  hasSsn = true,
): string {
  const base = `New Dining Student Hire Effective ${effectiveDate}. Job number #${recruitmentNumber}.`;
  if (!hasSsn) {
    return `${base} EE does not have an SSN yet, we will add it as soon as it is provided.`;
  }
  return base;
}

/**
 * Build the Smart HR comments text for a CONCURRENT HIRE (UC_CONC_HIRE — an
 * existing UCPath person taking an additional Dining job). Mirrors the
 * operator's manual comment verbatim (2026-08-20, T002216750):
 *
 *   "Concurrent Hire as Dining Student Effective 09/11/2026. PCN 40699123. Job number #1169086."
 *
 * PCN = the position number being filled; Job number = the CRM recruitment number.
 * No SSN clause — the person record (and its National ID) already exists.
 */
export function buildConcurrentHireCommentsText(
  effectiveDate: string,
  positionNumber: string,
  recruitmentNumber: string,
): string {
  return `Concurrent Hire as Dining Student Effective ${effectiveDate}. PCN ${positionNumber}. Job number #${recruitmentNumber}.`;
}


/** Inspect each exact in-progress row; never sweep or reuse another concurrent job. */
async function findExistingTerminationForJob(page: Page, eid: string, effectiveDate: string, job: SeparationJob, expectedComments?: string): Promise<ExistingTerminationResult> {
  matchesSeparationJob(job, job);
  if (!expectedComments?.trim()) throw new Error("Job-scoped termination lookup requires canonical comments");
  await navigateToSmartHR(page);
  await clickSmartHRTransactions(page);
  const frame = getContentFrame(page);
  await smartHR.createTransactionButton(frame).waitFor();
  const ids = await smartHR.transactionBody(frame).evaluate((body, { employeeId, targetDate }) => {
    const ids: string[] = [];
    for (const row of Array.from(body.querySelectorAll("tr"))) {
      const cells = Array.from(row.cells).map(c => (c.textContent ?? "").trim());
      if (!cells.includes(employeeId) || !cells.some(c => /^Terminat/i.test(c))) continue;
      // Filter before opening historical receipts:
      // Exclude wrong-date receipts before employee drill-in.
      if (targetDate && !row.textContent?.includes(targetDate)) continue;
      const link = row.querySelector<HTMLAnchorElement>('a[id^="NAME$"]');
      if (!link?.id) throw new Error("Termination row has no stable employee link");
      ids.push(link.id);
    }
    return ids;
  }, { employeeId: eid, targetDate: effectiveDate });
  const found: { txn: string; linkId: string }[] = [];
  for (const [index, id] of ids.entries()) {
    if (index > 0) { await navigateToSmartHR(page); await clickSmartHRTransactions(page); }
    await safeClick(smartHR.transactionLinkById(frame, id), { label: "exact termination row" });
    await waitForPeopleSoftProcessing(frame, 15_000);

    const dialogText = await readPeopleSoftDialogText(page);
    if (dialogText) {
      await dismissPeopleSoftDialog(page);
      throw new Error(`UCPath dialog on termination receipt row ${id}: "${dialogText}"`);
    }

    const employmentRecord = smartHR.employmentRecordSelect(frame);
    if (await employmentRecord.count() === 1) {
      await safeClick(smartHR.continueButton(frame), { label: "exact termination continue" });
      await waitForPeopleSoftProcessing(frame, 15_000);
      await page.waitForLoadState("networkidle");
    } else if (await jobDataSelectors.positionNumberInput(frame).count() !== 1) {
      const postDialog = await readPeopleSoftDialogText(page);
      if (postDialog) {
        await dismissPeopleSoftDialog(page);
        throw new Error(`UCPath dialog on termination receipt row ${id}: "${postDialog}"`);
      }
      throw new Error(
        `Termination receipt row ${id} did not open a verified job form: ` +
        "Employment Record Number and Position Number are both absent",
      );
    } else {
      log.step(`[Smart HR] Termination row ${id} opened its job form directly (single employment record)`);
    }

    const actual = await readTerminationJob(frame);
    if (actual.eid !== eid) throw new Error(`Termination grid changed: expected ${eid}, found ${actual.eid}`);
    if (!matchesSeparationJob(actual, job)) continue;
    if (actual.effectiveDate !== effectiveDate) throw new Error(`Existing termination for ${eid}/${job.emplRecord}/${job.positionNumber} has date ${actual.effectiveDate}, expected ${effectiveDate}; resolve before another submit`);
    const txn = await readTxnNumberFromDetailPage(frame);
    if (!txn) throw new Error(`Existing termination for ${eid}/${job.emplRecord} has no transaction number; do not create a duplicate draft`);
    const body = await smartHR.transactionBody(frame).innerText();
    if (!/\bPending\b/.test(body)) throw new Error(`Transaction ${txn} does not have a verified Pending receipt`);
    const comments = await commentsSelectors.commentsTextarea(frame).inputValue();
    const initiator = await commentsSelectors.initiatorCommentsTextarea(frame).inputValue();
    if (!comments.trim() || !initiator.trim() || (expectedComments !== undefined && (!commentsMatchTermination(comments, expectedComments) || !commentsMatchTermination(initiator, expectedComments)))) {
      throw new Error(`Transaction ${txn} is missing or has incorrect Comments / Initiator Comments; correct it before reuse`);
    }
    found.push({ txn, linkId: id });
  }
  if (found.length > 1) throw new Error(`Multiple pending terminations match ${eid}/${job.emplRecord}/${job.positionNumber}: ${found.map(row => row.txn).join(", ")}`);
  const match = found[0];
  // Leave the verified receipt on screen, even when a different concurrent job was scanned last.
  if (match && match.linkId !== ids.at(-1)) {
    await navigateToSmartHR(page);
    await clickSmartHRTransactions(page);
    await safeClick(smartHR.transactionLinkById(frame, match.linkId), { label: "matching termination receipt" });
    await waitForPeopleSoftProcessing(frame, 15_000);
    const dialogText = await readPeopleSoftDialogText(page);
    if (dialogText) {
      await dismissPeopleSoftDialog(page);
      throw new Error(`UCPath dialog on termination receipt ${match.txn}: "${dialogText}"`);
    }
    const employmentRecord = smartHR.employmentRecordSelect(frame);
    if (await employmentRecord.count() === 1) {
      await safeClick(smartHR.continueButton(frame), { label: "matching termination receipt continue" });
      await waitForPeopleSoftProcessing(frame, 15_000);
      await page.waitForLoadState("networkidle");
    }
    await verifyTerminationJob(frame, eid, job, effectiveDate);
    if (await readTxnNumberFromDetailPage(frame) !== match.txn) throw new Error("Termination receipt changed during verification");
  }
  return { txnNumber: match?.txn ?? null, alreadyAtSmartHR: ids.length === 0 };
}
