import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import {
  runOcrPerPage,
  __setPerPageCallForTests,
} from "../../../src/ocr/per-page.js";

const RecordSchema = z.object({ name: z.string() });

test("runOcrPerPage preserves page order under out-of-order completion", async () => {
  const completionOrder: number[] = [];
  __setPerPageCallForTests(async ({ pageNum }) => {
    // Page 3 finishes before page 1; page 2 last.
    const delays: Record<number, number> = { 1: 30, 2: 50, 3: 5 };
    await new Promise((r) => setTimeout(r, delays[pageNum] ?? 10));
    completionOrder.push(pageNum);
    return {
      json: [{ name: `page-${pageNum}-record` }],
      keyIndex: 1,
    };
  });
  try {
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png", "page-02.png", "page-03.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: RecordSchema,
    });
    assert.equal(out.records.length, 3);
    assert.equal(out.records[0].sourcePage, 1);
    assert.equal(out.records[1].sourcePage, 2);
    assert.equal(out.records[2].sourcePage, 3);
    assert.equal(out.records[0].name, "page-1-record");
    assert.deepEqual(
      completionOrder.slice().sort(),
      [1, 2, 3],
      "all pages should run",
    );
    // Page 3 must have completed BEFORE page 1 to prove parallelism.
    const idx1 = completionOrder.indexOf(1);
    const idx3 = completionOrder.indexOf(3);
    assert.ok(idx3 < idx1, "page 3 should finish before page 1");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage records per-page failure without aborting the batch", async () => {
  __setPerPageCallForTests(async ({ pageNum }) => {
    if (pageNum === 2) throw new Error("simulated 429 rate limit");
    return { json: [{ name: `page-${pageNum}` }], keyIndex: 1 };
  });
  try {
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png", "page-02.png", "page-03.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: RecordSchema,
    });
    assert.equal(out.records.length, 2, "page 2 dropped");
    assert.equal(out.records[0].sourcePage, 1);
    assert.equal(out.records[1].sourcePage, 3);
    assert.equal(out.pages[0].success, true);
    assert.equal(out.pages[1].success, false);
    assert.match(out.pages[1].error ?? "", /rate limit/i);
    assert.equal(out.pages[2].success, true);
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage filters records that fail schema validation", async () => {
  __setPerPageCallForTests(async ({ pageNum }) => {
    return {
      json: [
        { name: `valid-${pageNum}` },
        { not_name: "invalid" }, // wrong shape
      ],
      keyIndex: 1,
    };
  });
  try {
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: RecordSchema,
    });
    assert.equal(out.records.length, 1, "only valid record kept");
    assert.equal(out.records[0].name, "valid-1");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});
