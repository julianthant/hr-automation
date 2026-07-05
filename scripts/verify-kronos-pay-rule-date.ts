/** Verify effective date is set after addPayRule (batch + single). */
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
import { people, peopleFrame } from "../src/systems/new-kronos/selectors.js";

const eids = process.argv.slice(2);
if (eids.length === 0) eids.push("10416352", "10839757");

async function readEffectiveDate(page: import("playwright").Page): Promise<string> {
  const root = peopleFrame(page);
  const cellText = await people.effectiveDateCell(root).innerText().catch(() => "");
  return `cell=${cellText.trim() || "(empty)"}`;
}

async function runOne(page: import("playwright").Page, eid: string, code: string) {
  if (!(await searchEmployee(page, eid))) throw new Error(`search failed ${eid}`);
  if (!(await selectEmployeeResult(page))) throw new Error(`select failed ${eid}`);
  if (!(await clickGoToPeople(page, eid))) throw new Error(`people failed ${eid}`);
  await expandTimekeeperSection(page);
  await addPayRule(page, code, "07/01/2026");
  const date = await readEffectiveDate(page);
  console.log(`${eid}: after addPayRule effective date ${date}`);
  if (!/7\/0?1\/2026/.test(date)) {
    throw new Error(`${eid}: effective date not set — ${date}`);
  }
}

async function main() {
  const { browser, page } = await launchBrowser({ headless: true });
  try {
    await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!(await loginToNewKronos(page))) throw new Error("auth failed");
    await runOne(page, eids[0]!, "SX-8Hol-8-OT-30");
    if (eids[1]) await runOne(page, eids[1]!, "SX-8Hol-8-OT-30");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
