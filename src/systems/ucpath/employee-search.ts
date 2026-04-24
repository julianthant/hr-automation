import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { getContentFrame, waitForPeopleSoftProcessing } from "./navigate.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";

/**
 * Name-based UCPath employee lookup.
 *
 * Used as a last-resort fallback when an upstream-supplied EID fails to
 * resolve in UCPath (e.g. HR admin entered a typo in Kuali). Searches
 * Person Organizational Summary by Last Name + First Name and returns
 * the first matching EID.
 *
 * **Not dept-filtered.** Unlike the eid-lookup workflow (which applies an
 * HDH keyword whitelist to rule out cross-unit matches), this primitive
 * returns whatever UCPath surfaces first. Appropriate for separations-
 * style flows where the user has already identified the employee in
 * another system (Kuali Build) and just needs UCPath's canonical EID.
 *
 * Callers that need dept/BU filtering should use the eid-lookup workflow
 * instead.
 */

export interface EmployeeLookupResult {
  emplId: string;
  /** Last Name as PeopleSoft displays it in the result row. */
  lastName: string;
  /** First + middle (as PeopleSoft joined the "Name" column). */
  name: string;
}

/** Direct URL — same as person-org-summary-fallback. */
const PERSON_ORG_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

/** PeopleSoft iframe search button id (shared with fallback + eid-lookup). */
const SEARCH_BTN_ID = "PTS_CFG_CL_WRK_PTS_SRCH_BTN";

/**
 * Parse "Last, First Middle" OR "First Last" into name parts. Returns null
 * when the input can't be split into a lastName + firstName.
 */
function parseName(
  input: string,
): { lastName: string; firstName: string; middleName: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // "Last, First Middle" — the canonical UCPath/Kuali format.
  if (trimmed.includes(",")) {
    const [lastRaw, rest] = trimmed.split(",").map((s) => s.trim());
    if (!lastRaw || !rest) return null;
    const parts = rest.split(/\s+/).filter((s) => s.length > 0);
    return {
      lastName: lastRaw,
      firstName: parts[0] ?? "",
      middleName: parts.length > 1 ? parts.slice(1).join(" ") : null,
    };
  }

  // "First [Middle] Last" — fallback for display-style names.
  const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  return {
    lastName: parts[parts.length - 1],
    firstName: parts[0],
    middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : null,
  };
}

/**
 * Look up an EID by employee name via Person Org Summary search.
 *
 * Tries name variants in this order (same as eid-lookup's fallback chain,
 * minus the middle-only strategy which matters for HDH-filtered searches
 * but not here):
 *   1. lastName + "firstName middleName"
 *   2. lastName + "firstName"
 *
 * Returns the first result row's EID, or null when no match is found or
 * the page structure doesn't match expectations. Best-effort — never
 * throws. Callers treat null as "name fallback exhausted, give up."
 */
export async function lookupEmplIdByName(
  page: Page,
  name: string,
): Promise<EmployeeLookupResult | null> {
  const parsed = parseName(name);
  if (!parsed) {
    log.warn(`[Employee Search] Cannot parse name '${name}' — expected 'Last, First [Middle]' or 'First [Middle] Last'`);
    return null;
  }
  const { lastName, firstName, middleName } = parsed;

  const variants: Array<{ label: string; name: string }> = [];
  if (middleName) variants.push({ label: "full", name: `${firstName} ${middleName}` });
  variants.push({ label: "first-only", name: firstName });

  try {
    log.step(`[Employee Search] Navigating to Person Org Summary for name='${lastName}, ${firstName}${middleName ? " " + middleName : ""}'`);
    await page.goto(PERSON_ORG_SUMMARY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(5_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const posLink = page.getByRole("link", { name: "Person Organizational Summary" }); // allow-inline-selector -- fallback-only sidebar nav
    await posLink.click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    try {
      const navBtn = page.getByRole("button", { name: "Navigation Area" }); // allow-inline-selector -- fallback-only sidebar collapse
      if ((await navBtn.getAttribute("aria-expanded")) === "true") {
        await navBtn.click({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
      }
    } catch {
      // Sidebar may already be collapsed.
    }

    await dismissPeopleSoftModalMask(page);
    const frame = getContentFrame(page);

    for (const variant of variants) {
      log.step(`[Employee Search] Variant '${variant.label}': lastName='${lastName}', name='${variant.name}'`);

      // Clear prior inputs (second iteration) via the Clear button before
      // filling — inputs retain values across searches otherwise.
      if (variants.indexOf(variant) > 0) {
        try {
          await frame.getByRole("button", { name: "Clear", exact: true }).click({ timeout: 5_000 }); // allow-inline-selector -- fallback-only clear button
          await page.waitForTimeout(1_000);
        } catch {
          // Clear button isn't always present; fall back to manual clears.
          try { await frame.getByRole("textbox", { name: "Last Name" }).fill("", { timeout: 5_000 }); } catch { /* ignore */ } // allow-inline-selector -- fallback-only input clear
          try { await frame.getByRole("textbox", { name: "Name", exact: true }).fill("", { timeout: 5_000 }); } catch { /* ignore */ } // allow-inline-selector -- fallback-only input clear
        }
      }

      await frame.getByRole("textbox", { name: "Last Name" }).fill(lastName, { timeout: 10_000 }); // allow-inline-selector -- fallback-only
      await frame.getByRole("textbox", { name: "Name", exact: true }).fill(variant.name, { timeout: 10_000 }); // allow-inline-selector -- fallback-only
      await frame.locator(`#${SEARCH_BTN_ID}`).click({ timeout: 10_000 }); // allow-inline-selector -- fallback-only search button id
      await page.waitForTimeout(3_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await waitForPeopleSoftProcessing(frame).catch(() => {});

      const noResults = await frame
        .getByText("No matching values were found.") // allow-inline-selector -- literal PeopleSoft empty-results sentinel
        .count()
        .catch(() => 0);
      if (noResults > 0) {
        log.step(`[Employee Search] Variant '${variant.label}' — no results, trying next variant`);
        continue;
      }

      // Read the first row of the results grid. PeopleSoft's configurable
      // search results table id is stable: tdgbrPTS_CFG_CL_STD_RSL$0. Each
      // data row has 9 cells: EID(0), Empl Record(1), HR Status(2),
      // Business Unit(3), Job Code(4), Job Code Desc(5), Last Name(6),
      // Name(7), Drill in(8). A single-result redirect skips the grid —
      // detect that path too.
      const found = await frame.locator("body").evaluate((body) => { // allow-inline-selector -- fallback-only body scan
        // Grid path.
        const table = body.querySelector("table[id='tdgbrPTS_CFG_CL_STD_RSL$0']");
        if (table) {
          for (const row of Array.from((table as HTMLTableElement).rows)) {
            const cells = Array.from(row.cells);
            if (cells.length !== 9) continue;
            const emplId = cells[0]?.textContent?.trim() ?? "";
            if (/^\d{5,}$/.test(emplId)) {
              return {
                emplId,
                lastName: cells[6]?.textContent?.trim() ?? "",
                name: cells[7]?.textContent?.trim() ?? "",
                mode: "grid",
              };
            }
          }
        }
        // Single-result redirect path. The detail page shows the EID in
        // the assignment table (12+ cell row, cell[3] = BU code).
        const tables = body.querySelectorAll("table");
        for (const t of Array.from(tables)) {
          for (const row of Array.from((t as HTMLTableElement).rows)) {
            const cells = Array.from(row.cells);
            if (cells.length >= 12) {
              const bu = cells[3]?.textContent?.trim() ?? "";
              if (/^[A-Z]{4,5}\d?$/.test(bu)) {
                // Detail page doesn't include EID in the assignment row
                // directly — scan the page for the "Empl ID" label
                // display element.
                const labels = body.querySelectorAll("span, label, div");
                for (const label of Array.from(labels)) {
                  const text = label.textContent?.trim() ?? "";
                  const match = /(\d{7,})/.exec(text);
                  if (match) return { emplId: match[1], lastName: "", name: "", mode: "single" };
                }
              }
            }
          }
        }
        return null;
      }).catch(() => null);

      if (found) {
        log.success(
          `[Employee Search] Variant '${variant.label}' — found EID ${found.emplId} (${found.mode} path)`,
        );
        return { emplId: found.emplId, lastName: found.lastName, name: found.name };
      }

      log.step(`[Employee Search] Variant '${variant.label}' — page did not yield a recognizable result row, trying next variant`);
    }

    log.warn(`[Employee Search] All name variants exhausted for '${name}'`);
    return null;
  } catch (e) {
    log.warn(`[Employee Search] Lookup threw: ${errorMessage(e)}`);
    return null;
  }
}
