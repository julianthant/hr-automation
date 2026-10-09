import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeRun } from "../../../../src/services/llm/summarize-run.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "summarize-"));
}

function fakePool(reply: string, seen: { prompt?: string }): TextPoolKey[] {
  return [
    {
      id: "gemini-1",
      providerId: "gemini",
      keyIndex: 1,
      rotationKey: "k",
      priority: 1,
      models: [{ id: "m", limit: { rpm: 10, tpm: 250_000, rpd: 250, imgTokens: 1000 }, tier: 2, trust: "unbenchmarked" }],
      callText: async (prompt) => {
        seen.prompt = prompt;
        return { text: reply };
      },
    },
  ];
}

const REPLY = JSON.stringify({
  summary: "The separation ran through Kuali and finalized the transaction.",
  outcome: "completed",
  highlights: ["Kuali doc 4361 finalized", "UCPath Smart HR submitted"],
});

test("summarizeRun returns a structured digest and passes the log + workflow into the prompt", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await summarizeRun(
      { logText: '{"message":"Kuali finalize"}\n{"message":"UCPath submit"}', workflow: "separations" },
      { pool: fakePool(REPLY, seen), cacheDir: dir },
    );
    assert.ok(out);
    assert.equal(out.outcome, "completed");
    assert.match(out.summary, /Kuali/);
    assert.equal(out.highlights.length, 2);
    assert.match(seen.prompt ?? "", /Workflow: separations/);
    assert.match(seen.prompt ?? "", /Kuali finalize/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun returns null for empty log text without calling the pool", async () => {
  __resetUsageTrackerForTests();
  const seen: { prompt?: string } = {};
  const out = await summarizeRun({ logText: "   " }, { pool: fakePool(REPLY, seen) });
  assert.equal(out, null);
  assert.equal(seen.prompt, undefined);
});

test("summarizeRun returns null when the pool is exhausted", async () => {
  __resetUsageTrackerForTests();
  const out = await summarizeRun({ logText: "some log" }, { pool: [] });
  assert.equal(out, null);
});

test("summarizeRun returns null when the reply outcome is invalid", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await summarizeRun(
      { logText: "log" },
      { pool: fakePool('{"summary":"x","outcome":"exploded","highlights":[]}', seen), cacheDir: dir },
    );
    assert.equal(out, null, "outcome not in the enum → schema rejects");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
