/**
 * Read-only live probe: authenticate to WFD, open People for a test EID, and
 * report the Save button's state with NO pending edits — the contract
 * `savePersonRecord`'s post-save readback relies on (a committed save returns
 * the editor to this no-pending-edits state, so the Save button must read
 * disabled/inactive here). Makes NO edits and clicks nothing in the editor.
 *
 * Usage:
 *   HR_AUTOMATION_DUO_WEBAUTHN=1 tsx --env-file=.env scripts/verify-kronos-save-state.ts [eid]
 */
import { launchBrowser } from "../src/infra/browser/launch.js";
import { loginToNewKronos } from "../src/infra/auth/login.js";
import {
  NEW_KRONOS_URL,
  searchEmployee,
  selectEmployeeResult,
  clickGoToPeople,
} from "../src/systems/new-kronos/navigate.js";
import { people, peopleFrame } from "../src/systems/new-kronos/selectors.js";

const eid = process.argv[2] ?? "10403587";

async function main() {
  const { browser, page } = await launchBrowser({ headless: true });
  try {
    await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ok = await loginToNewKronos(page);
    if (!ok) throw new Error("New Kronos authentication failed");

    const found = await searchEmployee(page, eid);
    if (!found) throw new Error(`Employee ${eid} not found in search`);
    if (!(await selectEmployeeResult(page))) throw new Error(`Could not select employee ${eid}`);
    if (!(await clickGoToPeople(page, eid))) throw new Error(`Could not open People page for ${eid}`);

    const root = peopleFrame(page);
    const save = people.saveButton(root);
    await save.waitFor({ state: "attached", timeout: 30_000 });

    console.log("Save button state with NO pending edits:");
    console.log(`  count       = ${await save.count()}`);
    console.log(`  isVisible   = ${await save.isVisible().catch((e) => `ERR ${String(e)}`)}`);
    console.log(`  isEnabled   = ${await save.isEnabled().catch((e) => `ERR ${String(e)}`)}`);
    console.log(`  disabled    = ${await save.getAttribute("disabled")}`);
    console.log(`  aria-disabled = ${await save.getAttribute("aria-disabled")}`);
    console.log(`  class       = ${await save.getAttribute("class")}`);
    const outer = await save.evaluate((el) => el.outerHTML.slice(0, 400));
    console.log(`  outerHTML   = ${outer}`);
    const parent = await save.evaluate((el) => el.parentElement?.outerHTML.slice(0, 400) ?? "");
    console.log(`  parent      = ${parent}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
