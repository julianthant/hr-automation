// tests/unit/scripts/selectors-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
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
