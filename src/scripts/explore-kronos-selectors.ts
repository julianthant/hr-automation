/**
 * Explore Kronos Go To menus and pay period controls.
 * Dumps visible elements for selector discovery.
 *
 * Usage: node --env-file=.env --import tsx/esm src/scripts/explore-kronos-selectors.ts <EID>
 */
import { launchBrowser } from "../browser/launch.js";
import { loginToUKG, loginToNewKronos } from "../auth/login.js";
import { PATHS } from "../config.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
} from "../systems/old-kronos/index.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult,
  NEW_KRONOS_URL,
} from "../new-kronos/index.js";
import { log } from "../utils/log.js";

const eid = process.argv[2] ?? "10598634";

// ─── Old Kronos ───
log.step("=== Old Kronos ===");
const oldWin = await launchBrowser({
  sessionDir: PATHS.ukgSessionBase + "_explore",
  viewport: { width: 1200, height: 900 },
});

await loginToUKG(oldWin.page);
log.success("[Old Kronos] Authenticated");

const iframe = await getGeniesIframe(oldWin.page);
await dismissModal(oldWin.page, iframe);
await searchOldKronos(oldWin.page, iframe, eid);
await oldWin.page.waitForTimeout(3_000);
await clickEmployeeRow(oldWin.page, iframe, eid);

// Open Go To menu and dump all items
log.step("[Old Kronos] Opening Go To menu...");
const gotoEl = iframe.locator("text=Go To").first();
if (await gotoEl.count() > 0) {
  await gotoEl.click();
  await oldWin.page.waitForTimeout(3_000);

  log.step("[Old Kronos] === Menu items visible in all frames ===");
  for (const f of oldWin.page.frames()) {
    const items = await f.locator("a, li, span, div, button, input").allInnerTexts();
    for (const text of items) {
      const t = text.trim();
      if (t && t.length > 0 && t.length < 60 && /time|card|schedule|goto|go to|menu/i.test(t)) {
        log.step(`  [${f.name() || "main"}] "${t}"`);
      }
    }
  }

  // Also dump the dropdown/menu container specifically
  const menuItems = iframe.locator("ul li, .dropdown-menu li, [role='menuitem'], .menu-item");
  const menuCount = await menuItems.count();
  log.step(`[Old Kronos] Menu items (${menuCount}):`);
  for (let i = 0; i < menuCount; i++) {
    const text = (await menuItems.nth(i).innerText().catch(() => "")).trim();
    if (text) log.step(`  [${i}] "${text}"`);
  }
} else {
  log.error("[Old Kronos] Go To not found");
}

log.step("[Old Kronos] Pausing — inspect the Go To dropdown manually...");
await oldWin.page.pause();

// ─── New Kronos ───
log.step("=== New Kronos ===");
const newWin = await launchBrowser({ viewport: { width: 1200, height: 900 } });
await newWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await loginToNewKronos(newWin.page);
log.success("[New Kronos] Authenticated");

const found = await searchNewKronos(newWin.page, eid);
if (found) {
  await selectEmployeeResult(newWin.page);
  await newWin.page.waitForTimeout(2_000);

  // Dump the sidebar/search frame controls
  const searchFrame = newWin.page.frameLocator('iframe[name^="portal-frame-"]');

  log.step("[New Kronos] === Buttons in search frame ===");
  const buttons = searchFrame.getByRole("button");
  const btnCount = await buttons.count();
  for (let i = 0; i < btnCount; i++) {
    const name = await buttons.nth(i).getAttribute("aria-label").catch(() => null)
      ?? await buttons.nth(i).innerText().catch(() => "???");
    log.step(`  [${i}] "${name}"`);
  }

  // Try finding Go To on main page
  log.step("[New Kronos] === Buttons on main page ===");
  const mainBtns = newWin.page.getByRole("button");
  const mainCount = await mainBtns.count();
  for (let i = 0; i < mainCount; i++) {
    const name = await mainBtns.nth(i).getAttribute("aria-label").catch(() => null)
      ?? await mainBtns.nth(i).innerText().catch(() => "???");
    if (name && /go|time|card|nav|period|previous|next/i.test(name)) {
      log.step(`  [${i}] "${name}"`);
    }
  }

  // Also check for the timecard page already loaded (WFD might auto-navigate)
  log.step("[New Kronos] Current URL: " + newWin.page.url());

  // Look for pay period / date controls
  log.step("[New Kronos] === Date/period controls ===");
  const dateControls = newWin.page.locator("select, [aria-label*='period'], [aria-label*='date'], [aria-label*='Previous'], button:has-text('Previous')");
  const dcCount = await dateControls.count();
  for (let i = 0; i < dcCount; i++) {
    const tag = await dateControls.nth(i).evaluate(el => `${el.tagName}[${el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent?.trim().slice(0, 40)}]`).catch(() => "???");
    log.step(`  [${i}] ${tag}`);
  }
}

log.step("[New Kronos] Pausing — inspect the timecard and pay period controls...");
await newWin.page.pause();

log.success("=== Done ===");
