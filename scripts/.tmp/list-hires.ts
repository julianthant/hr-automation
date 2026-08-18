import { launchBrowser } from "../../src/infra/browser/launch.js";
import { loginToUCPath } from "../../src/infra/auth/login.js";
import { navigateToSsSmartHrTransactions } from "../../src/systems/ucpath/ss-smart-hr.js";
import { getContentFrame, waitForPeopleSoftProcessing } from "../../src/systems/ucpath/navigate.js";
import { ssSmartHRTransactions } from "../../src/systems/ucpath/selectors.js";
import { safeClick } from "../../src/systems/common/index.js";
import { log } from "../../src/utils/log.js";

async function main() {
  const session = await launchBrowser();
  const page = session.page;
  try {
    if (!(await loginToUCPath(page))) throw new Error("UCPath login failed");
    await navigateToSsSmartHrTransactions(page);
    const frame = getContentFrame(page);
    await safeClick(ssSmartHRTransactions.searchButton(frame), { timeout: 10_000, label: "search" });
    await page.waitForTimeout(4_000);
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const raw = await frame.locator("tr[id^=trPTS_CFG_CL_STD_RSL]").evaluateAll((trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())),
    ).catch(() => [] as string[][]);
    log.step(`RAWROWS ${raw.length}`);
    for (const cells of raw.slice(0, 12)) console.log("ROW", JSON.stringify(cells));
    const hit = raw.filter((c) => c.join(" ").toLowerCase().includes("alnasser"));
    console.log("ALNASSER MATCHES:", JSON.stringify(hit));
  } finally {
    await session.browser?.close();
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
