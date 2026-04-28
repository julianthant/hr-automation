import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, readCache, writeCache } from "../../../src/ocr/cache.js";
import type { OcrResult } from "../../../src/ocr/types.js";

describe("computeCacheKey", () => {
  it("returns a 64-char hex hash", () => {
    const key = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h",
      promptVersion: "v1",
    });
    assert.match(key, /^[a-f0-9]{64}$/);
  });
  it("differs when pdf bytes differ", () => {
    const a = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h",
      promptVersion: "v1",
    });
    const b = computeCacheKey({
      pdfBytes: Buffer.from("xyz"),
      schemaName: "X",
      schemaJsonHash: "h",
      promptVersion: "v1",
    });
    assert.notEqual(a, b);
  });
  it("differs when schemaName differs", () => {
    const a = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h",
      promptVersion: "v1",
    });
    const b = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "Y",
      schemaJsonHash: "h",
      promptVersion: "v1",
    });
    assert.notEqual(a, b);
  });
  it("differs when schemaJsonHash or promptVersion differs", () => {
    const a = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h1",
      promptVersion: "v1",
    });
    const b = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h2",
      promptVersion: "v1",
    });
    const c = computeCacheKey({
      pdfBytes: Buffer.from("abc"),
      schemaName: "X",
      schemaJsonHash: "h1",
      promptVersion: "v2",
    });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

describe("readCache / writeCache", () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-cache-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns undefined for missing key", () => {
    assert.equal(readCache(tmp, "missing-key"), undefined);
  });

  it("round-trips an OcrResult", () => {
    const key = "abc123";
    const sample: OcrResult<{ records: number[] }> = {
      data: { records: [1, 2, 3] },
      pageCount: 1,
      provider: "gemini",
      keyIndex: 0,
      attempts: 1,
      cached: false,
      durationMs: 100,
    };
    writeCache(tmp, key, sample);
    const out = readCache<{ records: number[] }>(tmp, key);
    assert.deepEqual(out?.data, { records: [1, 2, 3] });
  });
});
