/** Live smoke: run addPayRule through lookup fill (no Save). */
import { launchBrowser } from "../src/infra/browser/launch.js";
import { loginToNewKronos } from "../src/infra/auth/login.js";
import {
  NEW_KRONOS_URL,
  searchEmployee,
  selectEmployeeResult,
  clickGoToPeople,
  expandTimekeeperSection,
  addPayRule,
} from "../src/systems/new-kronos/navigate.js";

const eid = process.argv[2] ?? "10403587";

async function main() {
  const { browser, page } = await launchBrowser({ headless: true });
  try {
    await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!(await loginToNewKronos(page))) throw new Error("auth failed");
    if (!(await searchEmployee(page, eid))) throw new Error("search failed");
    if (!(await selectEmployeeResult(page))) throw new Error("select failed");
    if (!(await clickGoToPeople(page, eid))) throw new Error("people failed");
    await expandTimekeeperSection(page);
    await addPayRule(page, "SX-8Hol-8-OT-30", "07/01/2026");
    console.log("addPayRule OK (not saved)");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
