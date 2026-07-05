/**
 * Read-only live probe: authenticate to WFD, open People → Timekeeper for a
 * test EID, and print selector counts + an accessibility snapshot excerpt.
 *
 * Usage:
 *   HR_AUTOMATION_DUO_WEBAUTHN=1 tsx --env-file=.env scripts/verify-kronos-people-selectors.ts [eid]
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { launchBrowser } from "../src/infra/browser/launch.js";
import { loginToNewKronos } from "../src/infra/auth/login.js";
import {
  NEW_KRONOS_URL,
  searchEmployee,
  selectEmployeeResult,
  clickGoToPeople,
  expandTimekeeperSection,
} from "../src/systems/new-kronos/navigate.js";
import { people, peopleFrame, goToMenu } from "../src/systems/new-kronos/selectors.js";

const eid = process.argv[2] ?? "10403587";
const outDir = join(process.cwd(), "generated/.selector-verify");

async function countLabel(
  page: import("playwright").Page,
  label: string,
  fn: () => import("playwright").Locator,
) {
  try {
    const n = await fn().count();
    console.log(`  ${label}: count=${n}`);
    return n;
  } catch (err) {
    console.log(`  ${label}: ERROR ${String(err)}`);
    return -1;
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { browser, page } = await launchBrowser({ headless: true });
  try {
    await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ok = await loginToNewKronos(page);
    if (!ok) throw new Error("New Kronos authentication failed");

    const found = await searchEmployee(page, eid);
    if (!found) throw new Error(`Employee ${eid} not found in search`);

    if (!(await selectEmployeeResult(page))) {
      throw new Error(`Could not select employee ${eid}`);
    }
    if (!(await clickGoToPeople(page, eid))) {
      throw new Error(`Could not open People page for ${eid}`);
    }

    await expandTimekeeperSection(page);

    const peopleRoot = peopleFrame(page);

    const payRuleCell = people.payRuleEmptyCell(peopleRoot);
    await payRuleCell.click({ timeout: 5_000 });
    await people.payRuleDropdownList(peopleRoot).waitFor({ state: "attached", timeout: 5_000 });

    console.log("\nAfter clicking row1 pay rule cell:");
    await countLabel(page, "payRuleDropdownList", () => people.payRuleDropdownList(peopleRoot));
    await countLabel(page, "payRuleSearchOption", () => people.payRuleSearchOption(peopleRoot));
    await countLabel(page, "pe.search.payrule", () => peopleRoot.locator("#pe\\.search\\.payrule"));

    console.log("\nSelector probe on managePeople frame → Timekeeper:");
    await countLabel(page, "timekeeperPanel", () => people.timekeeperPanel(peopleRoot));
    await countLabel(page, "timekeeperSection", () => people.timekeeperSection(peopleRoot));
    await countLabel(page, "payRuleColumnHeader", () => people.payRuleColumnHeader(peopleRoot));
    await countLabel(page, "payRuleAddButton", () => people.payRuleAddButton(peopleRoot));
    await countLabel(page, "payRuleEmptyCell", () => people.payRuleEmptyCell(peopleRoot));
    await countLabel(page, "payRuleSearchInput", () => people.payRuleSearchInput(peopleRoot));
    await countLabel(page, "payRuleSearchOk", () => people.payRuleSearchOk(peopleRoot));
    await countLabel(page, "effectiveDateCell", () => people.effectiveDateCell(peopleRoot));
    await countLabel(page, "saveButton", () => people.saveButton(peopleRoot));

    console.log(`page url: ${page.url()}`);
    for (const f of page.frames()) {
      const name = f.name() || f.url().slice(0, 80);
      const tk = await f.getByText("Timekeeper", { exact: true }).count().catch(() => 0);
      const pr = await f.getByText("Pay Rule", { exact: true }).count().catch(() => 0);
      const save = await f.getByRole("button", { name: /save/i }).count().catch(() => 0);
      if (tk || pr || save) {
        console.log(`  frame ${name}: timekeeper=${tk} payRule=${pr} save=${save}`);
      }
    }

    const html = await peopleRoot.content();
    writeFileSync(join(outDir, `people-${eid}.html`), html);
    const hits = html
      .split("\n")
      .filter((line) =>
        /pay.?rule|timekeeper|Effective Date|data-automation|Save/i.test(line),
      )
      .slice(0, 80);
    writeFileSync(join(outDir, `people-${eid}-lines.txt`), hits.join("\n"));
    console.log(`\nHTML lines (${hits.length}):`);
    console.log(hits.slice(0, 30).join("\n"));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
