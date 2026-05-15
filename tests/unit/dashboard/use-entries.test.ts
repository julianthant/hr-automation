import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { shouldApplyEntriesUpdate } from "../../../src/dashboard/components/hooks/useEntries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("shouldApplyEntriesUpdate applies an empty first payload for a new date key", () => {
  const shouldApply = shouldApplyEntriesUpdate({
    activeKey: "active-check|2026-05-08",
    targetKey: "active-check|2026-05-07",
    previousHash: "",
    nextHash: "",
  });

  assert.equal(shouldApply, true);
});

test("shouldApplyEntriesUpdate skips unchanged payloads once the active key is current", () => {
  const shouldApply = shouldApplyEntriesUpdate({
    activeKey: "active-check|2026-05-07",
    targetKey: "active-check|2026-05-07",
    previousHash: "",
    nextHash: "",
  });

  assert.equal(shouldApply, false);
});

test("useEntries updates aggregate SSE state only once per delivery", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/dashboard/components/hooks/useEntries.ts"),
    "utf8",
  );

  assert.equal(source.match(/\bsetWorkflows\(/g)?.length ?? 0, 1);
  assert.equal(source.match(/\bsetWfCounts\(/g)?.length ?? 0, 1);
  assert.equal(source.match(/\bsetFailureCounts\(/g)?.length ?? 0, 1);
});
