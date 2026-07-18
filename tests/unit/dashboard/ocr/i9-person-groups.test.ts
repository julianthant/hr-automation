/**
 * Per-person grouping for the i9 OCR review — one section per PERSON holding
 * both of their (often non-adjacent) I-9 pages.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildI9RenderList,
  i9SectionPages,
  type I9GroupableRecord,
} from "../../../../src/dashboard/components/ocr/i9-person-groups.js";

interface Rec extends I9GroupableRecord {
  name?: string;
}

function row(record: Rec, originalIndex: number): { record: Rec; originalIndex: number } {
  return { record, originalIndex };
}

const S1 = (over: Partial<Rec>): Rec => ({ formKind: "i9", sourcePage: 1, ...over });
const S2 = (over: Partial<Rec>): Rec => ({ formKind: "unknown", sourcePage: 1, ...over });

function build(recordRows: Array<{ record: Rec; originalIndex: number }>, over: Partial<{
  failedPages: Array<{ page: number }>;
  emptyPages: number[];
  markedBlankPages: Set<number>;
}> = {}) {
  return buildI9RenderList<Rec, { page: number }>({
    recordRows,
    failedPages: over.failedPages ?? [],
    emptyPages: over.emptyPages ?? [],
    markedBlankPages: over.markedBlankPages ?? new Set(),
  });
}

describe("buildI9RenderList", () => {
  it("a paired person renders ONE section with Section 2 first, then Section 1", () => {
    // The live packet shape: Sanchez's Section 2 is page 1, Section 1 page 9.
    const list = build([
      row(S1({ sourcePage: 9, section2Page: 1, name: "Sanchez" }), 0),
      row(S2({ sourcePage: 1, name: "" }), 1), // the claimed Section 2 sheet record
    ]);
    assert.equal(list.length, 1, "the claimed Section 2 record renders no card of its own");
    const person = list[0];
    assert.equal(person.kind, "i9-person");
    if (person.kind !== "i9-person") return;
    assert.deepEqual(person.pages, [
      { page: 1, label: "Section 2" },
      { page: 9, label: "Section 1" },
    ]);
    assert.equal(person.sortPage, 1, "the section sorts at the person's earliest page");
    assert.equal(person.originalIndex, 0);
  });

  it("an unpaired Section 1 renders a one-page person section", () => {
    const list = build([row(S1({ sourcePage: 4 }), 0)]);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, "i9-person");
    if (list[0].kind !== "i9-person") return;
    assert.deepEqual(list[0].pages, [{ page: 4, label: "Section 1" }]);
  });

  it("an orphan Section 2 (missing Section 1) is its own person section", () => {
    const list = build([row(S2({ sourcePage: 24, orphanSection2: true }), 0)]);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, "i9-person");
    if (list[0].kind !== "i9-person") return;
    assert.deepEqual(list[0].pages, [{ page: 24, label: "Section 2" }]);
  });

  it("unclaimed unknown pages keep per-page rendering — no page of the packet is hidden", () => {
    const list = build([
      row(S1({ sourcePage: 2 }), 0),
      row(S2({ sourcePage: 5 }), 1), // a Lists-of-Acceptable-Documents page nobody claimed
    ]);
    assert.equal(list.length, 2);
    const leftover = list.find((e) => e.kind === "records");
    assert.ok(leftover && leftover.kind === "records");
    assert.equal(leftover.page, 5);
  });

  it("failed and empty pages interleave by page number; consumed pages never re-render", () => {
    const list = build(
      [row(S1({ sourcePage: 3, section2Page: 1 }), 0)],
      { failedPages: [{ page: 2 }], emptyPages: [1, 4] },
    );
    // page 1 is consumed by the person section (its Section 2 image), so the
    // empty-page entry for page 1 must not appear.
    assert.deepEqual(
      list.map((e) => e.kind),
      ["i9-person", "failed", "empty"],
    );
    const empty = list.find((e) => e.kind === "empty");
    assert.equal(empty && empty.kind === "empty" ? empty.page : -1, 4);
  });

  it("marked-blank pages are skipped like the generic path", () => {
    const list = build([], { emptyPages: [7], markedBlankPages: new Set([7]) });
    assert.equal(list.length, 0);
  });

  it("sections sort among each other and page entries by earliest page", () => {
    const list = build([
      row(S1({ sourcePage: 9, section2Page: 6 }), 0),
      row(S1({ sourcePage: 2 }), 1),
      row(S2({ sourcePage: 4 }), 2), // unclaimed list page
    ]);
    assert.deepEqual(
      list.map((e) => (e.kind === "i9-person" ? `p${e.sortPage}` : `page${(e as { page: number }).page}`)),
      ["p2", "page4", "p6"],
    );
  });
});

describe("i9SectionPages", () => {
  it("returns EVERY page a section renders — both pages of a paired person", () => {
    const list = build([
      row(S1({ sourcePage: 9, section2Page: 1 }), 0),
      row(S2({ sourcePage: 5 }), 1),
    ]);
    assert.deepEqual([...i9SectionPages(list)].sort((a, b) => a - b), [1, 5, 9]);
  });
});
