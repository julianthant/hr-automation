import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import { stepCacheGet, stepCacheSet } from "../../../src/core/step-cache.js";
import type { SessionEvent } from "../../../src/tracker/session-events.js";

describe("stepCacheGet emits cache_hit", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "cache-emit-")); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  function readSessionEvents(): SessionEvent[] {
    const path = join(tmp, "sessions.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("emits one cache_hit event when the cache returns a hit", async () => {
    await stepCacheSet("onboarding", "alice@example.com", "extraction", { foo: 1 }, { dir: tmp });
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      const result = await stepCacheGet("onboarding", "alice@example.com", "extraction", { dir: tmp });
      assert.deepEqual(result, { foo: 1 });
    });
    const events = readSessionEvents();
    const cacheEvents = events.filter((e) => e.type === "cache_hit");
    assert.equal(cacheEvents.length, 1);
    assert.equal(cacheEvents[0].step, "extraction");
    assert.equal(cacheEvents[0].currentItemId, "alice@example.com");
    assert.equal(cacheEvents[0].runId, "alice@example.com#1");
  });

  it("emits no event when the cache misses", async () => {
    await withLogContext("onboarding", "bob@example.com", async () => {
      setLogRunId("bob@example.com#1");
      const result = await stepCacheGet("onboarding", "bob@example.com", "extraction", { dir: tmp });
      assert.equal(result, null);
    });
    const events = readSessionEvents();
    assert.equal(events.filter((e) => e.type === "cache_hit").length, 0);
  });

  it("emits no event when the cache file is corrupted", async () => {
    const cacheDir = join(tmp, "step-cache", "onboarding-carol@example.com");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "extraction.json"), "{not-valid-json");
    await withLogContext("onboarding", "carol@example.com", async () => {
      setLogRunId("carol@example.com#1");
      const result = await stepCacheGet("onboarding", "carol@example.com", "extraction", { dir: tmp });
      assert.equal(result, null);
    });
    const events = readSessionEvents();
    assert.equal(events.filter((e) => e.type === "cache_hit").length, 0);
  });
});
