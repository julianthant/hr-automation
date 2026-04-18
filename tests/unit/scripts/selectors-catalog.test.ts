// tests/unit/scripts/selectors-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractSelectors, renderCatalog } from "../../../src/scripts/selectors-catalog.js";

test("extractSelectors handles top-level exported functions", () => {
  const src = `
import type { Page, Locator } from "playwright";
/**
 * Returns the iframe content frame.
 * verified 2026-03-16
 * @tags iframe, frame, content
 */
export function getContentFrame(page: Page): Locator {
  return page.frameLocator("#x") as unknown as Locator;
}`;
  const records = extractSelectors("test.ts", src);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "getContentFrame");
  assert.equal(records[0].summary, "Returns the iframe content frame.");
  assert.deepEqual(records[0].tags, ["iframe", "frame", "content"]);
  assert.equal(records[0].verifiedDate, "2026-03-16");
});

test("extractSelectors handles top-level const arrow functions", () => {
  const src = `
import type { Page, Locator } from "playwright";
/** Returns the search input. verified 2026-04-01 */
export const searchInput = (page: Page): Locator => page.getByRole("textbox");`;
  const records = extractSelectors("test.ts", src);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "searchInput");
  assert.equal(records[0].verifiedDate, "2026-04-01");
});

test("extractSelectors recurses into exported object literals (smartHR.tab.X pattern)", () => {
  const src = `
import type { Page, Locator } from "playwright";
export const smartHR = {
  /** Sidebar link. verified 2026-03-16 */
  sidebarLink: (page: Page): Locator => page.getByRole("link"),
  tab: {
    /** Personal data tab. verified 2026-03-16 */
    personalData: (page: Page): Locator => page.getByRole("tab"),
    /** Job data tab. verified 2026-03-16 */
    jobData: (page: Page): Locator => page.getByRole("tab"),
  },
};`;
  const records = extractSelectors("test.ts", src);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.name).sort(),
    ["smartHR.sidebarLink", "smartHR.tab.jobData", "smartHR.tab.personalData"],
  );
});

test("extractSelectors omits non-exported declarations", () => {
  const src = `
const internalHelper = (x: number) => x;
/** Public selector. */
export const publicSelector = (x: number) => x;`;
  const records = extractSelectors("test.ts", src);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "publicSelector");
});

test("extractSelectors handles selectors without JSDoc gracefully", () => {
  const src = `
import type { Page, Locator } from "playwright";
export const noDoc = (page: Page): Locator => page.getByRole("textbox");`;
  const records = extractSelectors("test.ts", src);
  assert.equal(records.length, 1);
  assert.equal(records[0].summary, "(no JSDoc)");
  assert.deepEqual(records[0].tags, []);
  assert.equal(records[0].verifiedDate, null);
});

test("renderCatalog produces stable markdown", () => {
  const md = renderCatalog("xyz", [
    {
      name: "smartHR.tab.personalData",
      summary: "Personal data tab.",
      tags: ["tab", "personal"],
      verifiedDate: "2026-03-16",
      line: 42,
    },
  ]);
  assert.match(md, /^# xyz — Selector Catalog$/m);
  assert.match(md, /## `smartHR\.tab\.personalData\(\)` — verified 2026-03-16/);
  assert.match(md, /\*\*Tags:\*\* tab, personal/);
  assert.match(md, /\*\*Source:\*\* \[`src\/systems\/xyz\/selectors\.ts:42`\]/);
});

// ── Drift gate (spec D1) ────────────────────────────────────────────────
//
// Asserts every committed `src/systems/<sys>/SELECTORS.md` matches what
// `extractSelectors` + `renderCatalog` would produce from the live
// `selectors.ts`. If a contributor adds/changes/removes a selector without
// running `npm run selectors:catalog`, this test fails so the stale catalog
// can't reach main. The "regenerated YYYY-MM-DD" line is normalized in both
// sides because it embeds the wall-clock date.

test("committed SELECTORS.md matches regenerated catalog (drift gate)", () => {
  const SYSTEMS_DIR = "src/systems";
  const normalizeDate = (md: string): string =>
    md.replace(/regenerated \d{4}-\d{2}-\d{2}/g, "regenerated <date>");

  const systemsWithSelectors = readdirSync(SYSTEMS_DIR).filter((sys) => {
    try {
      return statSync(join(SYSTEMS_DIR, sys, "selectors.ts")).isFile();
    } catch {
      return false;
    }
  });

  // Sanity: confirm the catalog covers the systems we expect. Guards against
  // a future selectors.ts being added but never wired into the catalog walk.
  assert.ok(
    systemsWithSelectors.length >= 6,
    `expected at least 6 systems with selectors.ts, found ${systemsWithSelectors.length}`,
  );

  for (const sys of systemsWithSelectors) {
    const selectorsPath = join(SYSTEMS_DIR, sys, "selectors.ts");
    const catalogPath = join(SYSTEMS_DIR, sys, "SELECTORS.md");

    const source = readFileSync(selectorsPath, "utf8");
    const records = extractSelectors(selectorsPath, source);
    const expected = normalizeDate(renderCatalog(sys, records));

    let actual: string;
    try {
      actual = normalizeDate(readFileSync(catalogPath, "utf8"));
    } catch {
      assert.fail(
        `SELECTORS.md missing for ${sys} — run \`npm run selectors:catalog\` and commit.`,
      );
      return;
    }

    assert.equal(
      actual,
      expected,
      `SELECTORS.md drift detected for ${sys} — run \`npm run selectors:catalog\` and commit the result.`,
    );
  }
});
