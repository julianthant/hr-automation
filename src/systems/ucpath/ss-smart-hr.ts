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
 * NEEDS LIVE VERIFY: the results-grid scan (`scanSsSmartHrResults`) and the
 * post-search settle were authored against the screenshots of the live page;
 * the header-keyed column mapping must be confirmed against the real grid
 * (PeopleSoft nests tables and can split header/data rows).
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

/**
 * Scan the SS Smart HR Transactions results grid into parsed rows. Locates the
 * data table by its header (a row carrying "Transaction ID", "Action", and
 * "Approval Status" cells), then maps those columns by header position so the
 * parse survives column reordering. Returns `[]` on any failure.
 */
async function scanSsSmartHrResults(frame: FrameLocator): Promise<SsSmartHrRow[]> {
  return await frame.locator("body").evaluate((body) => { // allow-inline-selector -- body scan for SS Smart HR results grid
    const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
    const tables = Array.from(body.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from((table as HTMLTableElement).rows);
      let headerIdx = -1;
      let txIdx = -1;
      let actIdx = -1;
      let statIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const cells = Array.from(rows[i].cells).map((c) => norm(c.textContent));
        const tx = cells.findIndex((t) => /transaction id/i.test(t));
        const act = cells.findIndex((t) => /^action$/i.test(t));
        const st = cells.findIndex((t) => /approval\s*status/i.test(t));
        if (tx >= 0 && act >= 0 && st >= 0) {
          headerIdx = i;
          txIdx = tx;
          actIdx = act;
          statIdx = st;
          break;
        }
      }
      if (headerIdx < 0) continue;
      const out: Array<{ transactionId: string; action: string; approvalStatus: string }> = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].cells).map((c) => norm(c.textContent));
        if (cells.length <= Math.max(txIdx, actIdx, statIdx)) continue;
        const transactionId = cells[txIdx] ?? "";
        const action = cells[actIdx] ?? "";
        const approvalStatus = cells[statIdx] ?? "";
        if (!transactionId && !action && !approvalStatus) continue;
        out.push({ transactionId, action, approvalStatus });
      }
      if (out.length) return out;
    }
    return [];
  }).catch(() => []);
}
