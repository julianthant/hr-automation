import type { Page, Frame } from "playwright";
import { join } from "path";
import { readdir } from "fs/promises";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { PATHS } from "../../config.js";
import { reportsPage } from "./selectors.js";

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
        if (await loc.count() > 0) {
          await loc.first().click();
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

  const selectors = reportsPage.runReportSelectors;

  const framesToSearch = [
    ...(contentFrame ? [contentFrame] : []),
    ...page.frames(),
  ];

  for (const sel of selectors) {
    for (const f of framesToSearch) {
      try {
        const loc = f.locator(sel);
        if (await loc.count() > 0) {
          await loc.first().click();
          log.step(`Clicked Run Report via '${sel}' in '${f.name()}'`);
          return true;
        }
      } catch {
        // Continue
      }
    }
  }

  // JS fallback across all frames
  for (const f of framesToSearch) {
    try {
      const clicked = await f.evaluate(() => {
        const tags = ["input", "button", "a", "td", "div", "span", "img"];
        for (const tag of tags) {
          for (const el of document.querySelectorAll(tag)) {
            const text = (
              (el as HTMLInputElement).value ||
              el.textContent ||
              (el as HTMLImageElement).alt ||
              (el as HTMLElement).title ||
              ""
            ).trim();
            if (text === "Run Report") {
              (el as HTMLElement).click();
              return `clicked ${tag}`;
            }
          }
        }
        return null;
      });
      if (clicked) {
        log.step(`${clicked} (frame: ${f.name()})`);
        return true;
      }
    } catch {
      // Continue
    }
  }

  log.error("Run Report NOT FOUND");
  return false;
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
): Promise<boolean> {
  log.step(`[${employeeId}] Waiting for report to complete...`);

  // Switch to CHECK REPORT STATUS tab
  await clickInFrames(page, [...reportsPage.checkStatusSelectors]) ||
    await jsClickText(page, "CHECK REPORT STATUS");

  // Wait 12 seconds for the report to generate
  await page.waitForTimeout(12_000);

  // Refresh and find the first Complete row
  let myRowId: string | null = null;
  let statusFrame: Frame | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    await clickInFrames(page, [...reportsPage.refreshStatusSelectors]) ||
      await jsClickText(page, "Refresh Status");
    await page.waitForTimeout(3_000);

    for (const f of page.frames()) {
      try {
        const result = await f.evaluate(() => {
          const spans = document.querySelectorAll('span[id^="statusValue"]');
          if (spans.length === 0) return null;
          const span = spans[0];
          const text = span.textContent?.trim() ?? "";
          const tr = span.closest("tr");
          const trId = tr ? tr.id : null;
          return { status: text, trId };
        });

        if (result) {
          const status = (result.status ?? "").toLowerCase();
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
          // Still running/waiting — keep polling
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

  return await downloadReportRow(page, statusFrame!, myRowId, employeeId, employeeName, reportsDir);
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
  await clickInFrames(page, [...reportsPage.viewReportSelectors]) ||
    await jsClickText(page, "View Report");

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

  const { rename, unlink } = await import("fs/promises");
  const { existsSync } = await import("fs");

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
        log.step(`Download: captured via filesystem fallback (diff in ${checkDir})`);
        if (src !== dest) {
          if (existsSync(dest)) await unlink(dest);
          await rename(src, dest);
        }
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
  if (await timecardLoc.count() > 0) {
    await timecardLoc.first().click();
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
    const selects = wsFrame.locator("select"); // allow-inline-selector -- unlabeled dropdown enumeration
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      const labelText: string = await selects.nth(i).evaluate((el) => {
        const row = el.closest("tr") ?? el.closest("div") ?? el.parentElement;
        return row ? (row as HTMLElement).innerText.substring(0, 200) : "";
      });
      if (labelText.toLowerCase().includes("actual") || labelText.toLowerCase().includes("adjusted")) {
        await selects.nth(i).selectOption({ index: 1 });
        log.step("Actual/Adjusted set");
        break;
      }
    }
  }

  // Step 4: Set Output Format to PDF — same pattern as Step 3.
  log.step("Setting Output Format to PDF...");
  if (wsFrame) {
    const selects = wsFrame.locator("select"); // allow-inline-selector -- unlabeled dropdown enumeration
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      const options = selects.nth(i).locator("option"); // allow-inline-selector -- enumerating option elements inside a dropdown
      const optCount = await options.count();
      for (let j = 0; j < optCount; j++) {
        const txt = await options.nth(j).innerText();
        if (txt.toLowerCase().includes("pdf") || txt.toLowerCase().includes("acrobat")) {
          await selects.nth(i).selectOption({ index: j });
          log.step(`Output format: ${txt}`);
          break;
        }
      }
    }
  }

  await page.waitForTimeout(2_000);

  // Step 5: Click Run Report
  log.step(`[${employeeId}] Clicking Run Report...`);
  if (!await clickRunReport(page)) {
    log.error(`[${employeeId}] Could not click Run Report`);
    return false;
  }
  await page.waitForTimeout(3_000);

  // Step 6: Wait for report and download
  return await waitForReportAndDownload(page, employeeId, employeeName, reportsDir);
}
