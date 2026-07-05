import type { Page, Frame } from "playwright";
import { join } from "node:path";
import { readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { PATHS } from "../../config.js";
import { tryRegisterDownloadedFile } from "../../tracker/files/register-download.js";
import { reportsPage } from "./selectors.js";
import { clickIfPresent } from "../common/index.js";
import { UKGError } from "./types.js";

/**
 * Try multiple selectors across multiple frames. Returns true if one was clicked.
 */
async function clickInFrames(
  page: Page,
  selectors: string[],
  frames?: Frame[],
): Promise<boolean> {
  const framesToSearch = frames ?? page.frames();
  for (const sel of selectors) {
    for (const f of framesToSearch) {
      try {
        const loc = f.locator(sel);
        if (await clickIfPresent(loc, { label: `old kronos report selector ${sel}` })) {
          log.step(`Clicked '${sel}' in '${f.name()}'`);
          return true;
        }
      } catch {
        // Frame detached or selector invalid
      }
    }
  }
  return false;
}

/**
 * JS fallback: click any element matching exact text in any frame.
 */
async function jsClickText(
  page: Page,
  text: string,
  frames?: Frame[],
): Promise<boolean> {
  const framesToSearch = frames ?? page.frames();
  for (const f of framesToSearch) {
    try {
      const clicked = await f.evaluate((searchText: string) => {
        for (const el of document.querySelectorAll("input, button, a, td, span, div, img")) {
          const t = (
            (el as HTMLInputElement).value ||
            el.textContent ||
            (el as HTMLImageElement).alt ||
            (el as HTMLElement).title ||
            ""
          ).trim();
          if (t === searchText) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, text);
      if (clicked) {
        log.step(`JS clicked '${text}' in '${f.name()}'`);
        return true;
      }
    } catch {
      // Frame detached
    }
  }
  return false;
}

/**
 * Find and click the Run Report button using multiple strategies.
 */
async function clickRunReport(page: Page): Promise<boolean> {
  const contentFrame = page.frame({ name: "khtmlReportingContentIframe" });
  const framesToSearch = [
    ...(contentFrame ? [contentFrame] : []),
    ...page.frames(),
  ];

  if (await clickInFrames(page, [...reportsPage.runReportSelectors], framesToSearch)) return true;
  const clicked = await jsClickText(page, "Run Report", framesToSearch);
  if (!clicked) log.error("Run Report NOT FOUND");
  return clicked;
}

/**
 * Collect TR ids for all report-status rows visible in any frame.
 */
async function collectReportRowIds(page: Page): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const f of page.frames()) {
    try {
      const rowIds = await f.evaluate(() => {
        const result: string[] = [];
        for (const span of document.querySelectorAll('span[id^="statusValue"]')) {
          const tr = span.closest("tr");
          if (tr?.id) result.push(tr.id);
        }
        return result;
      });
      for (const id of rowIds) ids.add(id);
    } catch {
      // Frame detached
    }
  }
  return ids;
}

/**
 * After Run Report: switch to Check Report Status tab,
 * poll for a NEW row (not in existingRowIds), wait for completion, then download.
 */
export async function waitForReportAndDownload(
  page: Page,
  employeeId: string,
  employeeName: string | null,
  reportsDir: string,
  existingRowIds: Set<string>,
): Promise<boolean> {
  log.step(`[${employeeId}] Waiting for report to complete...`);

  // Switch to CHECK REPORT STATUS tab
  if (!(await clickInFrames(page, [...reportsPage.checkStatusSelectors]))) {
    await jsClickText(page, "CHECK REPORT STATUS");
  }

  // Wait 12 seconds for the report to generate
  await page.waitForTimeout(12_000);

  // Poll for a NEW row (not in the pre-run snapshot), then wait until it is Complete.
  let myRowId: string | null = null;
  let statusFrame: Frame | null = null;
  let candidateRowId: string | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await clickInFrames(page, [...reportsPage.refreshStatusSelectors]))) {
      await jsClickText(page, "Refresh Status");
    }
    await page.waitForTimeout(3_000);

    for (const f of page.frames()) {
      try {
        const pollArgs: { existing: string[]; candidate: string | null } = {
          existing: [...existingRowIds],
          candidate: candidateRowId,
        };
        const result: { status: string; trId: string } | null = await f.evaluate(
          ({
            existing,
            candidate,
          }: {
            existing: string[];
            candidate: string | null;
          }): { status: string; trId: string } | null => {
            const spans = document.querySelectorAll('span[id^="statusValue"]');

            if (candidate) {
              for (const span of spans) {
                const tr = span.closest("tr");
                if (tr?.id === candidate) {
                  return {
                    status: span.textContent?.trim() ?? "",
                    trId: tr.id,
                  };
                }
              }
              return null;
            }

            for (const span of spans) {
              const tr = span.closest("tr");
              const trId = tr?.id ?? null;
              if (!trId || existing.includes(trId)) continue;
              return {
                status: span.textContent?.trim() ?? "",
                trId,
              };
            }
            return null;
          },
          pollArgs,
        );

        if (result?.trId) {
          if (!candidateRowId) {
            candidateRowId = result.trId;
            log.step(
              `[${employeeId}] New report row detected: ${candidateRowId} status='${result.status}'`,
            );
          }

          const status = result.status.toLowerCase();
          log.step(
            `[${employeeId}] Attempt ${attempt + 1}: status='${result.status}' tr_id=${result.trId}`,
          );
          log.step(`Report: status "${result.status}" (attempt ${attempt + 1})`);

          if (status === "complete") {
            myRowId = result.trId;
            statusFrame = f;
            log.step(`[${employeeId}] Row ${myRowId} COMPLETE!`);
            break;
          }
          break;
        }
      } catch {
        // Frame detached
      }
    }

    if (myRowId) break;
  }

  if (!myRowId) {
    log.error(`[${employeeId}] Report did not complete after polling`);
    return false;
  }

  if (!statusFrame) {
    log.error(`[${employeeId}] Report completed but status frame was not captured`);
    return false;
  }

  return await downloadReportRow(page, statusFrame, myRowId, employeeId, employeeName, reportsDir);
}

/**
 * Click a specific report row by TR id, then View Report and download.
 */
async function downloadReportRow(
  page: Page,
  statusFrame: Frame,
  rowId: string,
  employeeId: string,
  employeeName: string | null,
  reportsDir: string,
): Promise<boolean> {
  const filename = employeeName
    ? `Time Detail_${employeeName} (${employeeId}).pdf`
    : `Time Detail_${employeeId}.pdf`;
  const dest = join(reportsDir, filename);

  // Click our specific row to select it
  const rowHandle = await statusFrame.evaluateHandle((rid: string) => {
    const tr = document.getElementById(rid);
    return tr ? tr.querySelector("td") ?? tr : null;
  }, rowId);

  const el = rowHandle.asElement();
  if (!el) {
    log.error(`[${employeeId}] Could not get row element for tr#${rowId}`);
    return false;
  }

  await el.click({ force: true });
  await page.waitForTimeout(2_000);
  log.step(`[${employeeId}] Row ${rowId} selected. Clicking View Report...`);

  // Set up download capture
  let downloadCaptured = false;

  const downloadHandler = async (dl: { suggestedFilename: () => string; saveAs: (path: string) => Promise<void> }) => {
    log.step(`[${employeeId}] Download event! ${dl.suggestedFilename()}`);
    await dl.saveAs(dest);
    await registerDownloadedReportPdf(dest, filename, employeeId);
    log.step(`[${employeeId}] SAVED: ${dest}`);
    downloadCaptured = true;
  };

  const newPageHandler = (newPage: Page) => {
    log.step(`[${employeeId}] New tab detected`);
    newPage.on("download", downloadHandler);
  };

  page.on("download", downloadHandler);
  page.context().on("page", newPageHandler);

  // Capture filesystem snapshot BEFORE clicking View Report (for fallback diff)
  const downloadsDir = PATHS.downloadsDir;
  const filesBefore = new Map<string, Set<string>>();
  for (const dir of [downloadsDir, reportsDir]) {
    try {
      filesBefore.set(dir, new Set(await readdir(dir)));
    } catch {
      filesBefore.set(dir, new Set());
    }
  }

  // Click View Report
  if (!(await clickInFrames(page, [...reportsPage.viewReportSelectors]))) {
    await jsClickText(page, "View Report");
  }

  // Wait for download
  for (let i = 0; i < 30; i++) {
    if (downloadCaptured) break;
    await page.waitForTimeout(1_000);
  }

  // Clean up listeners
  try {
    page.removeListener("download", downloadHandler);
    page.context().removeListener("page", newPageHandler);
  } catch {
    // Listeners may already be removed
  }

  if (downloadCaptured) {
    log.step(`Download: captured via Playwright download event`);
    log.step(`PDF: saved as "${filename}" via download event`);
    log.success(`[${employeeId}] Download captured!`);
    // Close extra tabs
    while (page.context().pages().length > 1) {
      try {
        await page.context().pages().at(-1)?.close();
      } catch {
        break;
      }
    }
    return true;
  }

  // Filesystem fallback: diff snapshots to find new PDFs
  log.step(`[${employeeId}] Download event not captured. Checking filesystem...`);
  await page.waitForTimeout(3_000);

  for (const checkDir of [downloadsDir, reportsDir]) {
    try {
      const filesAfter = new Set(await readdir(checkDir));
      const before = filesBefore.get(checkDir) ?? new Set();
      // Find new files by set difference (matches Python approach)
      const newFiles = [...filesAfter].filter((f) => !before.has(f));
      const newPdfs = newFiles.filter(
        (f) => f.endsWith(".pdf") && !f.endsWith(".crdownload") && !f.endsWith(".tmp"),
      );
      if (newPdfs.length > 0) {
        const src = join(checkDir, newPdfs[0]);
        const nameMatch = newPdfs[0] === filename;
        log.step(`PDF: name "${newPdfs[0]}" ${nameMatch ? "matches" : "MISMATCHES"} expected "${filename}"`);
        if (!nameMatch) {
          throw new UKGError(
            `[${employeeId}] Filesystem-fallback download name mismatch in ${checkDir}: found "${newPdfs[0]}" but expected "${filename}" — refusing to register another employee's report under employeeId ${employeeId}`,
            "downloadReportRow",
          );
        }
        log.step(`Download: captured via filesystem fallback (diff in ${checkDir})`);
        if (src !== dest) {
          if (existsSync(dest)) await unlink(dest);
          await rename(src, dest);
        }
        registerDownloadedReportPdf(dest, filename, employeeId);
        log.step(`[${employeeId}] Found file in ${checkDir}: ${newPdfs[0]}`);
        log.success(`[${employeeId}] SAVED: ${dest}`);
        return true;
      }
    } catch {
      // Directory may not exist
    }
  }

  log.error(`[${employeeId}] Could not find downloaded file`);
  return false;
}

function registerDownloadedReportPdf(
  dest: string,
  filename: string,
  employeeId: string,
): void {
  tryRegisterDownloadedFile({
    kind: "kronos-report",
    path: dest,
    originalName: filename,
    workflow: "kronos-reports",
    itemId: employeeId,
  });
}

async function selectWorkspaceDropdown(
  wsFrame: Frame,
  predicate: (option: { rowText: string; optionText: string; optionIndex: number }) => boolean,
): Promise<string | null> {
  const selects = wsFrame.locator("select"); // allow-inline-selector -- unlabeled dropdown enumeration
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    const select = selects.nth(i);
    const rowText = await select.evaluate((el) => {
      const row = el.closest("tr") ?? el.closest("div") ?? el.parentElement;
      return row ? (row).innerText.substring(0, 200) : "";
    });
    const options = select.locator("option"); // allow-inline-selector -- enumerating option elements inside a dropdown
    const optCount = await options.count();
    for (let j = 0; j < optCount; j++) {
      const optionText = await options.nth(j).innerText();
      if (predicate({ rowText, optionText, optionIndex: j })) {
        await select.selectOption({ index: j });
        return optionText;
      }
    }
  }
  return null;
}

/**
 * Handle the full reports page flow for a single employee:
 * expand Timecard → click Time Detail → set dropdowns → run report → download.
 */
export async function handleReportsPage(
  page: Page,
  employeeId: string,
  employeeName: string | null,
  reportsDir: string,
): Promise<boolean> {
  log.step("On Reports page — waiting for report frames to load...");

  // Poll for khtmlReportList frame (up to 20s)
  let listFrame: Frame | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(2_000);
    listFrame = page.frame({ name: "khtmlReportList" });
    if (listFrame) break;
    if (attempt === 0) {
      log.step("Waiting for khtmlReportList frame...");
    }
  }

  await debugScreenshot(page, `ukg-reports-01-loaded-${employeeId}`);

  log.step("All frames:");
  for (const f of page.frames()) {
    log.step(`  ${f.name()} -> ${f.url().slice(0, 100)}`);
  }

  // Step 1: Expand Timecard in nav tree
  log.step("Expanding 'Timecard' in nav tree...");
  if (!listFrame) {
    log.error("khtmlReportList not found");
    return false;
  }

  const timecardLoc = reportsPage.timecardNavTreeEntry(listFrame);
  if (await clickIfPresent(timecardLoc, { label: "old kronos reports timecard nav tree entry" })) {
    await page.waitForTimeout(3_000);
  } else {
    log.error("'Timecard' not found in nav tree");
    return false;
  }

  // Step 2: Click Time Detail (JS click for reliability)
  log.step("Clicking 'Time Detail'...");
  const tdClicked = await listFrame.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const a of links) {
      if (a.title === "Time Detail" || a.textContent?.trim() === "Time Detail") {
        a.scrollIntoView();
        const evt = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        a.dispatchEvent(evt);
        return true;
      }
    }
    return false;
  });

  if (!tdClicked) {
    log.error("'Time Detail' not found");
    return false;
  }
  log.step("Selected 'Time Detail'");
  await page.waitForTimeout(5_000);

  // Step 3: Set Actual/Adjusted dropdown. The report workspace frame has
  // multiple unlabeled `<select>` elements we enumerate by index and filter
  // by the surrounding row text. No registry factory fits this pattern.
  log.step("Setting Actual/Adjusted dropdown...");
  const wsFrame = page.frame({ name: "khtmlReportWorkspace" });
  if (wsFrame) {
    const selected = await selectWorkspaceDropdown(
      wsFrame,
      ({ rowText, optionIndex }) =>
        optionIndex === 1 &&
        (rowText.toLowerCase().includes("actual") || rowText.toLowerCase().includes("adjusted")),
    );
    if (!selected) {
      throw new UKGError(
        `[${employeeId}] Could not set Actual/Adjusted dropdown — no matching option found in khtmlReportWorkspace`,
        "handleReportsPage",
      );
    }
    log.step("Actual/Adjusted set");
  }

  // Step 4: Set Output Format to PDF — same pattern as Step 3.
  log.step("Setting Output Format to PDF...");
  if (wsFrame) {
    const selected = await selectWorkspaceDropdown(
      wsFrame,
      ({ optionText }) =>
        optionText.toLowerCase().includes("pdf") || optionText.toLowerCase().includes("acrobat"),
    );
    if (!selected) {
      throw new UKGError(
        `[${employeeId}] Could not set Output Format to PDF — no matching option found in khtmlReportWorkspace`,
        "handleReportsPage",
      );
    }
    log.step(`Output format: ${selected}`);
  }

  await page.waitForTimeout(2_000);

  // Snapshot existing report rows before Run Report so polling ignores stale Complete rows.
  if (!(await clickInFrames(page, [...reportsPage.checkStatusSelectors]))) {
    await jsClickText(page, "CHECK REPORT STATUS");
  }
  await page.waitForTimeout(2_000);
  const existingRowIds = await collectReportRowIds(page);
  log.step(
    `[${employeeId}] Snapshot ${existingRowIds.size} existing report row(s) before Run Report`,
  );

  // Step 5: Click Run Report
  log.step(`[${employeeId}] Clicking Run Report...`);
  if (!await clickRunReport(page)) {
    log.error(`[${employeeId}] Could not click Run Report`);
    return false;
  }
  await page.waitForTimeout(3_000);

  // Step 6: Wait for report and download
  return await waitForReportAndDownload(
    page,
    employeeId,
    employeeName,
    reportsDir,
    existingRowIds,
  );
}
