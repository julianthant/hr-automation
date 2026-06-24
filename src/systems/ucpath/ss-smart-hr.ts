import type { Page, FrameLocator } from "playwright";
import { log } from "../../utils/log.js";
import {
  navigateToSmartHR,
  collapseSidebar,
  waitForPeopleSoftProcessing,
} from "./navigate.js";
import { getContentFrame, ssSmartHRTransactions, hrTasks } from "./selectors.js";
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
  /** True when a TER (termination) row exists for the searched EID. */
  found: boolean;
  /** Transaction number of the TER row (empty when not found). */
  transactionId: string;
  /** Approval status of the TER row (empty when not found). */
  approvalStatus: string;
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
 * Best-effort scan: a parse failure degrades to `found: false` (the separations
 * `ucpath-transaction` step's own `findExistingTerminationTransaction` is the
 * backstop against duplicate submits) rather than throwing.
 */
export async function findTerminationTransactionStatus(
  page: Page,
  eid: string,
): Promise<TerminationTransactionStatus> {
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
    return { found: false, transactionId: "", approvalStatus: "" };
  }
  log.step(
    `[SS Smart HR] Existing TER transaction for EID ${eid}: ` +
    `txn='${ter.transactionId}' status='${ter.approvalStatus}'`,
  );
  return { found: true, transactionId: ter.transactionId, approvalStatus: ter.approvalStatus };
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
 * `parseSsSmartHrRows`. Returns `[]` on any failure.
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
  }).catch(() => [] as string[][]);
  return parseSsSmartHrRows(matrix);
}
