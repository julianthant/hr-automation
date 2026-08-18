import { launchBrowser } from "../../src/infra/browser/launch.js";
import { loginToUCPath } from "../../src/infra/auth/login.js";
import { navigateToSsSmartHrTransactions } from "../../src/systems/ucpath/ss-smart-hr.js";
import { getContentFrame, waitForPeopleSoftProcessing } from "../../src/systems/ucpath/navigate.js";
import { ssSmartHRTransactions } from "../../src/systems/ucpath/selectors.js";
import { safeClick, safeFill } from "../../src/systems/common/index.js";
import { log } from "../../src/utils/log.js";

const QUERIES = (process.env.Q ?? "ALI ALNASSER|ALNASSER,ALI|Alnasser").split("|");

async function main() {
  const session = await launchBrowser();
  const page = session.page;
  try {
    if (!(await loginToUCPath(page))) throw new Error("UCPath login failed");
    for (const q of QUERIES) {
      await navigateToSsSmartHrTransactions(page);
      const frame = getContentFrame(page);
      await safeFill(ssSmartHRTransactions.nameInput(frame), q, { timeout: 10_000, label: "name" });
      await safeClick(ssSmartHRTransactions.searchButton(frame), { timeout: 10_000, label: "search" });
      await page.waitForTimeout(4_000);
      await waitForPeopleSoftProcessing(frame, 15_000);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      const raw = await frame.locator("tr[id^=trPTS_CFG_CL_STD_RSL]").evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())),
      ).catch(() => [] as string[][]);
      log.step(`QUERY "${q}" -> ${raw.length} row(s)`);
      for (const c of raw.slice(0, 8)) console.log("ROW", JSON.stringify(c));
    }
  } finally {
    await session.browser?.close();
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
