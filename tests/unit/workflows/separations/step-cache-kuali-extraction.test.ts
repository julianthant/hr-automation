import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepCacheSet, stepCacheGet } from "../../../../src/core/step-cache.js";

describe("separations step-cache for kuali-extraction", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sep-cache-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("round-trips separation data through the cache", async () => {
    const doc = "3917";
    const data = {
      employeeName: "Sutisna, Reyhan",
      eid: "10835489",
      separationDate: "04/20/2026",
      lastDayWorked: "04/20/2026",
      terminationType: "Vol",
    };

    await stepCacheSet("separations", doc, "kuali-extraction", data, { dir: tmpDir });
    const read = await stepCacheGet("separations", doc, "kuali-extraction", { dir: tmpDir });

    assert.deepStrictEqual(read, data);
  });

  it("returns null on cache miss", async () => {
    const read = await stepCacheGet("separations", "9999", "kuali-extraction", { dir: tmpDir });
    assert.strictEqual(read, null);
  });
});
