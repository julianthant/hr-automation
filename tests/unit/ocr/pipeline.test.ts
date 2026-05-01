import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { runOcrPipeline } from "../../../src/ocr/pipeline.js";
import { __setPerPageCallForTests } from "../../../src/ocr/per-page.js";

const RecordSchema = z.object({ name: z.string() });
const ArraySchema = z.array(RecordSchema);

function makeTmpPdfDir(): { pdfPath: string; pageImagesDir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `ocr-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, "scan.pdf");
  writeFileSync(pdfPath, "%PDF-1.4 stub", "utf-8");
  const pageImagesDir = join(dir, "page-images");
  mkdirSync(pageImagesDir, { recursive: true });
  writeFileSync(join(pageImagesDir, "page-01.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(pageImagesDir, "page-02.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(pageImagesDir, "page-03.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    pdfPath,
    pageImagesDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("runOcrPipeline returns per-page status with success and failure flags", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  __setPerPageCallForTests(async ({ pageNum }) => {
    if (pageNum === 2) throw new Error("simulated 429 rate limit");
    return { json: [{ name: `page-${pageNum}` }], poolKeyId: "test-1" };
  });
  try {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: RecordSchema,
      arraySchema: ArraySchema,
      prompt: "test",
      schemaName: "Test",
      _renderOverride: async () => ["page-01.png", "page-02.png", "page-03.png"],
      _poolOverride: [
        { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
      ],
    });
    assert.equal(result.pages.length, 3, "all 3 pages reported");
    assert.equal(result.pages[0].success, true);
    assert.equal(result.pages[1].success, false);
    assert.equal(result.pages[1].error, "simulated 429 rate limit");
    assert.equal(result.pages[2].success, true);
    assert.equal(result.data.length, 2, "only successful pages contribute records");
  } finally {
    __setPerPageCallForTests(undefined);
    cleanup();
  }
});

test("runOcrPipeline does NOT auto-fall-back to whole-PDF on partial failure", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  let wholePdfCalled = false;
  __setPerPageCallForTests(async () => {
    throw new Error("everything throttled");
  });
  try {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: RecordSchema,
      arraySchema: ArraySchema,
      prompt: "test",
      schemaName: "Test",
      _renderOverride: async () => ["page-01.png", "page-02.png"],
      _poolOverride: [
        { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
      ],
      _wholePdfOverride: async () => {
        wholePdfCalled = true;
        return { data: [], provider: "whole-pdf-stub", attempts: 1, cached: false };
      },
    });
    assert.equal(wholePdfCalled, false, "whole-PDF fallback must not be invoked");
    assert.equal(result.data.length, 0);
    assert.equal(result.pages.every((p) => !p.success), true);
  } finally {
    __setPerPageCallForTests(undefined);
    cleanup();
  }
});

test("runOcrPipeline fails the row when zero pages render", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  try {
    await assert.rejects(
      runOcrPipeline({
        pdfPath,
        pageImagesDir,
        recordSchema: RecordSchema,
        arraySchema: ArraySchema,
        prompt: "test",
        schemaName: "Test",
        _renderOverride: async () => [],
        _poolOverride: [
          { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
        ],
      }),
      /PDF page render failed/,
    );
  } finally {
    cleanup();
  }
});

test("runOcrPipeline fails the row when pool is empty", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  try {
    await assert.rejects(
      runOcrPipeline({
        pdfPath,
        pageImagesDir,
        recordSchema: RecordSchema,
        arraySchema: ArraySchema,
        prompt: "test",
        schemaName: "Test",
        _renderOverride: async () => ["page-01.png"],
        _poolOverride: [],
      }),
      /no vision API keys configured/i,
    );
  } finally {
    cleanup();
  }
});
