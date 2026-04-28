import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  ocrDocument,
  __setProviderForTests,
  __setCacheDirForTests,
  type OcrProvider,
  type OcrResult,
} from "../../../src/ocr/index.js";
import { OcrProviderError } from "../../../src/ocr/types.js";

const Sample = z.array(z.object({ name: z.string(), age: z.number().int() }));
type SampleT = z.infer<typeof Sample>;

// Returns `OcrResult<never>` so the call signature `<T>` accepts it without
// casting at every callsite. Tests inspect r.data via deepEqual on the runtime
// value, so the structural type is irrelevant.
function happyResult(data: unknown): OcrResult<never> {
  return {
    data: data as never,
    rawText: JSON.stringify(data),
    pageCount: 1,
    provider: "gemini",
    keyIndex: 1,
    attempts: 1,
    cached: false,
    durationMs: 50,
  };
}

describe("ocrDocument — happy path", () => {
  let tmp: string;
  let pdfPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-idx-"));
    pdfPath = join(tmp, "fake.pdf");
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    __setCacheDirForTests(join(tmp, "cache"));
    process.env.GEMINI_API_KEY = "fake-gemini-key";
  });
  afterEach(() => {
    __setCacheDirForTests(undefined);
    __setProviderForTests(undefined);
    delete process.env.GEMINI_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("calls provider, validates, and returns typed data", async () => {
    let callCount = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: async () => {
        callCount += 1;
        return happyResult([{ name: "Alice", age: 30 }]);
      },
    };
    __setProviderForTests(fake);
    const r = await ocrDocument({
      pdfPath,
      schema: Sample,
      schemaName: "Person",
    });
    assert.deepEqual(r.data, [{ name: "Alice", age: 30 }]);
    assert.equal(callCount, 1);
    assert.equal(r.cached, false);
    assert.equal(r.provider, "gemini");
  });

  it("hits the cache on second call (cached: true)", async () => {
    let callCount = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: async () => {
        callCount += 1;
        return happyResult([{ name: "Alice", age: 30 }]);
      },
    };
    __setProviderForTests(fake);
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    const r2 = await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    assert.equal(r2.cached, true);
    assert.equal(callCount, 1);
  });

  it("respects bustCache: true", async () => {
    let callCount = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: async () => {
        callCount += 1;
        return happyResult([{ name: "Alice", age: 30 }]);
      },
    };
    __setProviderForTests(fake);
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person", bustCache: true });
    assert.equal(callCount, 2);
  });
});

describe("ocrDocument — validation retry", () => {
  let tmp: string;
  let pdfPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-val-"));
    pdfPath = join(tmp, "fake.pdf");
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    __setCacheDirForTests(join(tmp, "cache"));
    process.env.GEMINI_API_KEY = "fake-gemini-key";
  });
  afterEach(() => {
    __setCacheDirForTests(undefined);
    __setProviderForTests(undefined);
    delete process.env.GEMINI_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retries once on schema-validation failure, then succeeds", async () => {
    let calls = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: async () => {
        calls += 1;
        if (calls === 1) {
          // Wrong shape — age as string
          return happyResult([{ name: "Alice", age: "not-a-number" }] as unknown as SampleT);
        }
        return happyResult([{ name: "Alice", age: 30 }]);
      },
    };
    __setProviderForTests(fake);
    const r = await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    assert.deepEqual(r.data, [{ name: "Alice", age: 30 }]);
    assert.equal(calls, 2);
  });

  it("throws OcrValidationError after retries exhausted", async () => {
    const fake: OcrProvider = {
      id: "gemini",
      call: async () =>
        happyResult([{ name: "Alice", age: "not-a-number" }] as unknown as SampleT),
    };
    __setProviderForTests(fake);
    await assert.rejects(
      ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" }),
      /OcrValidationError|validation/i,
    );
  });
});

describe("ocrDocument — provider rotation", () => {
  let tmp: string;
  let pdfPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-rot-"));
    pdfPath = join(tmp, "fake.pdf");
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    __setCacheDirForTests(join(tmp, "cache"));
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY2 = "k2";
  });
  afterEach(() => {
    __setCacheDirForTests(undefined);
    __setProviderForTests(undefined);
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY2;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rotates past a rate-limited key", async () => {
    const usedIndices: number[] = [];
    let calls = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: async (_req, key) => {
        calls += 1;
        usedIndices.push(key.index);
        if (calls === 1) {
          throw new OcrProviderError("429 rate limit", "rate-limit", 429);
        }
        return happyResult([{ name: "Alice", age: 30 }]);
      },
    };
    __setProviderForTests(fake);
    const r = await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    assert.equal(r.data[0].name, "Alice");
    // First attempt used key 1, second used key 2 (rotation past throttled).
    assert.deepEqual(usedIndices, [1, 2]);
  });

  it("throws OcrAllKeysExhaustedError when every key is dead", async () => {
    const fake: OcrProvider = {
      id: "gemini",
      call: async () => {
        throw new OcrProviderError("401 invalid api key", "auth", 401);
      },
    };
    __setProviderForTests(fake);
    await assert.rejects(
      ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" }),
      /exhausted/i,
    );
  });
});
