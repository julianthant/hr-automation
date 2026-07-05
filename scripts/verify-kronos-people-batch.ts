/**
 * Batch probe: multiple EIDs in one browser session (daemon-like reuse).
 * Mirrors the kronos-pay-rule workflow's navigation EXACTLY — home reset →
 * search → select → Go To → People → identity verify — and ASSERTS the People
 * editor actually switched to each employee (no add/save). This is the guard
 * for the 2026-07-02 "redoes the old one" bug: the previous probe only checked
 * clickGoToPeople's boolean + URL, both of which the buggy false-positive
 * satisfied while the editor still showed the previous person.
 *
 * Usage: HR_AUTOMATION_DUO_WEBAUTHN=1 npx tsx --env-file=.env scripts/verify-kronos-people-batch.ts eid1 eid2
 */
import type { Page } from "playwright";
import { launchBrowser } from "../src/infra/browser/launch.js";
import { loginToNewKronos } from "../src/infra/auth/login.js";
import {
  NEW_KRONOS_URL,
  searchEmployee,
  selectEmployeeResult,
  clickGoToPeople,
  verifyPeopleEmployee,
  resetNewKronosToHome,
} from "../src/systems/new-kronos/navigate.js";

const eids = process.argv.slice(2);
if (eids.length < 2) {
  console.error("Usage: verify-kronos-people-batch.ts <eid1> <eid2> [...]");
  process.exit(1);
}

async function openAndVerify(page: Page, eid: string): Promise<boolean> {
  await resetNewKronosToHome(page);
  if (!(await searchEmployee(page, eid))) {
    console.error(`  ${eid}: NOT FOUND in search`);
    return false;
  }
  if (!(await selectEmployeeResult(page))) {
    console.error(`  ${eid}: select failed`);
    return false;
  }
  if (!(await clickGoToPeople(page, eid))) {
    console.error(`  ${eid}: clickGoToPeople failed`);
    return false;
  }
  const idCheck = await verifyPeopleEmployee(page, eid);
  if (!idCheck.ok) {
    console.error(
      `  ${eid}: IDENTITY MISMATCH — editor shows ${idCheck.shownEid ?? "unknown"}, not ${eid}`,
    );
    return false;
  }
  console.log(`  ${eid}: OK — editor confirmed showing ${eid}`);
  return true;
}

async function main() {
  const { browser, page } = await launchBrowser({ headless: true });
  try {
    await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!(await loginToNewKronos(page))) throw new Error("auth failed");

    for (const eid of eids) {
      console.log(`\n--- EID ${eid} ---`);
      if (!(await openAndVerify(page, eid))) process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
