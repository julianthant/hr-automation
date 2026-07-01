import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestSelectors } from "../../../../src/services/llm/selector-suggest.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "selector-"));
}

function fakePool(reply: string, seen: { prompt?: string }): TextPoolKey[] {
  return [
    {
      id: "gemini-1",
      providerId: "gemini",
      keyIndex: 1,
      rotationKey: "k",
      priority: 1,
      models: [{ id: "m", limit: { rpm: 10, tpm: 250_000, rpd: 250, imgTokens: 1000 } }],
      callText: async (prompt) => {
        seen.prompt = prompt;
        return { text: reply };
      },
    },
  ];
}

const REPLY = JSON.stringify({
  candidates: [
    { selector: "getByRole('button',{name:'Save'})", rationale: "A button role named Save is present.", confidence: 0.9 },
    { selector: "getByText('Save')", rationale: "Fallback text match.", confidence: 0.5 },
  ],
});

test("suggestSelectors returns ranked candidates and includes intent + snapshot in the prompt", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await suggestSelectors(
      {
        snapshot: "- button 'Save' [ref=e12]\n- textbox 'Employee ID' [ref=e5]",
        intent: "the Save button",
        current: "button.oldSave",
      },
      { pool: fakePool(REPLY, seen), cacheDir: dir },
    );
    assert.ok(out);
    assert.equal(out.length, 2);
    assert.equal(out[0].selector, "getByRole('button',{name:'Save'})");
    assert.ok(out[0].confidence > out[1].confidence, "ranked most-likely first");
    assert.match(seen.prompt ?? "", /the Save button/);
    assert.match(seen.prompt ?? "", /button 'Save'/);
    assert.match(seen.prompt ?? "", /button\.oldSave/, "current selector included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestSelectors returns null for missing snapshot or intent (no pool call)", async () => {
  __resetUsageTrackerForTests();
  const seen: { prompt?: string } = {};
  assert.equal(await suggestSelectors({ snapshot: "", intent: "x" }, { pool: fakePool(REPLY, seen) }), null);
  assert.equal(await suggestSelectors({ snapshot: "y", intent: "  " }, { pool: fakePool(REPLY, seen) }), null);
  assert.equal(seen.prompt, undefined, "short-circuits before any call");
});

test("suggestSelectors returns null when the pool is exhausted", async () => {
  __resetUsageTrackerForTests();
  const out = await suggestSelectors({ snapshot: "- button 'Save'", intent: "save" }, { pool: [] });
  assert.equal(out, null);
});

test("suggestSelectors returns [] when the model finds no match", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await suggestSelectors(
      { snapshot: "- heading 'Nothing here'", intent: "the Save button" },
      { pool: fakePool('{"candidates":[]}', seen), cacheDir: dir },
    );
    assert.deepEqual(out, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
