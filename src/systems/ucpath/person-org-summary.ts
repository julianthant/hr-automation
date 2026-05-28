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
 *   4. Multi-token Last Name = "A B": also try Last="A" and Last="B" with Name=First
 *
 * We intentionally do not search arbitrary name tokens as Last Name with a blank
 * Name field — that matches unrelated people who share only a token (e.g. a
 * middle name that matches someone else's surname).
 *
 * All selectors verified via playwright-cli v1.0 against live UCPath.
 */

import type { Page, FrameLocator } from "playwright";
import { isAcceptedHdhDepartment } from "../../domain/hdh/departments.js";
import { displayPersonName, parseLastFirstName } from "../../domain/identity/person-name.js";
import { log } from "../../utils/log.js";
import { collapseSidebar, getContentFrame, waitForPeopleSoftProcessing } from "./navigate.js";
import { hrTasks, personOrgSummary } from "./selectors.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";

/** Direct URL to Person Org Summary — opens in the HR Tasks iframe. */
const PERSON_ORG_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

/**
 * UI labels rendered as 2-word leaf spans on older Person Org Summary detail
 * pages. Kept only as a fallback behind the registry selector.
 */
export const PERSON_ORG_NAME_LABELS: readonly string[] = [
  "Search Criteria", "Recent Searches", "Saved Searches", "Employment Instances",
  "Person Organizational Summary", "Return to Search", "Show fewer options",
  "Navigation Area",
  "Person ID", "Benefit Eligibility", "Limited Hours", "Floater Hours",
  "HR Status", "Payroll Status", "Last Hire", "Termination Date",
  "ORG Instance", "Primary Job", "Empl Record", "Position Number",
  "Dept ID", "Department Description", "Job Code", "Expected Job",
  "Empl Class", "Pay Group", "Employee Type", "Probation Code",
  "Probation End", "Union Code", "FLSA Status", "Business Unit",
  // PeopleSoft transient status strings — observed leaking through on a
  // first-of-session run when the page hadn't finished settling.
  "Loading Complete", "Page Loading",
];

/**
 * Pick the employee's full name from a list of candidate leaf-text strings
 * collected from the Person Org Summary detail page. Returns the first
 * candidate that:
 *   - matches the "Word Word…" shape (2+ alpha words separated by whitespace),
 *   - is shorter than 60 characters,
 *   - contains no digits, and
 *   - is not a known UI label.
 *
 * Whitespace is collapsed (so non-breaking spaces match regular spaces) and
 * label comparison is case-insensitive.
 */
export function selectPersonName(
  candidates: readonly string[],
  labels: readonly string[] = PERSON_ORG_NAME_LABELS,
): string | null {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  for (const raw of candidates) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.length >= 60) continue;
    if (!/^[A-Za-z]+\s+[A-Za-z]+/.test(text)) continue;
    if (/\d/.test(text)) continue;
    const lower = text.toLowerCase();
    if (lowerLabels.some((label) => lower.includes(label))) continue;
    return text;
  }
  return null;
}

async function readPersonNameFromDetail(frame: FrameLocator): Promise<string | null> {
  const selected = await personOrgSummary.personNameValue(frame)
    .first()
    .textContent({ timeout: 3_000 })
    .then((text) => selectPersonName([text ?? ""]))
    .catch(() => null);
  if (selected) return selected;

  const candidates = await personOrgSummary.body(frame).evaluate((body) => {
    const out: string[] = [];
    const els = body.querySelectorAll("span, div");
    for (const el of Array.from(els)) {
      if (el.children.length !== 0) continue;
      const text = el.textContent?.trim() ?? "";
      if (text.length === 0 || text.length >= 60) continue;
      out.push(text);
    }
    return out;
  }).catch(() => [] as string[]);
  return selectPersonName(candidates, PERSON_ORG_NAME_LABELS);
}

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
  terminationDate?: string;
  expectedJobEndDate?: string;
  fte?: string;
  emplClass?: string;
  rowIndex?: number;
}

export interface EidSearchResult {
  query: { lastName: string; name: string };
  results: EidResult[];
  sdcmpResults: EidResult[];
}

export interface PersonOrgNameSearchAttempt {
  lastName: string;
  name: string;
}

/**
 * Parse "Last, First Middle" input format into name parts.
 */
export function parsePersonOrgNameInput(input: string): {
  lastName: string;
  first: string;
  middle: string | null;
} {
  const parsed = parseLastFirstName(displayPersonName(input));
  if (!parsed) {
    throw new Error(`Invalid name format: "${input}". Expected "Last, First Middle" or "Last, First".`);
  }
  return {
    lastName: parsed.lastName,
    first: parsed.firstName,
    middle: parsed.middleName,
  };
}

export interface PersonOrgAssignmentDetails {
  emplRecord: string;
  effectiveDate: string;
  hrStatus: string;
  businessUnit: string;
  positionNumber: string;
  deptId: string;
  department: string;
  jobCode: string;
  jobCodeDescription: string;
  expectedJobEndDate: string;
  fte: string;
  emplClass: string;
}

export function buildPersonOrgNameSearchAttempts(input: {
  lastName: string;
  first: string;
  middle: string | null;
}): PersonOrgNameSearchAttempt[] {
  const attempts: PersonOrgNameSearchAttempt[] = [];
  const seen = new Set<string>();
  const add = (lastName: string, name: string): void => {
    const normalizedLast = lastName.trim();
    const normalizedName = name.trim();
    if (!normalizedLast) return;
    const key = `${normalizedLast.toLowerCase()}\u0000${normalizedName.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ lastName: normalizedLast, name: normalizedName });
  };

  const fullName = input.middle ? `${input.first} ${input.middle}` : input.first;
  add(input.lastName, fullName);
  if (input.middle) {
    add(input.lastName, input.first);
    add(input.lastName, input.middle);
  }

  const lastTokens = input.lastName.split(/\s+/).filter(Boolean);
  if (lastTokens.length > 1) {
    for (const token of lastTokens) add(token, input.first);
  }

  return attempts;
}

export function deriveAssignmentDetailsFromCells(cells: string[]): PersonOrgAssignmentDetails | null {
  if (cells.length < 12) return null;
  const values = cells.map((cell) => cell.trim());
  const businessUnit = values[3] ?? "";
  const department = values[6] ?? "";
  if (!/^[A-Z]{4,5}\d?$/.test(businessUnit)) return null;
  if (!department || department === "Department Description") return null;
  return {
    emplRecord: values[0] ?? "",
    effectiveDate: values[1] ?? "",
    hrStatus: values[2] ?? "",
    businessUnit,
    positionNumber: values[4] ?? "",
    deptId: values[5] ?? "",
    department,
    jobCode: values[7] ?? "",
    jobCodeDescription: values[8] ?? "",
    expectedJobEndDate: values[9] ?? "",
    fte: values[10] ?? "",
    emplClass: values[11] ?? "",
  };
}

function isInactiveHrStatus(status: string | undefined): boolean {
  return /inactive|terminated|separated/i.test(status ?? "");
}

function comparePreferredAssignment(
  a: PersonOrgAssignmentDetails,
  b: PersonOrgAssignmentDetails,
): number {
  const aActive = !isInactiveHrStatus(a.hrStatus);
  const bActive = !isInactiveHrStatus(b.hrStatus);
  if (aActive !== bActive) return aActive ? -1 : 1;

  const aHdh = isAcceptedHdhDepartment(a.department);
  const bHdh = isAcceptedHdhDepartment(b.department);
  if (aHdh !== bHdh) return aHdh ? -1 : 1;

  const aRecord = Number.parseInt(a.emplRecord, 10);
  const bRecord = Number.parseInt(b.emplRecord, 10);
  if (Number.isFinite(aRecord) && Number.isFinite(bRecord) && aRecord !== bRecord) {
    return bRecord - aRecord;
  }
  return 0;
}

export function selectPreferredAssignmentDetails(
  assignments: readonly PersonOrgAssignmentDetails[],
): PersonOrgAssignmentDetails | null {
  if (assignments.length === 0) return null;
  return [...assignments].sort(comparePreferredAssignment)[0] ?? null;
}

async function extractAssignmentRowsFromBody(frame: FrameLocator): Promise<string[][]> {
  return personOrgSummary.body(frame).evaluate((body) => {
    const out: string[][] = [];
    const tables = body.querySelectorAll("table");
    for (const table of Array.from(tables)) {
      for (const row of Array.from(table.rows)) {
        const cells = Array.from(row.cells);
        if (cells.length >= 12) {
          const buCell = cells[3]?.textContent?.trim() ?? "";
          const deptCell = cells[6]?.textContent?.trim() ?? "";
          if (/^[A-Z]{4,5}\d?$/.test(buCell) && deptCell && deptCell !== "Department Description") {
            out.push(cells.map((cell) => cell.textContent?.trim() ?? ""));
          }
        }
      }
    }
    return out;
  }).catch(() => []);
}

async function extractPreferredAssignmentFromBody(frame: FrameLocator): Promise<PersonOrgAssignmentDetails | null> {
  const rows = await extractAssignmentRowsFromBody(frame);
  const assignments = rows
    .map((cells) => deriveAssignmentDetailsFromCells(cells))
    .filter((assignment): assignment is PersonOrgAssignmentDetails => assignment !== null);
  return selectPreferredAssignmentDetails(assignments);
}

async function clickEmploymentInstancesViewAllIfPresent(page: Page, frame: FrameLocator): Promise<void> {
  const before = await extractAssignmentRowsFromBody(frame);
  try {
    const viewAll = personOrgSummary.viewAllLink(frame);
    if (await clickIfPresent(viewAll, {
      timeout: 3_000,
      label: "ucpath person org employment instances view all link",
    })) {
      log.step("Clicked View All to load all employment instances...");
      await page.waitForTimeout(3_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await waitForPeopleSoftProcessing(frame);
    }
  } catch {
    // Detail page may already show all employment instances.
  }

  const after = await extractAssignmentRowsFromBody(frame);
  if (after.length > before.length) {
    log.step(`Employment Instances expanded from ${before.length} to ${after.length} assignment row(s)`);
  }
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
  const posLink = hrTasks.personOrgSummaryLink(page);
  await safeClick(posLink, {
    timeout: 10_000,
    label: "ucpath person org summary sidebar link",
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  log.step("Person Org Summary page loaded");

  // Collapse sidebar to avoid click interception on iframe buttons.
  await collapseSidebar(page, { onlyIfExpanded: true, quiet: true });

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
  await safeFill(personOrgSummary.lastNameInput(frame), lastName, {
    timeout: 10_000,
    label: "ucpath person org last name",
  });

  // Fill Name (first/middle)
  await safeFill(personOrgSummary.nameInput(frame), name, {
    timeout: 10_000,
    label: "ucpath person org name",
  });

  // Click Search
  await safeClick(personOrgSummary.searchButton(frame), {
    timeout: 10_000,
    label: "ucpath person org search button",
  });
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
  page: Page,
  frame: FrameLocator,
): Promise<EidResult | null> {
  // Check if the detail page is showing (person ID field is present)
  const personIdLocator = personOrgSummary.personIdValue(frame);
  const hasDetail = await personIdLocator.count().catch(() => 0);
  if (hasDetail === 0) return null;

  // Prefer the registry personIdValue locator; fall back to body scan for legacy renderings.
  let emplId = (await personIdLocator.first().textContent())?.trim() ?? "";
  if (!/^10\d{6}$/.test(emplId)) {
    emplId =
      (await personOrgSummary
        .body(frame)
        .evaluate((body) => {
          const allElements = body.querySelectorAll("span, div");
          for (const el of Array.from(allElements)) {
            const text = el.textContent?.trim() ?? "";
            if (/^10\d{6}$/.test(text) && el.children.length === 0) {
              return text;
            }
          }
          return null;
        })
        .catch(() => null)) ?? "";
  }

  if (!emplId) return null;

  log.success(`Single-result detail page detected — EID: ${emplId}`);
  await clickEmploymentInstancesViewAllIfPresent(page, frame);

  // Extract dates from ORG Instance section
  const startDate = await personOrgSummary.lastHireDate(frame)
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");
  const termDate = await personOrgSummary.terminationDate(frame)
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");

  const fullName = await readPersonNameFromDetail(frame);

  // Extract assignment details (same logic as drillInAndGetDetails)
  const assignment = await extractPreferredAssignmentFromBody(frame);

  const selectedTermDate = assignment && !isInactiveHrStatus(assignment.hrStatus) ? "" : termDate;
  const selectedStartDate = assignment?.effectiveDate || startDate;
  const endDate = selectedTermDate || "Active";
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
    effectiveDate: selectedStartDate,
    terminationDate: selectedTermDate,
    expectedJobEndDate: assignment?.expectedJobEndDate,
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
  const nothingYet = await personOrgSummary.nothingYetText(frame).count().catch(() => 0);
  if (nothingYet > 0) {
    log.step("No results found");
    return [];
  }

  // Check for "Your search returned no results" or similar
  const noResults = await personOrgSummary.noMatchingValuesText(frame).count().catch(() => 0);
  if (noResults > 0) {
    log.step("No matching values found");
    return [];
  }

  // Check for single-result detail page (PeopleSoft skips grid when exactly 1 match)
  const singleResult = await extractSingleResultDetail(page, frame);
  if (singleResult) {
    log.step("Single result detected — PeopleSoft redirected directly to detail page");
    return [singleResult];
  }

  // Click "View All" if present to load all rows
  try {
    const viewAll = personOrgSummary.viewAllLink(frame);
    if (await clickIfPresent(viewAll, {
      timeout: 10_000,
      label: "ucpath person org view all link",
    })) {
      log.step("Clicked View All to load all results...");
      await page.waitForTimeout(3_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await waitForPeopleSoftProcessing(frame);
    }
  } catch {
    // View All not present or already showing all
  }

  // Check if results table exists before extracting
  const tableLocator = personOrgSummary.resultsTable(frame);
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

/** Details extracted from the drill-in detail page. */
interface DrillInDetails {
  emplRecord: string;
  hrStatus: string;
  businessUnit: string;
  department: string;
  deptId: string;
  positionNumber: string;
  jobCode: string;
  jobCodeDescription: string;
  startDate: string;
  terminationDate: string;
  expectedJobEndDate: string;
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
  log.step(`Drilling into row ${rowIndex}...`);
  await safeClick(personOrgSummary.drillInButton(frame, rowIndex), {
    timeout: 10_000,
    label: "ucpath person org drill-in button",
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);
  await clickEmploymentInstancesViewAllIfPresent(page, frame);

  // Extract dates from ORG Instance section (above the Assignments table)
  const startDate = await personOrgSummary.lastHireDate(frame)
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");
  const termDate = await personOrgSummary.terminationDate(frame)
    .textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? "").catch(() => "");

  // Extract assignment details from the Assignments grid.
  // Scan all tables for rows with 10+ cells where cell[3] is a business unit code.
  const assignment = await extractPreferredAssignmentFromBody(frame);

  if (assignment) {
    const selectedTermDate = !isInactiveHrStatus(assignment.hrStatus) ? "" : termDate;
    const selectedStartDate = assignment.effectiveDate || startDate;
    const endDate = selectedTermDate || "Active";
    log.step(`  Department: ${assignment.department} | Start: ${selectedStartDate} | End: ${endDate}`);
    return {
      ...assignment,
      startDate: selectedStartDate,
      terminationDate: selectedTermDate,
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
  await safeClick(personOrgSummary.returnToSearchButton(frame), {
    timeout: 10_000,
    label: "ucpath person org return to search button",
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);

  // After returning, results may be paginated again — re-click View All if needed
  if (needsViewAll) {
    try {
      const viewAll = personOrgSummary.viewAllLink(frame);
      if (await clickIfPresent(viewAll, {
        timeout: 10_000,
        label: "ucpath person org view all after return link",
      })) {
        log.step("Re-clicked View All after return...");
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
 * For each SDCMP result, drill in and populate department details.
 * Returns all results with departments populated (not just HDH).
 */
async function populateDepartments(
  page: Page,
  frame: FrameLocator,
  sdcmpResults: EidResult[],
): Promise<void> {
  // If any row index >= 10, we'll need View All after returning
  const maxRowIndex = Math.max(...sdcmpResults.map((r) => r.rowIndex ?? 0));
  const needsViewAll = maxRowIndex >= 10;

  for (let i = 0; i < sdcmpResults.length; i++) {
    const result = sdcmpResults[i];

    // Single-result detail pages already have department populated — skip drill-in
    if (result.department) {
      log.step(`  EID ${result.emplId} — ${result.department} (${result.terminationDate || "Active"})`);
      continue;
    }

    if (result.rowIndex === undefined) continue;

    const details = await drillInAndGetDetails(page, frame, result.rowIndex);
    if (details) {
      result.department = details.department;
      result.deptId = details.deptId;
      result.positionNumber = details.positionNumber;
      result.effectiveDate = details.startDate;
      result.terminationDate = details.terminationDate;
      result.expectedJobEndDate = details.expectedJobEndDate;
      result.fte = details.fte;
      result.emplClass = details.emplClass;

      log.step(`  EID ${result.emplId} — ${details.department} (${details.terminationDate || "Active"})`);
    }

    // Only return to search if there are more results to check
    if (i < sdcmpResults.length - 1) {
      await returnToSearch(page, frame, needsViewAll);
    }
  }
}

/**
 * Run a single name search and return results.
 *
 * Two-stage filter:
 *   1. BU filter (synchronous) — keeps only SDCMP business-unit rows so we
 *      only spend drill-in time on San Diego candidates.
 *   2. Dept filter (applied later in `searchByName` after `populateDepartments`
 *      fills in dept names) — final HDH acceptance.
 *
 * `sdcmpResults` here is the *candidate* set (BU=SDCMP, dept not yet known);
 * `searchByName` narrows it to HDH-accepted rows before returning.
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

  log.step(`Search: "${lastName}, ${name}" returned ${results.length} total → ${sdcmpResults.length} SDCMP candidate(s) (HDH dept filter applied post-drill-in)`);

  if (sdcmpResults.length > 0) {
    log.success(`Found ${sdcmpResults.length} SDCMP candidate(s) for "${lastName}, ${name}"`);
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
  options: {
    keepNonHdh?: boolean;
    onAfterSearchAttempt?: (attempt: EidSearchResult) => Promise<void>;
  } = {},
): Promise<{
  found: boolean;
  sdcmpResults: EidResult[];
  allAttempts: EidSearchResult[];
}> {
  const { lastName, first, middle } = parsePersonOrgNameInput(nameInput);
  const allAttempts: EidSearchResult[] = [];
  let sdcmpResults: EidResult[] = [];

  // Navigate to Person Org Summary
  let frame = await navigateToPersonOrgSummary(page);

  const attempts = buildPersonOrgNameSearchAttempts({ lastName, first, middle });
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (i > 0) {
      log.step(`Search fallback ${i + 1}/${attempts.length}: trying "${attempt.lastName}, ${attempt.name}"`);
      // Always re-navigate fresh — PeopleSoft forms break after "No matching values" popups.
      frame = await navigateToPersonOrgSummary(page);
    }
    const result = await searchOnce(page, frame, attempt.lastName, attempt.name);
    allAttempts.push(result);
    await options.onAfterSearchAttempt?.(result);
    if (result.sdcmpResults.length > 0) {
      sdcmpResults = result.sdcmpResults;
      break;
    }
  }

  // If we found SDCMP candidates, drill into each to populate department
  // details, then apply the HDH dept whitelist. SDCMP is a coarse BU filter;
  // the final "accepted" bit is department-level (see `isAcceptedDept`).
  //
  // When `options.keepNonHdh` is true (prep-flow verification path), we
  // KEEP non-HDH results so the orchestrator can flag them as "non-hdh"
  // for the operator to review. CLI invocations leave the flag off and
  // the existing rejection behavior applies.
  let returnedResults: EidResult[] = [];
  if (sdcmpResults.length > 0) {
    log.step(`Drilling into ${sdcmpResults.length} SDCMP candidate(s) for department details...`);
    await populateDepartments(page, frame, sdcmpResults);
    if (options.keepNonHdh) {
      returnedResults = sdcmpResults;
      log.step(
        `keepNonHdh: returning all ${sdcmpResults.length} SDCMP candidate(s) (HDH filter bypassed for verification)`,
      );
    } else {
      returnedResults = sdcmpResults.filter((r) => isAcceptedHdhDepartment(r.department));
      const rejected = sdcmpResults.filter((r) => !isAcceptedHdhDepartment(r.department));
      if (rejected.length > 0) {
        const summary = rejected
          .map((r) => `EID ${r.emplId} (${r.department ?? "<no dept>"})`)
          .join(", ");
        log.step(`Filtered out ${rejected.length} non-HDH SDCMP result(s): ${summary}`);
      }
      if (returnedResults.length > 0) {
        log.success(`${returnedResults.length} HDH-accepted result(s) after dept filter`);
      } else {
        log.step(`0 HDH-accepted result(s) — all ${sdcmpResults.length} SDCMP candidate(s) rejected by dept filter`);
      }
    }
  }

  return {
    found: returnedResults.length > 0,
    sdcmpResults: returnedResults,
    allAttempts,
  };
}

/**
 * Search Person Organizational Summary by Empl ID. Single-result navigation:
 * PeopleSoft jumps straight to the detail page when EID search returns one
 * match (which is the common case — EIDs are unique).
 *
 * Returns the same EidResult shape as searchByName, populated from the
 * detail page. Returns null if the detail page didn't render (no record,
 * stale form, or selector miss).
 *
 * Unlike searchByName, this function does NOT apply the HDH dept filter —
 * the prep-flow verification path needs the raw result so it can surface
 * non-HDH employees as flagged-but-visible. Callers that want the HDH
 * filter (none today, since EID-input is prep-flow-only) can apply
 * `isAcceptedDept(result.department)` themselves.
 */
export async function searchByEid(
  page: Page,
  emplId: string,
): Promise<EidResult | null> {
  log.step(`Person Org Summary search by EID: ${emplId}`);
  const frame = await navigateToPersonOrgSummary(page);

  // Clear the name fields (search form often retains values across iterations)
  // and fill the Empl ID textbox. PeopleSoft's Person Org Summary search form
  // exposes Empl ID alongside Last Name / Name.
  try {
    await safeFill(personOrgSummary.lastNameInput(frame), "", {
      timeout: 5_000,
      label: "ucpath person org clear last name",
    });
  } catch {
    // Form may have re-rendered; carry on.
  }
  try {
    await safeFill(personOrgSummary.nameInput(frame), "", {
      timeout: 5_000,
      label: "ucpath person org clear name",
    });
  } catch {
    /* same */
  }

  const emplIdInput = personOrgSummary.emplIdInput(frame);
  await safeFill(emplIdInput, "", {
    timeout: 10_000,
    label: "ucpath person org clear empl id",
  }).catch(() => {});
  await safeFill(emplIdInput, emplId, {
    timeout: 10_000,
    label: "ucpath person org empl id",
  });

  await safeClick(personOrgSummary.searchButton(frame), {
    timeout: 10_000,
    label: "ucpath person org eid search button",
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await waitForPeopleSoftProcessing(frame);

  // PeopleSoft auto-redirects to the detail page when 1 result. Extract.
  const result = await extractSingleResultDetail(page, frame);
  if (!result) {
    log.warn(`searchByEid: no detail page rendered for EID ${emplId}`);
    return null;
  }
  log.success(`searchByEid: resolved EID ${emplId} → ${result.name}`);
  return { ...result, emplId };
}
