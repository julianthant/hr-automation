/**
 * Authenticate both Kronos systems and navigate to timecards,
 * then keep browsers open for playwright-cli mapping.
 *
 * Usage: node --env-file=.env --import tsx/esm src/scripts/kronos-map.ts <EID>
 */
import { launchBrowser } from "../browser/launch.js";
import { loginToUKG, loginToNewKronos } from "../auth/login.js";
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  clickGoToTimecard,
} from "../old-kronos/index.js";
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult,
  clickGoToTimecard as newClickGoToTimecard,
  NEW_KRONOS_URL,
} from "../new-kronos/index.js";
import { log } from "../utils/log.js";

const eid = process.argv[2] ?? "10598634";

log.step("Launching Old Kronos + New Kronos...");
const [oldWin, newWin] = await Promise.all([
  launchBrowser({ sessionDir: "C:\\Users\\juzaw\\ukg_session_map" }),
  launchBrowser(),
]);

log.step("=== Auth Old Kronos (Duo #1) ===");
await loginToUKG(oldWin.page);
log.success("[Old Kronos] Authenticated");

log.step("=== Auth New Kronos (Duo #2) ===");
await newWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await loginToNewKronos(newWin.page);
log.success("[New Kronos] Authenticated");

// Old Kronos: search → click row → Go To → Timecards
log.step("=== Old Kronos: navigating to timecard ===");
const iframe = await getGeniesIframe(oldWin.page);
await dismissModal(oldWin.page, iframe);
await searchOldKronos(oldWin.page, iframe, eid);
await oldWin.page.waitForTimeout(3_000);
await clickEmployeeRow(oldWin.page, iframe, eid);
await clickGoToTimecard(oldWin.page, iframe);
await oldWin.page.waitForTimeout(3_000);
log.success("[Old Kronos] On timecard page — ready for mapping");

// New Kronos: search → checkbox → Go To → Timecard
log.step("=== New Kronos: navigating to timecard ===");
await searchNewKronos(newWin.page, eid);
await selectEmployeeResult(newWin.page);
await newClickGoToTimecard(newWin.page);
await newWin.page.waitForTimeout(3_000);
log.success("[New Kronos] On timecard page — ready for mapping");

log.success("Both Kronos on timecard pages. Browsers staying open.");
log.step("Use playwright-cli to map selectors now.");

// Keep process alive
await new Promise(() => {});
