/**
 * Exploration script: Launch Old & New Kronos, navigate to Timecards for an EID,
 * then pause for live selector discovery.
 *
 * Usage: npx tsx --env-file=.env src/workflows/separations/explore-kronos.ts <EID>
 */

import { launchBrowser } from "../../browser/launch.js";
import { loginToUKG, loginToNewKronos } from "../../auth/login.js";
import { PATHS } from "../../config.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
} from "../../systems/old-kronos/index.js";
import {
  searchEmployee as searchNewKronos,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";
import { log } from "../../utils/log.js";

const eid = process.argv[2];
if (!eid) {
  console.error("Usage: npx tsx --env-file=.env src/workflows/separations/explore-kronos.ts <EID>");
  process.exit(1);
}

// ─── Old Kronos ───

log.step("=== Launching Old Kronos ===");
const oldKronosWin = await launchBrowser({
  sessionDir: PATHS.ukgSessionSep,
  viewport: { width: 1200, height: 900 },
});

log.step("[Old Kronos] Authenticating (Duo #1)...");
await loginToUKG(oldKronosWin.page);
log.success("[Old Kronos] Authenticated");

const iframe = await getGeniesIframe(oldKronosWin.page);
await dismissModal(oldKronosWin.page, iframe);
await searchOldKronos(oldKronosWin.page, iframe, eid);
await oldKronosWin.page.waitForTimeout(3_000);

// Check if found
let oldKronosFound = true;
for (const f of oldKronosWin.page.frames()) {
  const noMatch = await f.locator("text=No matches were found").count().catch(() => 0);
  if (noMatch > 0) {
    oldKronosFound = false;
    try { await f.locator("button:has-text('OK')").click({ timeout: 3_000 }); } catch { /* ok */ }
    break;
  }
}

if (oldKronosFound) {
  log.success(`[Old Kronos] EID ${eid} FOUND — clicking row...`);
  await clickEmployeeRow(oldKronosWin.page, iframe, eid);

  // Go To → Timecards (similar to Go To → Reports but selecting Timecards)
  log.step("[Old Kronos] Clicking Go To...");
  const gotoEl = iframe.locator("text=Go To").first();
  if (await gotoEl.count() > 0) {
    await gotoEl.click();
    await oldKronosWin.page.waitForTimeout(3_000);

    log.step("[Old Kronos] Looking for Timecards option...");
    // Log all visible menu items for discovery
    for (const f of oldKronosWin.page.frames()) {
      const menuItems = f.locator("a, li, span, div");
      const count = await menuItems.count();
      for (let i = 0; i < Math.min(count, 50); i++) {
        const text = (await menuItems.nth(i).innerText().catch(() => "")).trim();
        if (text && text.length < 40 && text.toLowerCase().includes("time")) {
          log.step(`  Menu item: "${text}"`);
        }
      }
    }

    // Try clicking Timecards
    const timecardsItem = iframe.locator("text=Timecard").first();
    if (await timecardsItem.count() > 0) {
      await timecardsItem.click();
      await oldKronosWin.page.waitForTimeout(5_000);
      log.success("[Old Kronos] Navigated to Timecards");
    } else {
      log.error("[Old Kronos] 'Timecard' not found in Go To menu");
    }
  } else {
    log.error("[Old Kronos] Go To button not found");
  }

  log.step("[Old Kronos] Pausing for inspection — use Playwright Inspector to explore selectors");
  await oldKronosWin.page.pause();
} else {
  log.step(`[Old Kronos] EID ${eid} NOT FOUND — skipping`);
}

// ─── New Kronos ───

log.step("=== Launching New Kronos ===");
const newKronosWin = await launchBrowser({
  viewport: { width: 1200, height: 900 },
});

log.step("[New Kronos] Navigating...");
await newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

log.step("[New Kronos] Authenticating (Duo #2)...");
await loginToNewKronos(newKronosWin.page);
log.success("[New Kronos] Authenticated");

const newKronosFound = await searchNewKronos(newKronosWin.page, eid);

if (newKronosFound) {
  log.success(`[New Kronos] EID ${eid} FOUND`);

  // The employee appears as a row in the sidebar — we need to check the checkbox
  // and then use the Go To dropdown → Timecards
  const searchFrame = newKronosWin.page.frameLocator('iframe[name^="portal-frame-"]');

  log.step("[New Kronos] Looking for checkbox on employee row...");
  // Log what we see in the sidebar for discovery
  const allCheckboxes = searchFrame.locator('input[type="checkbox"]');
  const cbCount = await allCheckboxes.count();
  log.step(`[New Kronos] Found ${cbCount} checkboxes in search results`);

  // Try to check the first result checkbox
  if (cbCount > 0) {
    await allCheckboxes.first().check({ timeout: 5_000 });
    log.step("[New Kronos] Checked first result checkbox");
  }

  // Look for Go To dropdown
  log.step("[New Kronos] Looking for Go To dropdown...");
  // Try main page first, then iframe
  const gotoButton = newKronosWin.page.getByRole("button", { name: /go to/i })
    .or(newKronosWin.page.locator("text=Go To"))
    .or(searchFrame.getByRole("button", { name: /go to/i }))
    .or(searchFrame.locator("text=Go To"));

  if (await gotoButton.count() > 0) {
    await gotoButton.first().click({ timeout: 5_000 });
    await newKronosWin.page.waitForTimeout(2_000);
    log.step("[New Kronos] Go To menu opened");
  } else {
    log.step("[New Kronos] Go To button not found — will explore in pause");
  }

  log.step("[New Kronos] Pausing for inspection — use Playwright Inspector to explore selectors");
  await newKronosWin.page.pause();
} else {
  log.step(`[New Kronos] EID ${eid} NOT FOUND — skipping`);
}

log.success("=== Exploration complete. Windows left open. ===");
