import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldApplyEntriesUpdate } from "../../../src/dashboard/components/hooks/useEntries.js";

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
