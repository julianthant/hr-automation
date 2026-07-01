import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triageFailure, summarizeTriage } from "../../../../src/services/llm/triage.js";
import type { TriageResult } from "../../../../src/services/llm/triage.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "triage-"));
}

/** Fake pool that records the prompt it was called with and returns a fixed reply. */
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

const VALID = JSON.stringify({
  category: "auth-session",
  cause: "The UCPath session expired and redirected to SSO.",
  suggestedRecovery: "Re-authenticate and retry the run.",
  retriable: true,
  confidence: 0.9,
});

test("triageFailure returns a structured triage and echoes run context into the prompt", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await triageFailure(
      {
        rawError: "page.goto: Timeout 30000ms exceeded — navigated to login.ucsd.edu",
        workflow: "separations",
        step: "transaction",
        systemId: "ucpath",
      },
      { pool: fakePool(VALID, seen), cacheDir: dir },
    );
    assert.ok(out);
    assert.equal(out.category, "auth-session");
    assert.equal(out.retriable, true);
    assert.match(out.cause, /session expired/i);
    // Context threaded into the prompt.
    assert.match(seen.prompt ?? "", /Workflow: separations/);
    assert.match(seen.prompt ?? "", /Step: transaction/);
    assert.match(seen.prompt ?? "", /System: ucpath/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triageFailure returns null for a blank error without calling the pool", async () => {
  __resetUsageTrackerForTests();
  const seen: { prompt?: string } = {};
  const out = await triageFailure({ rawError: "   " }, { pool: fakePool(VALID, seen) });
  assert.equal(out, null);
  assert.equal(seen.prompt, undefined, "blank error short-circuits before any call");
});

test("triageFailure returns null when the pool is exhausted (no keys)", async () => {
  __resetUsageTrackerForTests();
  const out = await triageFailure({ rawError: "boom" }, { pool: [] });
  assert.equal(out, null);
});

test("triageFailure returns null when the reply fails schema validation", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const seen: { prompt?: string } = {};
    const out = await triageFailure(
      { rawError: "boom" },
      { pool: fakePool('{"category":"not-a-category"}', seen), cacheDir: dir },
    );
    assert.equal(out, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeTriage renders a compact one-liner", () => {
  const t: TriageResult = {
    category: "network",
    cause: "DNS lookup failed for the host.",
    suggestedRecovery: "Check the VPN and retry.",
    retriable: true,
    confidence: 0.8,
  };
  const s = summarizeTriage(t);
  assert.match(s, /\[network, retriable\]/);
  assert.match(s, /DNS lookup failed/);
  assert.match(s, /→ Check the VPN/);
});
