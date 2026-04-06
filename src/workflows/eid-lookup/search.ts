/**
 * EID Lookup: Search Person Organizational Summary by name.
 *
 * Navigates to the Person Org Summary search page (via HR Tasks sidebar),
 * fills name fields, and extracts results filtered for SDCMP business unit.
 *
 * Search strategy for input "Last, First Middle":
 *   1. Last Name = Last, Name = "First Middle"
 *   2. Last Name = Last, Name = "First" (drop middle)
 *   3. Last Name = Last, Name = "Middle" (try middle as first)
 *
 * All selectors verified via playwright-cli v1.0 against live UCPath.
 */

import type { Page, FrameLocator } from "playwright";
import { getContentFrame, waitForPeopleSoftProcessing } from "../../ucpath/navigate.js";
import { log } from "../../utils/log.js";

/** Direct URL to Person Org Summary — opens in the HR Tasks iframe. */
const PERSON_ORG_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

/** PeopleSoft iframe search button ID. */
const SEARCH_BTN_ID = "PTS_CFG_CL_WRK_PTS_SRCH_BTN";

export interface EidResult {
  emplId: string;
  emplRecord: string;
  hrStatus: string;
  businessUnit: string;
  jobCode: string;
  jobCodeDescription: string;
  lastName: string;
  name: string;
  /** Populated after drill-in */
  department?: string;
  deptId?: string;
  positionNumber?: string;
  effectiveDate?: string;
  expectedEndDate?: string;
  fte?: string;
  emplClass?: string;
  rowIndex?: number;
}

export interface EidSearchResult {
  query: { lastName: string; name: string };
  results: EidResult[];
  sdcmpResults: EidResult[];
}

/**
 * Parse "Last, First Middle" input format into name parts.
 */
export function parseNameInput(input: string): {
  lastName: string;
  first: string;
  middle: string | null;
} {
  const [lastRaw, rest] = input.split(",").map((s) => s.trim());
  if (!lastRaw || !rest) {
    throw new Error(`Invalid name format: "${input}". Expected "Last, First Middle" or "Last, First".`);
  }
  const parts = rest.split(/\s+/);
  return {
    lastName: lastRaw,
    first: parts[0],
    middle: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

/**
 * Navigate to Person Org Summary and wait for the search form to load.
 * Collapses the sidebar so the Search button is clickable.
 */
async function navigateToPersonOrgSummary(page: Page): Promise<FrameLocator> {
  log.step("Navigating to Person Organizational Summary...");
  await page.goto(PERSON_ORG_SUMMARY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Click "Person Organizational Summary" in sidebar nav
  // SELECTOR: verified v1.0 — link text in HR Tasks sidebar
  const posLink = page.getByRole("link", { name: "Person Organizational Summary" });
  await posLink.click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  log.step("Person Org Summary page loaded");

  // Collapse sidebar to avoid click interception on iframe buttons
  // SELECTOR: verified v1.0 — Navigation Area button
  try {
    const navBtn = page.getByRole("button", { name: "Navigation Area" });
    if (await navBtn.getAttribute("aria-expanded") === "true") {
      await navBtn.click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
      log.step("Sidebar collapsed");
    }
  } catch {
    // Sidebar may already be collapsed
  }

  return getContentFrame(page);
}

/**
 * Fill the search form and click Search. Returns after results load.
 *
 * SELECTOR IDs (verified via playwright-cli v1.0):
 * - Last Name textbox: role textbox "Last Name" in iframe
 * - Name textbox: role textbox "Name" (exact) in iframe
 * - Search button: #PTS_CFG_CL_WRK_PTS_SRCH_BTN in iframe
 */
async function executeSearch(
  page: Page,
  frame: FrameLocator,
  lastName: string,
  name: string,
): Promise<void> {
  log.step(`Searching: Last Name="${lastName}", Name="${name}"`);

  // Fill Last Name
  await frame.getByRole("textbox", { name: "Last Name" }).fill(lastName, { timeout: 10_000 });

  // Fill Name (first/middle)
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(name, { timeout: 10_000 });

  // Click Search
  await frame.locator(`#${SEARCH_BTN_ID}`).click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);
}

/**
 * Check if PeopleSoft navigated directly to the detail page (single-result case).
 * When search returns exactly 1 match, PeopleSoft skips the results grid and
 * shows the detail page immediately. Detected by the presence of the person ID
 * field and Employment Instances section.
 *
 * SELECTOR IDs (verified via playwright-cli v1.2):
 * - Person ID: text content near "Person ID" label (generic element after it)
 * - Person name: generic element containing the full name
 * - Termination Date: #PER_INST_EMP_VW_TERMINATION_DT$0
 * - Last Hire Date: #PER_INST_EMP_VW_LAST_HIRE_DT$0
 * - Assignments table: same structure as drill-in detail page
 * - Return to Search button: role button "Return to Search"
 */
async function extractSingleResultDetail(
  frame: FrameLocator,
): Promise<EidResult | null> {
  // Check if the detail page is showing (person ID field is present)
  const personIdLocator = frame.locator("#PER_INST_EMP_VW_OPRID\\$0").or(
    frame.locator("#PER_INST_EMP_VW_EMPLID\\$0"),
  );
  const hasDetail = await personIdLocator.count().catch(() => 0);
  if (hasDetail === 0) return null;

  // Extract the EID from the page — look for 8-digit number near "Person ID" or "Person Organizational Summary"
  const emplId = await frame.locator("body").evaluate((body) => {
    // Look for a standalone 8-digit number in a span/div (the Person ID value)
    const allElements = body.querySelectorAll("span, div");
    for (const el of Array.from(allElements)) {
      const text = el.textContent?.trim() ?? "";
      if (/^10\d{6}$/.test(text) && el.children.length === 0) {
        return text;
      }
    }
    return null;
  }).catch(() => null);

  if (!emplId) return null;

  log.success(`Single-result detail page detected — EID: ${emplId}`);

  // Extract dates from ORG Instance section
  const startDate = await frame.locator("#PER_INST_EMP_VW_LAST_HIRE_DT\\$0")
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");
  const termDate = await frame.locator("#PER_INST_EMP_VW_TERMINATION_DT\\$0")
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");

  // Extract name from the page
  const fullName = await frame.locator("body").evaluate((body) => {
    // The name appears as a text node near the Person ID, often in a generic/span element
    const allElements = body.querySelectorAll("span, div");
    for (const el of Array.from(allElements)) {
      const text = el.textContent?.trim() ?? "";
      // Name pattern: "First Last" (2+ words, letters only, no digits)
      if (/^[A-Za-z]+\s+[A-Za-z]+/.test(text) && text.length < 60 && !/\d/.test(text) && el.children.length === 0) {
        // Skip common UI labels
        if (!["Search Criteria", "Recent Searches", "Saved Searches", "Employment Instances",
              "Person Organizational Summary", "Return to Search", "Show fewer options",
              "Navigation Area", "Julian Zaw"].some((label) => text.includes(label))) {
          return text;
        }
      }
    }
    return null;
  }).catch(() => null);

  // Extract assignment details (same logic as drillInAndGetDetails)
  const assignment = await frame.locator("body").evaluate((body) => {
    const tables = body.querySelectorAll("table");
    for (const table of Array.from(tables)) {
      for (const row of Array.from(table.rows)) {
        const cells = Array.from(row.cells);
        if (cells.length >= 12) {
          const buCell = cells[3]?.textContent?.trim() ?? "";
          const deptCell = cells[6]?.textContent?.trim() ?? "";
          if (/^[A-Z]{4,5}\d?$/.test(buCell) && deptCell && deptCell !== "Department Description") {
            return {
              emplRecord: cells[0]?.textContent?.trim() ?? "",
              hrStatus: cells[2]?.textContent?.trim() ?? "",
              businessUnit: buCell,
              positionNumber: cells[4]?.textContent?.trim() ?? "",
              deptId: cells[5]?.textContent?.trim() ?? "",
              department: deptCell,
              jobCode: cells[7]?.textContent?.trim() ?? "",
              jobCodeDescription: cells[8]?.textContent?.trim() ?? "",
              fte: cells[10]?.textContent?.trim() ?? "",
              emplClass: cells[11]?.textContent?.trim() ?? "",
            };
          }
        }
      }
    }
    return null;
  }).catch(() => null);

  const endDate = termDate || "Active";
  const nameParts = fullName?.split(" ") ?? [];
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

  log.step(`  Name: ${fullName} | Start: ${startDate} | End: ${endDate}`);
  if (assignment) {
    log.step(`  Dept: ${assignment.department} | BU: ${assignment.businessUnit} | Job: ${assignment.jobCodeDescription}`);
  }

  return {
    emplId,
    emplRecord: assignment?.emplRecord ?? "0",
    hrStatus: assignment?.hrStatus ?? (termDate ? "Inactive" : "Active"),
    businessUnit: assignment?.businessUnit ?? "SDCMP",
    jobCode: assignment?.jobCode ?? "",
    jobCodeDescription: assignment?.jobCodeDescription ?? "",
    lastName,
    name: fullName ?? "",
    department: assignment?.department,
    deptId: assignment?.deptId,
    positionNumber: assignment?.positionNumber,
    effectiveDate: startDate,
    expectedEndDate: endDate,
    fte: assignment?.fte,
    emplClass: assignment?.emplClass,
  };
}

/**
 * Extract results from the PeopleSoft search results grid.
 * Clicks "View All" if available to load all rows at once.
 *
 * IMPORTANT: Also checks for the single-result case where PeopleSoft skips the
 * grid and goes directly to the detail page (verified via playwright-cli v1.2).
 */
async function extractResults(page: Page, frame: FrameLocator): Promise<EidResult[]> {
  // Check if there are any results (look for "Nothing yet" or result count)
  const nothingYet = await frame.getByText("Nothing yet").count().catch(() => 0);
  if (nothingYet > 0) {
    log.step("No results found");
    return [];
  }

  // Check for "Your search returned no results" or similar
  const noResults = await frame.getByText("No matching values were found").count().catch(() => 0);
  if (noResults > 0) {
    log.step("No matching values found");
    return [];
  }

  // Check for single-result detail page (PeopleSoft skips grid when exactly 1 match)
  const singleResult = await extractSingleResultDetail(frame);
  if (singleResult) {
    return [singleResult];
  }

  // Click "View All" if present to load all rows
  try {
    const viewAll = frame.getByRole("link", { name: "View All" });
    if (await viewAll.count() > 0) {
      log.step("Clicking View All to load all results...");
      await viewAll.click({ timeout: 10_000 });
      await page.waitForTimeout(3_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await waitForPeopleSoftProcessing(frame);
    }
  } catch {
    // View All not present or already showing all
  }

  // Check if results table exists before extracting
  const tableLocator = frame.locator("table[id='tdgbrPTS_CFG_CL_STD_RSL$0']");
  const tableCount = await tableLocator.count().catch(() => 0);
  if (tableCount === 0) {
    log.step("No results found (no results table)");
    return [];
  }

  // Extract table rows via evaluate on the results grid table
  // Each data row has 9 cells: Empl ID, Empl Record, HR Status, Business Unit, Job Code, Job Code Desc, Last Name, Name, Drill in
  // SELECTOR: verified v1.1 — table#tdgbrPTS_CFG_CL_STD_RSL$0 (no class, PeopleSoft configurable search results grid)
  const rawResults = await tableLocator.evaluate((table: HTMLTableElement) => {
    const data: Array<{
      emplId: string;
      emplRecord: string;
      hrStatus: string;
      businessUnit: string;
      jobCode: string;
      jobCodeDescription: string;
      lastName: string;
      name: string;
      rowIndex: number;
    }> = [];

    let rowIndex = 0;
    for (const row of Array.from(table.rows)) {
      const cells = Array.from(row.cells);
      // Data rows have 9 cells; first cell is Empl ID (5+ digit number)
      if (cells.length >= 8) {
        const emplId = cells[0]?.textContent?.trim() ?? "";
        if (/^\d{5,}$/.test(emplId)) {
          data.push({
            emplId,
            emplRecord: cells[1]?.textContent?.trim() ?? "",
            hrStatus: cells[2]?.textContent?.trim() ?? "",
            businessUnit: cells[3]?.textContent?.trim() ?? "",
            jobCode: cells[4]?.textContent?.trim() ?? "",
            jobCodeDescription: cells[5]?.textContent?.trim() ?? "",
            lastName: cells[6]?.textContent?.trim() ?? "",
            name: cells[7]?.textContent?.trim() ?? "",
            rowIndex,
          });
          rowIndex++;
        }
      }
    }
    return data;
  });
  const results: EidResult[] = rawResults;

  log.step(`Extracted ${results.length} result rows`);
  return results;
}

/**
 * Clear the search form for a new search.
 * If the form is unresponsive (PeopleSoft stale after failed searches),
 * re-navigates to Person Org Summary and returns the fresh frame.
 */
async function clearSearch(page: Page, frame: FrameLocator): Promise<FrameLocator> {
  // Click Clear button
  try {
    await frame.getByRole("button", { name: "Clear", exact: true }).click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return frame;
  } catch {
    // Clear button may not be available; try filling empty values
    try {
      await frame.getByRole("textbox", { name: "Last Name" }).fill("", { timeout: 5_000 });
      await frame.getByRole("textbox", { name: "Name", exact: true }).fill("", { timeout: 5_000 });
      return frame;
    } catch {
      // Form is stale — re-navigate to get a fresh page
      log.step("Form unresponsive, re-navigating to Person Org Summary...");
      return navigateToPersonOrgSummary(page);
    }
  }
}

/** Department keywords to match for Housing/Dining/Hospitality */
const HDH_KEYWORDS = ["housing", "dining", "hospitality", "hdh"];

/** Details extracted from the drill-in detail page. */
interface DrillInDetails {
  department: string;
  deptId: string;
  positionNumber: string;
  startDate: string;
  endDate: string;
  fte: string;
  emplClass: string;
}

/**
 * Drill into a search result row and extract details from the detail page.
 *
 * SELECTOR IDs (verified via playwright-cli v1.1):
 * - Drill in button: img#PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}
 * - ORG Instance section:
 *   - Start Date: #PER_INST_EMP_VW_LAST_HIRE_DT$0 (Last Hire date)
 *   - End Date: #PER_INST_EMP_VW_TERMINATION_DT$0 (Termination Date, empty = Active)
 * - Assignments table columns (0-indexed):
 *   0: Empl Record, 1: EFFDT, 2: HR Status, 3: Business Unit, 4: Position Number,
 *   5: Dept ID, 6: Department Description, 7: Job Code, 8: Description,
 *   9: Expected Job End Date, 10: FTE, 11: Empl Class
 * - Return to Search button: role button "Return to Search"
 */
async function drillInAndGetDetails(
  page: Page,
  frame: FrameLocator,
  rowIndex: number,
): Promise<DrillInDetails | null> {
  const drillInId = `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG$${rowIndex}`;
  log.step(`Drilling into row ${rowIndex}...`);
  await frame.locator(`[id="${drillInId}"]`).click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);

  // Extract dates from ORG Instance section (above the Assignments table)
  const startDate = await frame.locator("#PER_INST_EMP_VW_LAST_HIRE_DT\\$0")
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");
  const termDate = await frame.locator("#PER_INST_EMP_VW_TERMINATION_DT\\$0")
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");

  // Extract assignment details from the Assignments grid.
  // Scan all tables for rows with 10+ cells where cell[3] is a business unit code.
  const assignment = await frame.locator("body").evaluate((body) => {
    const tables = body.querySelectorAll("table");
    for (const table of Array.from(tables)) {
      for (const row of Array.from(table.rows)) {
        const cells = Array.from(row.cells);
        if (cells.length >= 12) {
          const buCell = cells[3]?.textContent?.trim() ?? "";
          const deptCell = cells[6]?.textContent?.trim() ?? "";
          if (/^[A-Z]{4,5}\d?$/.test(buCell) && deptCell && deptCell !== "Department Description") {
            return {
              positionNumber: cells[4]?.textContent?.trim() ?? "",
              deptId: cells[5]?.textContent?.trim() ?? "",
              department: deptCell,
              fte: cells[10]?.textContent?.trim() ?? "",
              emplClass: cells[11]?.textContent?.trim() ?? "",
            };
          }
        }
      }
    }
    return null;
  }).catch(() => null);

  if (assignment) {
    const endDate = termDate || "Active";
    log.step(`  Department: ${assignment.department} | Start: ${startDate} | End: ${endDate}`);
    return {
      ...assignment,
      startDate,
      endDate,
    };
  }
  log.step(`  Could not extract assignment details`);
  return null;
}

/**
 * Click "Return to Search" to go back to search results.
 * Re-clicks "View All" if results are paginated (row index > 9).
 */
async function returnToSearch(page: Page, frame: FrameLocator, needsViewAll: boolean): Promise<void> {
  await frame.getByRole("button", { name: "Return to Search" }).click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);

  // After returning, results may be paginated again — re-click View All if needed
  if (needsViewAll) {
    try {
      const viewAll = frame.getByRole("link", { name: "View All" });
      if (await viewAll.count() > 0) {
        log.step("Re-clicking View All after return...");
        await viewAll.click({ timeout: 10_000 });
        await page.waitForTimeout(3_000);
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await waitForPeopleSoftProcessing(frame);
      }
    } catch {
      // View All may not be present
    }
  }
}

/**
 * For each SDCMP result, drill in and check if department matches Housing/Dining/Hospitality.
 */
async function checkDepartments(
  page: Page,
  frame: FrameLocator,
  sdcmpResults: EidResult[],
): Promise<EidResult[]> {
  const hdhResults: EidResult[] = [];
  // If any row index >= 10, we'll need View All after returning
  const maxRowIndex = Math.max(...sdcmpResults.map((r) => r.rowIndex ?? 0));
  const needsViewAll = maxRowIndex >= 10;

  for (let i = 0; i < sdcmpResults.length; i++) {
    const result = sdcmpResults[i];

    // Single-result detail pages already have department populated — skip drill-in
    if (result.department) {
      const deptLower = result.department.toLowerCase();
      const isHDH = HDH_KEYWORDS.some((kw) => deptLower.includes(kw));
      if (isHDH) {
        log.success(`  ✓ HDH match: EID ${result.emplId} — ${result.department}`);
        hdhResults.push(result);
      } else {
        log.step(`  ✗ Not HDH: EID ${result.emplId} — ${result.department}`);
      }
      continue;
    }

    if (result.rowIndex === undefined) continue;

    const details = await drillInAndGetDetails(page, frame, result.rowIndex);
    if (details) {
      result.department = details.department;
      result.deptId = details.deptId;
      result.positionNumber = details.positionNumber;
      result.effectiveDate = details.startDate;
      result.expectedEndDate = details.endDate;
      result.fte = details.fte;
      result.emplClass = details.emplClass;

      const deptLower = details.department.toLowerCase();
      const isHDH = HDH_KEYWORDS.some((kw) => deptLower.includes(kw));
      if (isHDH) {
        log.success(`  ✓ HDH match: EID ${result.emplId} — ${details.department}`);
        hdhResults.push(result);
      } else {
        log.step(`  ✗ Not HDH: EID ${result.emplId} — ${details.department}`);
      }
    }

    // Only return to search if there are more results to check
    if (i < sdcmpResults.length - 1) {
      await returnToSearch(page, frame, needsViewAll);
    }
  }

  return hdhResults;
}

/**
 * Run a single name search and return results.
 */
async function searchOnce(
  page: Page,
  frame: FrameLocator,
  lastName: string,
  name: string,
): Promise<EidSearchResult> {
  await executeSearch(page, frame, lastName, name);
  const results = await extractResults(page, frame);
  const sdcmpResults = results.filter((r) => r.businessUnit === "SDCMP");

  if (sdcmpResults.length > 0) {
    log.success(`Found ${sdcmpResults.length} SDCMP result(s) for "${lastName}, ${name}"`);
  } else if (results.length > 0) {
    log.step(`Found ${results.length} result(s) but none for SDCMP`);
  }

  return {
    query: { lastName, name },
    results,
    sdcmpResults,
  };
}

/**
 * Search for an employee by name using multiple strategies.
 *
 * Input format: "Last, First Middle" (e.g. "Smith, John Michael")
 *
 * Strategy:
 *   1. Last Name = "Smith", Name = "John Michael" (full first + middle)
 *   2. Last Name = "Smith", Name = "John" (first only, no middle)
 *   3. Last Name = "Smith", Name = "Michael" (middle only, as fallback)
 *
 * Stops at first strategy that yields SDCMP results. If none do, returns
 * all results from all attempts.
 *
 * @param page - Playwright page (already authenticated to UCPath)
 * @param nameInput - Name in "Last, First Middle" format
 */
export async function searchByName(
  page: Page,
  nameInput: string,
): Promise<{
  found: boolean;
  sdcmpResults: EidResult[];
  hdhResults: EidResult[];
  allAttempts: EidSearchResult[];
}> {
  const { lastName, first, middle } = parseNameInput(nameInput);
  const allAttempts: EidSearchResult[] = [];
  let sdcmpResults: EidResult[] = [];

  // Navigate to Person Org Summary
  let frame = await navigateToPersonOrgSummary(page);

  // Strategy 1: Full name — "First Middle"
  const fullName = middle ? `${first} ${middle}` : first;
  const attempt1 = await searchOnce(page, frame, lastName, fullName);
  allAttempts.push(attempt1);

  if (attempt1.sdcmpResults.length > 0) {
    sdcmpResults = attempt1.sdcmpResults;
  }

  // Strategy 2: First name only (drop middle) — only if we had a middle and no SDCMP yet
  if (middle && sdcmpResults.length === 0) {
    // Always re-navigate fresh — PeopleSoft forms break after "No matching values" popups
    frame = await navigateToPersonOrgSummary(page);
    const attempt2 = await searchOnce(page, frame, lastName, first);
    allAttempts.push(attempt2);

    if (attempt2.sdcmpResults.length > 0) {
      sdcmpResults = attempt2.sdcmpResults;
    } else {
      // Strategy 3: Middle name as first name
      frame = await navigateToPersonOrgSummary(page);
      const attempt3 = await searchOnce(page, frame, lastName, middle);
      allAttempts.push(attempt3);

      if (attempt3.sdcmpResults.length > 0) {
        sdcmpResults = attempt3.sdcmpResults;
      }
    }
  }

  // If we found SDCMP results, drill into each to check department
  let hdhResults: EidResult[] = [];
  if (sdcmpResults.length > 0) {
    log.step(`Checking ${sdcmpResults.length} SDCMP result(s) for Housing/Dining/Hospitality...`);
    hdhResults = await checkDepartments(page, frame, sdcmpResults);
  }

  return {
    found: sdcmpResults.length > 0,
    sdcmpResults,
    hdhResults,
    allAttempts,
  };
}
