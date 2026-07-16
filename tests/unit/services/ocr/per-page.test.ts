import { test } from "vitest";
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
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

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

test("runOcrPerPage preserves LLM-supplied employeeSigned and does NOT default an omitted one to true", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "signed", employeeSigned: true },
      { name: "unsigned", employeeSigned: false },
      { name: "omitted" },
    ],
    poolKeyId: "test-1",
  }));
  try {
    // The real oath schema is `.nullable().optional()`, so an omitted value is
    // KEPT (not dropped) — and must stay undefined, never forced to `true`.
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
      employeeSigned: z.boolean().optional(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 3);
    assert.equal(out.records[0].employeeSigned, true);
    assert.equal(out.records[1].employeeSigned, false, "LLM-supplied false is preserved");
    assert.equal(
      out.records[2].employeeSigned,
      undefined,
      "omitted employeeSigned is NOT defaulted to true (fail-safe: absent = not signed)",
    );
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage does NOT inject employeeSigned:true when the LLM omits it (fail-safe)", async () => {
  __setPerPageCallForTests(async () => ({
    json: [{ name: "x" }],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
      employeeSigned: z.boolean().optional(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 1);
    assert.equal(
      out.records[0].employeeSigned,
      undefined,
      "an omitted signature stays undefined — a blank signature line must never be recorded as signed",
    );
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

// ─── Loud schema-drop tests ─────────────────────────────────────────────────
//
// Regression guard for the "zero records, silent empty page" pattern:
// when ALL records on a page are dropped by schema validation, the page should
// surface as a FAILED page (success:false + diagnostic error) rather than an
// opaque empty page.  This ensures clearly-filled forms are never silently
// hidden from the operator; the orchestrator's emptyPages vs failedPages
// classification will show the page as a failure with a reason.

test("runOcrPerPage: all records schema-invalid → page marked failed, not silently empty", async () => {
  // Every record on page 1 fails schema (missing required `name`).
  // The page API call succeeded (the test fn returns OK), but all records are
  // dropped.  The page must become success:false with a schema-drop diagnostic.
  __setPerPageCallForTests(async () => ({
    json: [
      { not_name: "invalid-a" },   // missing required `name`
      { not_name: "invalid-b" },   // missing required `name`
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
    // No records extracted — all were schema-invalid.
    assert.equal(out.records.length, 0, "no valid records should survive");
    // The page must be FAILED (not success:true with 0 records = silent empty).
    assert.equal(out.pages[0].success, false, "page with all-schema-dropped records must be marked failed");
    // The error message must be diagnostic, not a generic network/timeout error.
    assert.ok(
      out.pages[0].error?.includes("schema validation"),
      `error should mention "schema validation", got: "${out.pages[0].error}"`,
    );
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage: mixed valid+invalid records → page stays successful (partial extraction OK)", async () => {
  // Page has 2 records: one valid, one schema-invalid.
  // The valid one survives; the page must NOT be marked failed because at least
  // one record was extracted successfully.
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "valid-record" },    // passes schema
      { not_name: "invalid" },     // fails schema
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
    assert.equal(out.records.length, 1, "valid record survives");
    assert.equal(out.records[0].name, "valid-record");
    // Page is still a success: partial extraction is OK; only all-drop is a failure.
    assert.equal(out.pages[0].success, true, "page with at least one valid record must stay successful");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage: truly empty LLM response (zero records returned) → page stays successful/empty (not schema-drop)", async () => {
  // The LLM returned no records at all (e.g. a blank page).
  // This is NOT the same as schema-drop: the LLM saw nothing, so the page
  // shows as a normal empty page (for the operator to see the page image
  // and optionally add a row manually).
  __setPerPageCallForTests(async () => ({
    json: [],
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
    assert.equal(out.records.length, 0);
    // No schema drops → page stays success:true (the orchestrator shows it as
    // an empty page with the page image, not as a failure).
    assert.equal(out.pages[0].success, true, "a genuinely empty LLM response is not a failure");
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
      priority: 1,
      // Single-model chain so a 429 throttles the whole key and the next page
      // rotates to the other key (the behavior this test pins).
      models: [{ id: "gemini-2.5-flash", limit: { rpm: 1000, tpm: 1_000_000, rpd: 1000, imgTokens: 1 } }],
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
        return { json: [{ name: `${prompt}-${id}` }] };
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

test("runOcrPerPage composes operator cancellation into an in-flight provider request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "per-page-abort-"));
  const started = Promise.withResolvers<AbortSignal>();
  const controller = new AbortController();
  const pool: PoolKey[] = [{
    id: "gemini-1",
    providerId: "gemini",
    keyIndex: 1,
    rotationKey: "test-key",
    priority: 1,
    models: [{ id: "gemini-3-flash-preview", limit: { rpm: 10, tpm: 10_000, rpd: 100, imgTokens: 100 } }],
    callOcr: async (_imagePath, _prompt, _model, signal) => {
      assert.ok(signal, "provider attempt receives a composed AbortSignal");
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  }];
  try {
    const run = runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: RecordSchema,
      pool,
      cacheDir: dir,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("operator cancelled OCR"));
    await assert.rejects(run, /operator cancelled OCR/);
  } finally {
    __resetUsageTrackerForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOcrPerPage bounds a hung provider attempt with its per-attempt timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "per-page-attempt-timeout-"));
  const prior = process.env.OCR_PROVIDER_ATTEMPT_TIMEOUT_MS;
  process.env.OCR_PROVIDER_ATTEMPT_TIMEOUT_MS = "10";
  const pool: PoolKey[] = [{
    id: "gemini-1",
    providerId: "gemini",
    keyIndex: 1,
    rotationKey: "test-key",
    priority: 1,
    models: [{ id: "gemini-3-flash-preview", limit: { rpm: 10, tpm: 10_000, rpd: 100, imgTokens: 100 } }],
    callOcr: async (_imagePath, _prompt, _model, signal) => {
      assert.ok(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  }];
  try {
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: RecordSchema,
      pool,
      cacheDir: dir,
    });
    assert.equal(out.pages[0]?.success, false);
    assert.match(out.pages[0]?.error ?? "", /timeout|aborted/i);
    assert.equal(out.pages[0]?.attempts, 1);
  } finally {
    if (prior === undefined) delete process.env.OCR_PROVIDER_ATTEMPT_TIMEOUT_MS;
    else process.env.OCR_PROVIDER_ATTEMPT_TIMEOUT_MS = prior;
    __resetUsageTrackerForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
