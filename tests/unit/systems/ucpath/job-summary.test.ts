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
  pollForGridScan,
  pairFrozenGridRows,
  jobInfoRowsFromGrid,
  workLocationRowsFromGrid,
  type FrozenGridDump,
  pickWorkLocationRow,
  pickEffectiveDatedRow,
  effectiveDateKey,
  workLocationDateKey,
  type WorkLocationRow,
  type JobInfoRow,
} from "../../../../src/systems/ucpath/job-summary.js";

/** Build a Work Location row with sensible defaults for the picker tests. */
function wlRow(partial: Partial<WorkLocationRow>): WorkLocationRow {
  return {
    effectiveDate: "",
    deptId: "000000",
    departmentDescription: "Dept",
    positionNumber: "40000000",
    ...partial,
  };
}

/** Build a Job Information row with sensible defaults for the picker tests. */
function jiRow(partial: Partial<JobInfoRow>): JobInfoRow {
  return {
    effectiveDate: "",
    jobCode: "004722",
    jobDescription: "BLANK AST 3",
    ...partial,
  };
}

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
  it("returns the first scan when a job-coded row is already present (no extra attempts, no sleep)", async () => {
    let scans = 0;
    let sleeps = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        return [jiRow({ jobCode: "004722", jobDescription: "BLANK AST 3" })];
      },
      { attempts: 5, intervalMs: 1, sleep: async () => { sleeps++; } },
    );
    assert.deepStrictEqual(result, [jiRow({ jobCode: "004722", jobDescription: "BLANK AST 3" })]);
    assert.strictEqual(scans, 1, "non-empty on first scan — must not keep polling");
    assert.strictEqual(sleeps, 0, "no sleep when the first scan already has a job-coded row");
  });

  it("polls past empty scans (the grid-render race) and returns the first populated scan", async () => {
    let scans = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        // Grid not yet rendered on the first two scans, then it populates.
        return scans < 3
          ? []
          : [jiRow({ jobCode: "004722", jobDescription: "BLANK AST 3" })];
      },
      { attempts: 5, intervalMs: 1, sleep: async () => {} },
    );
    assert.deepStrictEqual(result, [jiRow({ jobCode: "004722", jobDescription: "BLANK AST 3" })]);
    assert.strictEqual(scans, 3, "must re-scan until the lazily-rendered grid yields a job code");
  });

  it("returns the last (empty) scan after exhausting attempts — caller decides empty is fatal", async () => {
    let scans = 0;
    let sleeps = 0;
    const result = await pollForJobInfoScan(
      async () => {
        scans++;
        return [];
      },
      { attempts: 4, intervalMs: 1, sleep: async () => { sleeps++; } },
    );
    assert.deepStrictEqual(result, []);
    assert.strictEqual(scans, 4, "scans exactly `attempts` times when the grid never populates");
    assert.strictEqual(sleeps, 3, "sleeps between attempts but not after the final one");
  });
});

/**
 * Department-by-effective-date pick (Work Location grid). The separations
 * department must come from the Work Location row in effect AS OF the separation
 * date — the latest Effective Date that is at-or-before it — so a department
 * change (transfer) resolves to the dept of the job actually being separated,
 * and the HDH/non-HDH kronos-skip gate is decided on the right department.
 */
describe("workLocationDateKey", () => {
  it("maps MM/DD/YYYY to a monotonic YYYYMMDD key", () => {
    assert.strictEqual(workLocationDateKey("06/10/2026"), 20260610);
    assert.strictEqual(workLocationDateKey("6/1/2026"), 20260601, "accepts non-padded M/D");
    assert.ok(workLocationDateKey("06/11/2026")! > workLocationDateKey("06/10/2026")!);
    assert.ok(workLocationDateKey("01/01/2026")! > workLocationDateKey("12/31/2025")!, "year dominates");
  });
  it("returns null for malformed input", () => {
    assert.strictEqual(workLocationDateKey(""), null);
    assert.strictEqual(workLocationDateKey("2026-06-10"), null);
    assert.strictEqual(workLocationDateKey("June 10, 2026"), null);
  });
});

describe("pickWorkLocationRow", () => {
  it("returns null for no rows", () => {
    assert.strictEqual(pickWorkLocationRow([]), null);
  });

  it("picks the latest effective date AT-OR-BEFORE the separation date", () => {
    // The Image #9 scenario: 11 rows up to 06/11/2026, separation 06/10/2026.
    // 06/11/2026 is AFTER the separation, so the in-effect row is 12/21/2025.
    const rows = [
      wlRow({ effectiveDate: "09/04/2024", departmentDescription: "Bookstore" }),
      wlRow({ effectiveDate: "12/21/2025", departmentDescription: "Bookstore" }),
      wlRow({ effectiveDate: "06/11/2026", departmentDescription: "Bookstore" }),
    ];
    const picked = pickWorkLocationRow(rows, "06/10/2026");
    assert.strictEqual(picked?.effectiveDate, "12/21/2025", "06/11 is after the sep date, so 12/21 wins");
  });

  it("resolves a transfer to the OLD department when the new one is effective after separation", () => {
    const rows = [
      wlRow({ effectiveDate: "01/01/2025", departmentDescription: "Housing Services" }),
      wlRow({ effectiveDate: "07/01/2026", departmentDescription: "Bookstore" }),
    ];
    // Separation 06/15/2026: the Bookstore transfer (07/01) hasn't taken effect.
    const picked = pickWorkLocationRow(rows, "06/15/2026");
    assert.strictEqual(picked?.departmentDescription, "Housing Services");
  });

  it("includes a row whose effective date EQUALS the separation date", () => {
    const rows = [
      wlRow({ effectiveDate: "01/01/2026", departmentDescription: "Old" }),
      wlRow({ effectiveDate: "06/10/2026", departmentDescription: "Same-day" }),
    ];
    const picked = pickWorkLocationRow(rows, "06/10/2026");
    assert.strictEqual(picked?.departmentDescription, "Same-day", "at-or-before includes equality");
  });

  it("THROWS when no row carries a usable date (total date-parse miss — fail loud, not an arbitrary row)", () => {
    const rows = [
      wlRow({ effectiveDate: "", departmentDescription: "First" }),
      wlRow({ effectiveDate: "", departmentDescription: "Second" }),
    ];
    assert.throws(
      () => pickWorkLocationRow(rows, "06/10/2026"),
      /none of the 2 row\(s\) had a parseable Effective Date/,
      "must fail loud instead of silently returning rows[0] — a blank department must not reach the HDH gate/Kuali",
    );
  });

  it("picks the latest effective date when NO separation date is supplied (current dept)", () => {
    const rows = [
      wlRow({ effectiveDate: "01/01/2025", departmentDescription: "Old" }),
      wlRow({ effectiveDate: "01/01/2026", departmentDescription: "Current" }),
    ];
    assert.strictEqual(pickWorkLocationRow(rows)?.departmentDescription, "Current");
  });

  it("uses the EARLIEST row when every row is after the separation date", () => {
    const rows = [
      wlRow({ effectiveDate: "09/01/2026", departmentDescription: "Earliest-after" }),
      wlRow({ effectiveDate: "10/01/2026", departmentDescription: "Later" }),
    ];
    assert.strictEqual(
      pickWorkLocationRow(rows, "06/10/2026")?.departmentDescription,
      "Earliest-after",
      "separation precedes all job states — earliest is the best available match",
    );
  });

  it("ignores undated rows when other rows have dates", () => {
    const rows = [
      wlRow({ effectiveDate: "", departmentDescription: "Undated" }),
      wlRow({ effectiveDate: "01/01/2026", departmentDescription: "Dated" }),
    ];
    assert.strictEqual(pickWorkLocationRow(rows, "06/10/2026")?.departmentDescription, "Dated");
  });
});

/**
 * The same effective-date rule must govern EVERYTHING read from Workforce Job
 * Summary — not just the Work Location department. `pickEffectiveDatedRow` is
 * the shared picker; here it's exercised on Job Information rows (Job Code /
 * Payroll Title), the value that fills Kuali's Payroll Title Code/Title. A
 * promotion/reclassification effective AFTER the separation must NOT win.
 */
describe("pickEffectiveDatedRow (Job Information / Payroll Title)", () => {
  it("`effectiveDateKey` and the `workLocationDateKey` alias agree", () => {
    assert.strictEqual(effectiveDateKey("06/10/2026"), 20260610);
    assert.strictEqual(effectiveDateKey("06/10/2026"), workLocationDateKey("06/10/2026"));
  });

  it("picks the job code in effect as of separation, not a later promotion", () => {
    const rows = [
      jiRow({ effectiveDate: "01/01/2025", jobCode: "004722", jobDescription: "BLANK AST 3" }),
      // Reclassified to a new title AFTER the separation — must be excluded.
      jiRow({ effectiveDate: "07/01/2026", jobCode: "004920", jobDescription: "SUPERVISOR" }),
    ];
    const picked = pickEffectiveDatedRow(rows, "06/15/2026");
    assert.strictEqual(picked?.jobCode, "004722");
    assert.strictEqual(picked?.jobDescription, "BLANK AST 3");
  });

  it("includes a job row whose effective date EQUALS the separation date", () => {
    const rows = [
      jiRow({ effectiveDate: "01/01/2026", jobCode: "004722", jobDescription: "Old title" }),
      jiRow({ effectiveDate: "06/10/2026", jobCode: "004920", jobDescription: "Same-day title" }),
    ];
    const picked = pickEffectiveDatedRow(rows, "06/10/2026");
    assert.strictEqual(picked?.jobDescription, "Same-day title", "at-or-before includes equality");
  });

  it("picks the latest job row when NO separation date is supplied (current job)", () => {
    const rows = [
      jiRow({ effectiveDate: "01/01/2025", jobDescription: "Old" }),
      jiRow({ effectiveDate: "01/01/2026", jobDescription: "Current" }),
    ];
    assert.strictEqual(pickEffectiveDatedRow(rows)?.jobDescription, "Current");
  });

  it("THROWS when no job row carries a usable date (total date-parse miss — fail loud, not an arbitrary row)", () => {
    const rows = [
      jiRow({ effectiveDate: "", jobDescription: "First" }),
      jiRow({ effectiveDate: "", jobDescription: "Second" }),
    ];
    assert.throws(
      () => pickEffectiveDatedRow(rows, "06/10/2026"),
      /none of the 2 row\(s\) had a parseable Effective Date/,
      "must fail loud instead of silently returning rows[0] — a wrong Payroll Title Code/Title must not reach Kuali",
    );
  });

  it("returns null for no rows", () => {
    assert.strictEqual(pickEffectiveDatedRow([] as JobInfoRow[]), null);
  });
});

/**
 * Stateful fake `Page` for the campus-discovery re-navigation path (ISS-B04).
 * Models the live redirect chain: the first `goto(JOB_SUMMARY_URL)` lands on the
 * `ucpathdiscovery` campus picker; clicking the UCSD link redirects to the
 * campus portal HOME (still NOT the deep-linked component); a second
 * `goto(JOB_SUMMARY_URL)` finally resolves the Workforce Job Summary component.
 */
function makeCampusFakePage() {
  const gotoCalls: unknown[][] = [];
  let campusLinkClicks = 0;
  let url = "https://ucphrprdpub.universityofcalifornia.edu/psp/ucphrprd/EMPLOYEE/HRMS/h/?tab=DEFAULT";
  const linkLocator = {
    click: async () => {
      campusLinkClicks++;
      // Campus selection redirects to the campus portal home — NOT the deep link.
      url = "https://ucpath.universityofcalifornia.edu/peoplesoft-native";
    },
  };
  const bodyLocator = { getByRole: () => ({ count: async () => 0 }) };
  const page = {
    url: () => url,
    getByRole: () => linkLocator,
    locator: (sel: string) =>
      sel === "#main_target_win0" ? { count: async () => 0 } : bodyLocator,
    goto: async (...args: unknown[]) => {
      gotoCalls.push(args);
      // 1st goto → campus discovery; 2nd goto (post-campus) → the component.
      url = gotoCalls.length === 1
        ? "https://ucpathdiscovery.universityofcalifornia.edu/"
        : JOB_SUMMARY_URL;
    },
    waitForLoadState: async () => {},
    _gotoCalls: gotoCalls,
    get _campusLinkClicks() { return campusLinkClicks; },
  };
  return page;
}

describe("navigateToWorkforceJobSummary (campus discovery re-navigation, ISS-B04)", () => {
  it("re-navigates to the deep link after selecting the campus (discovery redirect drops the search form)", async () => {
    const page = makeCampusFakePage();
    await navigateToWorkforceJobSummary(page as unknown as Page);
    assert.strictEqual(page._campusLinkClicks, 1, "must click the UCSD campus-discovery link once");
    assert.strictEqual(
      page._gotoCalls.length,
      2,
      "must goto twice: initial (→ discovery) then re-navigate to the deep link after campus select",
    );
    assert.strictEqual(
      page._gotoCalls[1][0],
      JOB_SUMMARY_URL,
      "the post-campus re-navigation must target the Workforce Job Summary deep link",
    );
    assert.ok(
      page.url().includes("WF_JOB_SUMMARY"),
      "ends on the Workforce Job Summary component with the Empl ID search form",
    );
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

// ─── Frozen-column grid pairing (live dumps, 2026-08-20) ─────────────────────
//
// Fixtures transcribed from the LIVE Workforce Job Summary grids of the two
// separations docs that exposed the bug (4540 Kim, Jon 10791600 — 17 rows;
// 4541 Zermeno, Leselie 10769919 — 16 rows). PeopleSoft renders the grid as two
// row-aligned tables: `tdgblWF_JOB_SUMM$0` (Org Rel · Empl Rec · Effective Date
// · Seq) and `tdgbrWF_JOB_SUMM$0` (the tab's columns). On Job Information the
// right row's ONLY date is "Expected Job End Date" — the old "first date cell in
// the row" scan read THAT as the effective date and shipped STDT 2 to Kuali for
// employees promoted to STDT 3 months before their separation.

const LEFT_ID = "tdgblWF_JOB_SUMM$0";
const RIGHT_ID = "tdgbrWF_JOB_SUMM$0";

function leftRows(dates: string[]): string[][] {
  return dates.map((d, i) => ["EMP", "0", d, i % 7 === 2 ? "1" : "0"]);
}
/** Job Information right row (Job Code · Description · … · Expected Job End Date · "" · row-header ""). */
function jiRight(code: string, desc: string, endDate: string): string[] {
  return [code, desc, "PSS", "Active", "Variable", "17.60", "0.440000", "Nonexempt", endDate, "", ""];
}
/** Work Location right row (Position · Description · Company · Dept ID · Dept Description · Location · BU · Supervisor). */
function wlRight(pos: string, desc: string, deptId: string, dept: string): string[] {
  return [pos, desc, "UCS", deptId, dept, "6840-1", "SDCMP", "Panicha Aguilar", ""];
}

// 4540 — Kim, Jon. Effective dates (left) and Job Information rows (right), in
// grid order. Promotion to STDT 3 took effect 03/29/2026; separation 06/16/2026.
const KIM_DATES = [
  "01/31/2025", "02/15/2025", "02/15/2025", "03/01/2025", "03/01/2025", "06/20/2025",
  "08/03/2025", "09/14/2025", "09/16/2025", "12/05/2025", "12/05/2025", "12/21/2025",
  "03/29/2026", "03/29/2026", "04/09/2026", "06/12/2026", "06/21/2026",
];
const KIM_JOB_INFO: FrozenGridDump = {
  left: [{ id: LEFT_ID, rows: leftRows(KIM_DATES) }],
  right: [{
    id: RIGHT_ID,
    rows: [
      ...Array.from({ length: 5 }, () => jiRight("004921", "STDT 2", "06/30/2025")),
      ...Array.from({ length: 3 }, () => jiRight("004921", "STDT 2", "09/21/2025")),
      ...Array.from({ length: 4 }, () => jiRight("004921", "STDT 2", "06/30/2026")),
      ...Array.from({ length: 3 }, () => jiRight("004920", "STDT 3", "06/30/2026")),
      ...Array.from({ length: 2 }, () => jiRight("004920", "STDT 3", "09/20/2026")),
    ],
  }],
};

// 4541 — Zermeno, Leselie. STDT 3 from 09/15/2025; separation 06/16/2026.
const ZERMENO_DATES = [
  "10/11/2024", "10/11/2024", "12/22/2024", "02/15/2025", "02/15/2025", "06/20/2025",
  "08/03/2025", "09/14/2025", "09/15/2025", "09/15/2025", "10/12/2025", "11/25/2025",
  "12/21/2025", "12/21/2025", "06/12/2026", "06/21/2026",
];
const ZERMENO_JOB_INFO: FrozenGridDump = {
  left: [{ id: LEFT_ID, rows: leftRows(ZERMENO_DATES) }],
  right: [{
    id: RIGHT_ID,
    rows: [
      ...Array.from({ length: 5 }, () => jiRight("004921", "STDT 2", "06/30/2025")),
      ...Array.from({ length: 3 }, () => jiRight("004921", "STDT 2", "09/21/2025")),
      ...Array.from({ length: 6 }, () => jiRight("004920", "STDT 3", "06/30/2026")),
      ...Array.from({ length: 2 }, () => jiRight("004920", "STDT 3", "09/20/2026")),
    ],
  }],
};
const ZERMENO_WORK_LOCATION: FrozenGridDump = {
  left: [{ id: LEFT_ID, rows: leftRows(ZERMENO_DATES) }],
  right: [{
    id: RIGHT_ID,
    rows: [
      ...Array.from({ length: 8 }, () => wlRight("40690430", "STDT 2", "000412", "HOUSING/DINING/HOSPITALITY")),
      ...Array.from({ length: 8 }, () => wlRight("40700768", "STDT 3", "000412", "HOUSING/DINING/HOSPITALITY")),
    ],
  }],
};

describe("pairFrozenGridRows (Workforce Job Summary frozen-column grid)", () => {
  it("zips the LEFT table's Effective Date onto the RIGHT table's row by index (Kim, 17 rows)", () => {
    const rows = pairFrozenGridRows(KIM_JOB_INFO);
    assert.equal(rows.length, 17);
    assert.equal(rows[0].effectiveDate, "01/31/2025");
    assert.deepEqual(rows[0].cells.slice(0, 2), ["004921", "STDT 2"]);
    assert.equal(rows[12].effectiveDate, "03/29/2026");
    assert.deepEqual(rows[12].cells.slice(0, 2), ["004920", "STDT 3"]);
    assert.equal(rows[16].effectiveDate, "06/21/2026");
  });

  it("NEVER reads the right row's own date (Expected Job End Date) as the Effective Date", () => {
    const rows = pairFrozenGridRows(KIM_JOB_INFO);
    // Every right row carries an in-row date (its end date); none of them leaks
    // into effectiveDate — the 06/30/2026-ending STDT 3 rows are 03/29–04/09/2026.
    const stdt3 = rows.filter((r) => r.cells[1] === "STDT 3").map((r) => r.effectiveDate);
    assert.deepEqual(stdt3, ["03/29/2026", "03/29/2026", "04/09/2026", "06/12/2026", "06/21/2026"]);
    assert.ok(!rows.some((r) => r.effectiveDate === "06/30/2026" || r.effectiveDate === "09/20/2026"));
  });

  it("returns [] while the grid has not rendered (no left table / empty left / missing right)", () => {
    assert.deepEqual(pairFrozenGridRows({ left: [], right: [] }), []);
    assert.deepEqual(pairFrozenGridRows({ left: [{ id: LEFT_ID, rows: [] }], right: [] }), []);
    assert.deepEqual(
      pairFrozenGridRows({ left: [{ id: LEFT_ID, rows: leftRows(["01/31/2025"]) }], right: [] }),
      [],
    );
  });

  it("THROWS on a left/right row-count mismatch (a misaligned zip must never pair a date with the wrong job)", () => {
    const dump: FrozenGridDump = {
      left: [{ id: LEFT_ID, rows: leftRows(["01/31/2025", "03/29/2026"]) }],
      right: [{ id: RIGHT_ID, rows: [jiRight("004921", "STDT 2", "06/30/2025")] }],
    };
    assert.throws(() => pairFrozenGridRows(dump), /has 2 row\(s\) but right table .* has 1/);
  });

  it("THROWS when the left table has no single all-dates column (layout drift, not a guess)", () => {
    const dump: FrozenGridDump = {
      left: [{ id: LEFT_ID, rows: [["EMP", "0", "not-a-date", "0"], ["EMP", "0", "01/31/2025", "0"]] }],
      right: [{ id: RIGHT_ID, rows: [jiRight("004921", "STDT 2", "06/30/2025"), jiRight("004921", "STDT 2", "06/30/2025")] }],
    };
    assert.throws(() => pairFrozenGridRows(dump), /expected exactly ONE all-dates/);
  });

  it("THROWS when more than one populated frozen-left table is present (ambiguous grid)", () => {
    const dump: FrozenGridDump = {
      left: [
        { id: "tdgblA$0", rows: leftRows(["01/31/2025"]) },
        { id: "tdgblB$0", rows: leftRows(["01/31/2025"]) },
      ],
      right: [{ id: "tdgbrA$0", rows: [jiRight("004921", "STDT 2", "06/30/2025")] }],
    };
    assert.throws(() => pairFrozenGridRows(dump), /expected ONE frozen-left grid table, found 2/);
  });

  it("pairs left/right by grid-id suffix, ignoring an unrelated right table", () => {
    const dump: FrozenGridDump = {
      left: [{ id: LEFT_ID, rows: leftRows(["01/31/2025"]) }],
      right: [
        { id: "tdgbrOTHER$0", rows: [["zzz"]] },
        { id: RIGHT_ID, rows: [jiRight("004920", "STDT 3", "06/30/2026")] },
      ],
    };
    assert.deepEqual(pairFrozenGridRows(dump)[0].cells.slice(0, 2), ["004920", "STDT 3"]);
  });
});

describe("jobInfoRowsFromGrid + pickEffectiveDatedRow — the 2026-08-20 regression (docs 4540 / 4541)", () => {
  it("Kim (4540): the job in effect at separation 06/16/2026 is 004920 STDT 3, not the older STDT 2", () => {
    const rows = jobInfoRowsFromGrid(pairFrozenGridRows(KIM_JOB_INFO));
    const picked = pickEffectiveDatedRow(rows, "06/16/2026");
    assert.ok(picked);
    assert.equal(picked.effectiveDate, "06/12/2026");
    assert.equal(picked.jobCode, "004920");
    assert.equal(picked.jobDescription, "STDT 3");
  });

  it("Zermeno (4541): the job in effect at separation 06/16/2026 is 004920 STDT 3", () => {
    const rows = jobInfoRowsFromGrid(pairFrozenGridRows(ZERMENO_JOB_INFO));
    const picked = pickEffectiveDatedRow(rows, "06/16/2026");
    assert.ok(picked);
    assert.equal(picked.effectiveDate, "06/12/2026");
    assert.deepEqual([picked.jobCode, picked.jobDescription], ["004920", "STDT 3"]);
  });

  it("a separation BEFORE the promotion still resolves to the old STDT 2 row (Kim, 03/01/2026)", () => {
    const rows = jobInfoRowsFromGrid(pairFrozenGridRows(KIM_JOB_INFO));
    const picked = pickEffectiveDatedRow(rows, "03/01/2026");
    assert.ok(picked);
    assert.deepEqual([picked.effectiveDate, picked.jobCode, picked.jobDescription], ["12/21/2025", "004921", "STDT 2"]);
  });

  it("THROWS when a right row does not start with a 6-digit Job Code (layout drift)", () => {
    const rows = pairFrozenGridRows({
      left: [{ id: LEFT_ID, rows: leftRows(["01/31/2025"]) }],
      right: [{ id: RIGHT_ID, rows: [["STDT 2", "004921"]] }],
    });
    assert.throws(() => jobInfoRowsFromGrid(rows), /does not start with a 6-digit Job Code/);
  });
});

describe("workLocationRowsFromGrid (Work Location tab on the same frozen grid)", () => {
  it("reads Dept ID/Description at +3/+4 from the Position Number anchor with the LEFT table's Effective Date", () => {
    const rows = workLocationRowsFromGrid(pairFrozenGridRows(ZERMENO_WORK_LOCATION));
    assert.equal(rows.length, 16);
    assert.deepEqual(
      [rows[0].effectiveDate, rows[0].positionNumber, rows[0].deptId, rows[0].departmentDescription],
      ["10/11/2024", "40690430", "000412", "HOUSING/DINING/HOSPITALITY"],
    );
    const picked = pickWorkLocationRow(rows, "06/16/2026");
    assert.ok(picked);
    assert.deepEqual([picked.effectiveDate, picked.positionNumber, picked.deptId], ["06/12/2026", "40700768", "000412"]);
  });

  it("THROWS when a row has no Position Number anchor (layout drift)", () => {
    const rows = pairFrozenGridRows({
      left: [{ id: LEFT_ID, rows: leftRows(["01/31/2025"]) }],
      right: [{ id: RIGHT_ID, rows: [["STDT 2", "UCS", "000412", "HOUSING/DINING/HOSPITALITY"]] }],
    });
    assert.throws(() => workLocationRowsFromGrid(rows), /no Position Number anchor/);
  });
});

describe("pollForGridScan", () => {
  it("re-scans until `ready` accepts and never sleeps after the accepting scan", async () => {
    const scans = [[] as string[], [] as string[], ["row"]];
    let i = 0;
    const sleeps: number[] = [];
    const out = await pollForGridScan(
      async () => scans[i++],
      (s) => s.length > 0,
      { attempts: 5, intervalMs: 7, sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.deepEqual(out, ["row"]);
    assert.deepEqual(sleeps, [7, 7]);
  });
});
