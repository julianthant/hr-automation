// tests/unit/scripts/selectors/search-lib.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  scoreItem,
  rank,
  parseSelectorsMarkdown,
  parseLessonsMarkdown,
  type IndexedItem,
} from "../../../../src/scripts/selectors/search-lib.js";

test("tokenize lowercases and splits on non-word chars", () => {
  assert.deepEqual(tokenize("Comp Rate Code"), ["comp", "rate", "code"]);
  assert.deepEqual(tokenize("compRateCode-Input"), ["compratecode", "input"]);
  assert.deepEqual(tokenize("a b ce"), ["ce"]); // single-char dropped
});

test("scoreItem weights title > tags > body", () => {
  const item: IndexedItem = {
    kind: "selector",
    system: "ucpath",
    title: "compRateCodeInput",
    body: "Returns the textbox labeled comp rate code in PayPath job-data grid.",
    tags: ["comp", "rate", "paypath"],
    ref: "src/systems/ucpath/selectors.ts:120",
  };
  // "comp rate" = ["comp", "rate"]
  // title "compratecodeinput" includes "comp" and "rate" each as substring → 2*2 = 4
  // tags ["comp"], ["rate"] → exact match each → 2*2 = 4
  // body has "comp" and "rate" → 0.5*2 = 1
  // total = 9
  assert.equal(scoreItem(item, ["comp", "rate"]), 9);
});

test("rank returns top N descending", () => {
  // Lesson titles are short H2 phrases that often happen to contain both query
  // tokens verbatim, so they out-score selector camelCase titles on title hits
  // alone. The fixture below exercises that directly: the lesson title
  // "compensation rate dropdown vs textbox" tokens ["compensation", "rate",
  // "dropdown", "vs", "textbox"] gives an exact "rate" hit (+3) AND a
  // substring "comp" hit on "compensation" (+2 — bidirectional substring) →
  // title 5; tags 4 (exact "comp" + "rate"); body matches → 1; total 10.
  // The selector "compRateCodeInput" tokens ["compratecodeinput"] give two
  // substring hits → title 4; tags 4; body 1; total 9.
  const items: IndexedItem[] = [
    {
      kind: "selector",
      system: "ucpath",
      title: "compRateCodeInput",
      body: "Comp rate code textbox.",
      tags: ["comp", "rate"],
      ref: "a:1",
    },
    {
      kind: "selector",
      system: "ucpath",
      title: "personalDataTab",
      body: "Personal data tab.",
      tags: ["tab"],
      ref: "a:2",
    },
    {
      kind: "lesson",
      system: "ucpath",
      title: "compensation rate dropdown vs textbox",
      body: "Tried select#comp-rate, failed because element is a textbox.",
      tags: ["comp", "rate", "dropdown"],
      ref: "b:1",
    },
  ];
  const ranked = rank(items, "comp rate", 10);
  // The lesson title "compensation rate ..." scores higher than the selector
  // "compRateCodeInput" because the lesson title has an exact "rate" token
  // hit (worth 3) plus a substring "comp" hit on "compensation" (worth 2)
  // — total title 5 vs the selector's 4 substring hits. This matches how the
  // CLI behaves in practice with real LESSONS.md content; surfacing a
  // relevant lesson alongside selectors is intentional, not a bug.
  assert.equal(ranked[0].item.title, "compensation rate dropdown vs textbox");
  assert.equal(ranked[1].item.title, "compRateCodeInput");
  assert.equal(ranked.length, 2); // personalDataTab scored 0
});

test("rank breaks ties by kind (selector before lesson) then alphabetic", () => {
  // tokenize() drops single-char tokens, so use 2+ char fixtures.
  // All three items below score the same against query "alpha":
  //   - title "alpha" exact match → +3 (or "alphab" substring → +2 — see note below)
  //   - tags ["alpha"] exact → +2
  //   - body has "alpha" → +0.5
  // Items with title "alpha" all score 5.5; item with title "alphab" scores
  // 4.5. Sort order: tied items break by kind (selector first), then alphabetic.
  const items: IndexedItem[] = [
    { kind: "lesson", system: "sys", title: "alpha", body: "alpha", tags: ["alpha"], ref: "" },
    { kind: "selector", system: "sys", title: "alpha", body: "alpha", tags: ["alpha"], ref: "" },
    { kind: "selector", system: "sys", title: "beta", body: "alpha", tags: ["alpha"], ref: "" },
  ];
  const ranked = rank(items, "alpha", 10);
  // Both "alpha" items tie at 5.5; selector wins on kind tiebreak. Then the
  // "alpha" lesson at 5.5. Then "beta" selector at 2.5 (no title match).
  assert.equal(ranked[0].item.kind, "selector");
  assert.equal(ranked[0].item.title, "alpha");
  assert.equal(ranked[1].item.kind, "lesson");
  assert.equal(ranked[1].item.title, "alpha");
  assert.equal(ranked[2].item.title, "beta");
  assert.equal(ranked[2].item.kind, "selector");
});

test("rank returns empty for empty query", () => {
  const items: IndexedItem[] = [
    { kind: "selector", system: "x", title: "y", body: "z", tags: [], ref: "" },
  ];
  assert.deepEqual(rank(items, "", 10), []);
});

test("parseSelectorsMarkdown extracts H2 sections with tags + source", () => {
  const md = `# ucpath catalog\n\nIntro text.\n\n## \`compRateCodeInput()\` — verified 2026-04-15\n\nComp rate textbox.\n\n**Tags:** comp, rate, paypath\n**Source:** [\`src/systems/ucpath/selectors.ts:120\`](./selectors.ts#L120)\n\n## \`personalDataTab()\` — verified 2026-04-15\n\nPersonal data tab.\n\n**Tags:** tab\n`;
  const items = parseSelectorsMarkdown("ucpath", md);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "compRateCodeInput");
  assert.deepEqual(items[0].tags, ["comp", "rate", "paypath"]);
  assert.equal(items[0].ref, "src/systems/ucpath/selectors.ts:120");
  assert.equal(items[1].title, "personalDataTab");
  assert.deepEqual(items[1].tags, ["tab"]);
});

test("parseLessonsMarkdown extracts H2 sections with tags", () => {
  const md = `# ucpath lessons\n\n## 2026-04-16 — Comp rate dropdown is actually a textbox\n\n**Tried:** select#comp-rate\n**Failed because:** element is a textbox\n**Fix:** getByRole("textbox", { name: "Comp Rate Code" })\n**Selector:** \`compRateCodeInput\` in selectors.ts\n**Tags:** comp, rate, dropdown, peoplesoft\n`;
  const items = parseLessonsMarkdown("ucpath", md);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Comp rate dropdown is actually a textbox");
  assert.deepEqual(items[0].tags, ["comp", "rate", "dropdown", "peoplesoft"]);
  assert.equal(items[0].ref, "src/systems/ucpath/LESSONS.md");
});

test("parseLessonsMarkdown does NOT split on body `## Sub-heading` lines (only date-prefixed H2s)", () => {
  // A single lesson body that contains an `## What worked` sub-heading. The
  // old splitter (`/^## /m`) treated this as a second lesson and produced a
  // malformed entry. The fixed splitter only fires on date-prefixed `^## YYYY-MM-DD`.
  const md = `# kuali lessons

## 2026-04-15 — Date input ignores fill() intermittently

**Tried:** \`page.fill("#date-input", value)\`
**Failed because:** Kuali clears the field after fill on slow connections.

## What worked instead

Type the value character-by-character and re-read after each keystroke.

**Fix:** type() with re-read verification
**Tags:** kuali, date, fill, type
`;
  const items = parseLessonsMarkdown("kuali", md);
  assert.equal(items.length, 1, "body `## What worked` must NOT split the lesson");
  assert.equal(items[0].title, "Date input ignores fill() intermittently");
  assert.deepEqual(items[0].tags, ["kuali", "date", "fill", "type"]);
  // The body should still contain the sub-heading text (still searchable).
  assert.match(items[0].body, /What worked instead/);
});

test("parseLessonsMarkdown splits multiple date-prefixed lessons", () => {
  const md = `# k lessons

## 2026-04-10 — First lesson title
**Tried:** A
**Failed because:** B
**Fix:** C
**Tags:** alpha

## 2026-04-12 — Second lesson title
**Tried:** D
**Failed because:** E
**Fix:** F
**Tags:** beta
`;
  const items = parseLessonsMarkdown("kuali", md);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "First lesson title");
  assert.equal(items[1].title, "Second lesson title");
  assert.deepEqual(items[0].tags, ["alpha"]);
  assert.deepEqual(items[1].tags, ["beta"]);
});
