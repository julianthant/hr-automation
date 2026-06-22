/**
 * Pins the navigation-skip decision for Workforce Job Summary.
 *
 * Regression guard for ISS-B02 (2026-06-22, surfaced by the live separations
 * e2e dry-run batch): only the FIRST doc of a sequential separations batch
 * succeeded; every later doc failed at `kronos-search` because
 * `navigateToWorkforceJobSummary` skipped re-navigation on a URL-only check
 * (`page.url().includes("WF_JOB_SUMMARY")`). After the first doc drills into the
 * Work Location / Job Information detail tabs the URL keeps `WF_JOB_SUMMARY`
 * (same PeopleSoft component) but the Empl ID search box is gone, so the next
 * `searchJobSummary` fill timed out (`locator.fill: Timeout 10000ms ... waiting
 * for ... textbox "Empl ID"`). There is no ucpath `resetUrl` restoring the
 * search page between docs.
 *
 * The skip decision is now gated on BOTH the URL AND the search box being
 * present. The pre-fix behaviour was equivalent to returning `urlOnComponent`
 * alone — so the `{ urlOnComponent: true, searchBoxPresent: false } -> false`
 * case below is the red→green pin: it fails against URL-only logic and passes
 * with the fix.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import {
  canSkipJobSummaryNavigation,
  navigateToWorkforceJobSummary,
  pollForJobInfoScan,
} from "../../../../src/systems/ucpath/job-summary.js";

const JOB_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/ADMINISTER_WORKFORCE_(GBL).WF_JOB_SUMMARY.GBL";

/**
 * Minimal Playwright `Page` fake for `navigateToWorkforceJobSummary`. It needs:
 * - `url()` — drives the URL-on-component check
 * - `locator("#main_target_win0").count()` — iframe probe (0 → direct-URL root)
 * - `locator("body").getByRole(...).count()` — Empl ID search-box presence
 * - `goto`/`waitForLoadState` — re-navigation (goto recorded as the assertion)
 */
function makeFakePage(opts: { url: string; searchBoxCount: number }) {
  const gotoCalls: unknown[][] = [];
  const bodyLocator = {
    getByRole: () => ({ count: async () => opts.searchBoxCount }),
  };
  const page = {
    url: () => opts.url,
    locator: (sel: string) =>
      sel === "#main_target_win0"
        ? { count: async () => 0 }
        : bodyLocator,
    goto: async (...args: unknown[]) => {
      gotoCalls.push(args);
    },
    waitForLoadState: async () => {},
    _gotoCalls: gotoCalls,
  };
  return page;
}

describe("canSkipJobSummaryNavigation", () => {
  it("skips nav only when the URL is on the component AND the search box is present", () => {
    assert.strictEqual(
      canSkipJobSummaryNavigation({ urlOnComponent: true, searchBoxPresent: true }),
      true,
      "fast path: already on a usable search page",
    );
  });

  it("does NOT skip when on the component but the search box is absent (the ISS-B02 detail-view trap)", () => {
    assert.strictEqual(
      canSkipJobSummaryNavigation({ urlOnComponent: true, searchBoxPresent: false }),
      false,
      "WF_JOB_SUMMARY URL but detail-tab view from a prior doc — must re-navigate, not trust the URL",
    );
  });

  it("does NOT skip when the URL is off the component", () => {
    assert.strictEqual(
      canSkipJobSummaryNavigation({ urlOnComponent: false, searchBoxPresent: false }),
      false,
    );
    assert.strictEqual(
      canSkipJobSummaryNavigation({ urlOnComponent: false, searchBoxPresent: true }),
      false,
      "search box flag is meaningless when we're not even on the component",
    );
  });
});

/**
 * Regression guard for the blank Payroll Title Code/Title bug (2026-06-22,
 * separations doc 4290): `extractJobInfo` clicked the Job Information tab, then
 * `waitForPeopleSoftProcessing` returned on its 2s "spinner never appeared"
 * timeout — NOT on the grid actually rendering. The single DOM scan that
 * followed raced the lazily-loaded Job Information grid, found no 6-digit job
 * code, and returned empty jobCode/jobDescription. Kuali then filled only the
 * department and the run logged success. The fix replaces the single scan with
 * a condition-based poll that re-scans until the job code appears (the prior
 * fixed `waitForTimeout(3_000)`, removed by 84beeef7, used to mask the race).
 *
 * `pollForJobInfoScan` is the pure core of that fix: it takes an injected scan
 * callback + injected sleep so the wall-clock dependency is testable.
 */
describe("pollForJobInfoScan", () => {
  it("returns the first scan when the job code is already present (no extra attempts, no sleep)", async () => {
    let scans = 0;
    let sleeps = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        return { jobCode: "004722", jobDescription: "BLANK AST 3" };
      },
      { attempts: 5, intervalMs: 1, sleep: async () => { sleeps++; } },
    );
    assert.deepStrictEqual(result, { jobCode: "004722", jobDescription: "BLANK AST 3" });
    assert.strictEqual(scans, 1, "non-empty on first scan — must not keep polling");
    assert.strictEqual(sleeps, 0, "no sleep when the first scan already has the job code");
  });

  it("polls past empty scans (the grid-render race) and returns the first populated scan", async () => {
    let scans = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        // Grid not yet rendered on the first two scans, then it populates.
        return scans < 3
          ? { jobCode: "", jobDescription: "" }
          : { jobCode: "004722", jobDescription: "BLANK AST 3" };
      },
      { attempts: 5, intervalMs: 1, sleep: async () => {} },
    );
    assert.deepStrictEqual(result, { jobCode: "004722", jobDescription: "BLANK AST 3" });
    assert.strictEqual(scans, 3, "must re-scan until the lazily-rendered grid yields the job code");
  });

  it("returns the last (empty) scan after exhausting attempts — caller decides empty is fatal", async () => {
    let scans = 0;
    let sleeps = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        return { jobCode: "", jobDescription: "" };
      },
      { attempts: 4, intervalMs: 1, sleep: async () => { sleeps++; } },
    );
    assert.deepStrictEqual(result, { jobCode: "", jobDescription: "" });
    assert.strictEqual(scans, 4, "scans exactly `attempts` times when the grid never populates");
    assert.strictEqual(sleeps, 3, "sleeps between attempts but not after the final one");
  });
});

describe("navigateToWorkforceJobSummary (re-navigation wiring)", () => {
  it("skips goto when on the component AND the search box is present", async () => {
    const page = makeFakePage({ url: JOB_SUMMARY_URL, searchBoxCount: 1 });
    await navigateToWorkforceJobSummary(page as unknown as Page);
    assert.strictEqual(page._gotoCalls.length, 0, "usable search page — must not re-navigate");
  });

  it("RE-NAVIGATES when on the component but the search box is absent (ISS-B02)", async () => {
    // The detail-view trap: URL keeps WF_JOB_SUMMARY after a prior doc, but the
    // Empl ID search box is gone. URL-only logic would wrongly return here.
    const page = makeFakePage({ url: JOB_SUMMARY_URL, searchBoxCount: 0 });
    await navigateToWorkforceJobSummary(page as unknown as Page);
    assert.strictEqual(page._gotoCalls.length, 1, "search box absent — must re-navigate to reset search state");
    assert.strictEqual(page._gotoCalls[0][0], JOB_SUMMARY_URL);
  });

  it("navigates when the URL is off the component", async () => {
    const page = makeFakePage({ url: "https://ucphrprdpub.universityofcalifornia.edu/psp/ucphrprd/EMPLOYEE/HRMS/h/?tab=DEFAULT", searchBoxCount: 0 });
    await navigateToWorkforceJobSummary(page as unknown as Page);
    assert.strictEqual(page._gotoCalls.length, 1, "off-component — must navigate");
  });
});
