import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  runOcrPerPage,
  __setPerPageCallForTests,
} from "../../../../src/services/ocr/per-page.js";
import type { PoolKey } from "../../../../src/services/ocr/per-page-pool.js";
import { __resetKeyRotationCacheForTests } from "../../../../src/services/ocr/rotation.js";

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
      poolKeyId: "test-1",
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
    return { json: [{ name: `page-${pageNum}` }], poolKeyId: "test-1" };
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
      poolKeyId: "test-1",
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

test("runOcrPerPage synthesizes rowIndex from array position when LLM omits it", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "first" },                    // rowIndex omitted
      { name: "second", rowIndex: 99 },     // LLM-supplied wins
      { name: "third" },                    // rowIndex omitted
    ],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      rowIndex: z.number().int().nonnegative(),
      name: z.string(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 3);
    assert.equal(out.records[0].rowIndex, 0, "first record gets rowIndex 0");
    assert.equal(out.records[1].rowIndex, 99, "LLM-supplied rowIndex wins over default");
    assert.equal(out.records[2].rowIndex, 2, "third record gets rowIndex 2");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage preserves LLM-supplied employeeSigned: false over the default", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "signed", employeeSigned: true },
      { name: "unsigned", employeeSigned: false },
      { name: "omitted" },
    ],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
      employeeSigned: z.boolean(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 3);
    assert.equal(out.records[0].employeeSigned, true);
    assert.equal(out.records[1].employeeSigned, false, "LLM-supplied false beats default true");
    assert.equal(out.records[2].employeeSigned, true, "default applies when omitted");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage defaults employeeSigned to true when LLM omits it", async () => {
  __setPerPageCallForTests(async () => ({
    json: [{ name: "x" }],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
      employeeSigned: z.boolean(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].employeeSigned, true, "default is true when LLM omits");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage still drops records that fail schema even with defaults", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "ok" },
      "not an object",          // truly garbage
      { wrongShape: true },     // missing required `name`
    ],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 1, "only the valid record survives");
    assert.equal(out.records[0].name, "ok");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("concurrent per-page Gemini runs share in-memory key throttle state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "per-page-rotation-"));
  const firstCallRateLimited = Promise.withResolvers<void>();
  const releaseFirstCall = Promise.withResolvers<void>();
  __resetKeyRotationCacheForTests();
  const seenByPrompt = new Map<string, string[]>();
  const makeKey = (id: "gemini-1" | "gemini-2", rotationKey: string): PoolKey =>
    ({
      id,
      providerId: "gemini",
      keyIndex: id === "gemini-1" ? 1 : 2,
      rotationKey,
      callOcr: async (_imagePath: string, prompt: string) => {
        const seen = seenByPrompt.get(prompt) ?? [];
        seen.push(id);
        seenByPrompt.set(prompt, seen);
        if (prompt === "Call A" && id === "gemini-1") {
          firstCallRateLimited.resolve();
          throw new Error("429 Too Many Requests");
        }
        if (prompt === "Call A" && id === "gemini-2") {
          await releaseFirstCall.promise;
        }
        return [{ name: `${prompt}-${id}` }];
      },
    } as PoolKey);
  const pool = [makeKey("gemini-1", "k1"), makeKey("gemini-2", "k2")];
  try {
    const callA = runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "Call A",
      schema: RecordSchema,
      pool,
      cacheDir: dir,
    });
    await firstCallRateLimited.promise;
    const callB = runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "Call B",
      schema: RecordSchema,
      pool,
      cacheDir: dir,
    });
    const resultB = await callB;
    releaseFirstCall.resolve();
    const resultA = await callA;

    assert.deepEqual(seenByPrompt.get("Call B"), ["gemini-2"]);
    assert.equal(resultA.pages[0].success, true);
    assert.equal(resultB.pages[0].success, true);
  } finally {
    releaseFirstCall.resolve();
    __resetKeyRotationCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
