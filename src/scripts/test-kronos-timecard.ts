/**
 * Test full Kronos timecard flow: search → timecard → check current → check previous.
 * Usage: node --env-file=.env --import tsx/esm src/scripts/test-kronos-timecard.ts <EID>
 */
import { launchBrowser } from "../browser/launch.js";
import { loginToUKG, loginToNewKronos } from "../auth/login.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  checkTimecardDates as checkOldKronosTimecard,
} from "../old-kronos/index.js";
import {
  searchEmployee as searchNewKronos,
  checkTimecardDates as checkNewKronosTimecard,
  NEW_KRONOS_URL,
} from "../new-kronos/index.js";
import { log } from "../utils/log.js";

const eid = process.argv[2] ?? "10598634";

log.step("=== Launching Old Kronos + New Kronos ===");
const [oldWin, newWin] = await Promise.all([
  launchBrowser({ sessionDir: "C:\\Users\\juzaw\\ukg_session_test" }),
  launchBrowser(),
]);

log.step("=== Auth Old Kronos (Duo #1) ===");
await loginToUKG(oldWin.page);
log.success("[Old Kronos] Authenticated");

log.step("=== Auth New Kronos (Duo #2) ===");
await newWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await loginToNewKronos(newWin.page);
log.success("[New Kronos] Authenticated");

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
      if (noMatch > 0) { found = false; try { await f.locator("button:has-text('OK')").click({ timeout: 3_000 }); } catch {} break; }
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
