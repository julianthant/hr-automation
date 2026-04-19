/**
 * Kronos dev tool — Old + New Kronos auth + per-subcommand action.
 *
 * Subcommands:
 *   map      — auth + nav to both timecard pages, keep browsers open for
 *              playwright-cli mapping (was kronos-map.ts).
 *   test     — auth + run checkTimecardDates on both Kronos systems in
 *              parallel, dump results, leave browsers open (was
 *              test-kronos-timecard.ts).
 *   explore  — auth + open Old Kronos "Go To" menu and dump menu items, then
 *              page.pause() in both browsers for selector discovery (was
 *              explore-kronos-selectors.ts).
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/debug/kronos.ts <map|test|explore> [<EID>]
 *
 * Default EID is `10598634` (matches the legacy single-purpose scripts).
 */
import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { loginToUKG, loginToNewKronos } from "../../auth/login.js";
import { PATHS } from "../../config.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  clickGoToTimecard,
  checkTimecardDates as checkOldKronosTimecard,
} from "../../systems/old-kronos/index.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult,
  clickGoToTimecard as newClickGoToTimecard,
  checkTimecardDates as checkNewKronosTimecard,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";
import { log } from "../../utils/log.js";

type Subcommand = "map" | "test" | "explore";

interface KronosWindows {
  oldWin: { page: Page };
  newWin: { page: Page };
}

async function authBoth(sessionSuffix: string): Promise<KronosWindows> {
  log.step("Launching Old Kronos + New Kronos...");
  const [oldWin, newWin] = await Promise.all([
    launchBrowser({ sessionDir: PATHS.ukgSessionBase + sessionSuffix }),
    launchBrowser(),
  ]);

  log.step("=== Auth Old Kronos (Duo #1) ===");
  await loginToUKG(oldWin.page);
  log.success("[Old Kronos] Authenticated");

  log.step("=== Auth New Kronos (Duo #2) ===");
  await newWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await loginToNewKronos(newWin.page);
  log.success("[New Kronos] Authenticated");

  return { oldWin, newWin };
}

async function runMap(eid: string): Promise<void> {
  const { oldWin, newWin } = await authBoth("_map");

  log.step("=== Old Kronos: navigating to timecard ===");
  const iframe = await getGeniesIframe(oldWin.page);
  await dismissModal(oldWin.page, iframe);
  await searchOldKronos(oldWin.page, iframe, eid);
  await oldWin.page.waitForTimeout(3_000);
  await clickEmployeeRow(oldWin.page, iframe, eid);
  await clickGoToTimecard(oldWin.page, iframe);
  await oldWin.page.waitForTimeout(3_000);
  log.success("[Old Kronos] On timecard page — ready for mapping");

  log.step("=== New Kronos: navigating to timecard ===");
  await searchNewKronos(newWin.page, eid);
  await selectEmployeeResult(newWin.page);
  await newClickGoToTimecard(newWin.page);
  await newWin.page.waitForTimeout(3_000);
  log.success("[New Kronos] On timecard page — ready for mapping");

  log.success("Both Kronos on timecard pages. Browsers staying open.");
  log.step("Use playwright-cli to map selectors now.");

  await new Promise(() => {});
}

async function runTest(eid: string): Promise<void> {
  const { oldWin, newWin } = await authBoth("_test");

  log.step("=== Running full timecard check (current + previous) in parallel ===");

  const [oldResult, newResult] = await Promise.allSettled([
    (async () => {
      const iframe = await getGeniesIframe(oldWin.page);
      await dismissModal(oldWin.page, iframe);
      await searchOldKronos(oldWin.page, iframe, eid);
      await oldWin.page.waitForTimeout(3_000);
      let found = true;
      for (const f of oldWin.page.frames()) {
        const noMatch = await f.locator("text=No matches were found").count().catch(() => 0);
        if (noMatch > 0) {
          found = false;
          try { await f.locator("button:has-text('OK')").click({ timeout: 3_000 }); } catch {}
          break;
        }
      }
      if (!found) return { found: false, date: null as string | null };
      await clickEmployeeRow(oldWin.page, iframe, eid);
      const date = await checkOldKronosTimecard(oldWin.page, iframe);
      return { found: true, date };
    })(),
    (async () => {
      const found = await searchNewKronos(newWin.page, eid);
      if (!found) return { found: false, date: null as string | null };
      const date = await checkNewKronosTimecard(newWin.page);
      return { found: true, date };
    })(),
  ]);

  const old = oldResult.status === "fulfilled" ? oldResult.value : { found: false, date: null };
  const neo = newResult.status === "fulfilled" ? newResult.value : { found: false, date: null };
  if (oldResult.status === "rejected") log.error(`[Old Kronos] Error: ${oldResult.reason}`);
  if (newResult.status === "rejected") log.error(`[New Kronos] Error: ${newResult.reason}`);

  log.success(`\n=== RESULTS ===`);
  log.step(`Old Kronos: ${old.found ? "found" : "not found"}, last date: ${old.date ?? "none"}`);
  log.step(`New Kronos: ${neo.found ? "found" : "not found"}, last date: ${neo.date ?? "none"}`);
  log.step("Browsers left open for inspection.");
}

async function runExplore(eid: string): Promise<void> {
  const { oldWin, newWin } = await authBoth("_explore");

  log.step("=== Old Kronos: search + open Go To menu ===");
  const iframe = await getGeniesIframe(oldWin.page);
  await dismissModal(oldWin.page, iframe);
  await searchOldKronos(oldWin.page, iframe, eid);
  await oldWin.page.waitForTimeout(3_000);
  await clickEmployeeRow(oldWin.page, iframe, eid);

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
  } else {
    log.error("[Old Kronos] Go To not found");
  }

  log.step("[Old Kronos] Pausing — inspect the Go To dropdown manually...");
  await oldWin.page.pause();

  log.step("=== New Kronos: search + dump buttons + date controls ===");
  const found = await searchNewKronos(newWin.page, eid);
  if (found) {
    await selectEmployeeResult(newWin.page);
    await newWin.page.waitForTimeout(2_000);

    const searchFrame = newWin.page.frameLocator('iframe[name^="portal-frame-"]');

    log.step("[New Kronos] === Buttons in search frame ===");
    const buttons = searchFrame.getByRole("button");
    const btnCount = await buttons.count();
    for (let i = 0; i < btnCount; i++) {
      const name = await buttons.nth(i).getAttribute("aria-label").catch(() => null)
        ?? await buttons.nth(i).innerText().catch(() => "???");
      log.step(`  [${i}] "${name}"`);
    }

    log.step("[New Kronos] === Buttons on main page (filtered) ===");
    const mainBtns = newWin.page.getByRole("button");
    const mainCount = await mainBtns.count();
    for (let i = 0; i < mainCount; i++) {
      const name = await mainBtns.nth(i).getAttribute("aria-label").catch(() => null)
        ?? await mainBtns.nth(i).innerText().catch(() => "???");
      if (name && /go|time|card|nav|period|previous|next/i.test(name)) {
        log.step(`  [${i}] "${name}"`);
      }
    }

    log.step("[New Kronos] Current URL: " + newWin.page.url());

    log.step("[New Kronos] === Date/period controls ===");
    const dateControls = newWin.page.locator("select, [aria-label*='period'], [aria-label*='date'], [aria-label*='Previous'], button:has-text('Previous')");
    const dcCount = await dateControls.count();
    for (let i = 0; i < dcCount; i++) {
      const tag = await dateControls.nth(i).evaluate((el: Element) => `${el.tagName}[${el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent?.trim().slice(0, 40)}]`).catch(() => "???");
      log.step(`  [${i}] ${tag}`);
    }
  }

  log.step("[New Kronos] Pausing — inspect the timecard and pay period controls...");
  await newWin.page.pause();

  log.success("=== Done ===");
}

function printUsage(): void {
  console.error(
    "Usage: tsx --env-file=.env src/scripts/debug/kronos.ts <map|test|explore> [<EID>]\n" +
      "  map      — auth both Kronos systems, navigate to timecard, keep open for selector mapping\n" +
      "  test     — auth both, run checkTimecardDates on both in parallel, dump results\n" +
      "  explore  — auth both, dump Go To menu items + button labels for selector discovery\n",
  );
}

async function main(): Promise<void> {
  const sub = process.argv[2] as Subcommand | undefined;
  const eid = process.argv[3] ?? "10598634";

  if (!sub || !["map", "test", "explore"].includes(sub)) {
    printUsage();
    process.exit(1);
  }

  if (sub === "map") await runMap(eid);
  else if (sub === "test") await runTest(eid);
  else await runExplore(eid);
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("kronos.ts") ||
  process.argv[1]?.endsWith("kronos.js");

if (isMainModule) {
  main().catch((err) => {
    log.error(`kronos dev tool failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
