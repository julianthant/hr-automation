import { test } from "node:test";
import assert from "node:assert/strict";

import { appendCappedLogs, capLogWindow, RAW_LOGS_CAP } from "../../../src/dashboard/components/hooks/useLogs.js";
import type { LogEntry } from "../../../src/dashboard/components/shared/types.js";

function logAt(i: number): LogEntry {
  return {
    workflow: "ocr",
    itemId: "item-1",
    runId: "item-1#1",
    level: "step",
    message: `line ${i}`,
    ts: `2026-05-14T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
  };
}

test("capLogWindow retains only the newest raw log window", () => {
  const logs = Array.from({ length: RAW_LOGS_CAP + 3 }, (_, i) => logAt(i));

  const capped = capLogWindow(logs);

  assert.equal(capped.length, RAW_LOGS_CAP);
  assert.equal(capped[0]?.message, "line 3");
  assert.equal(capped.at(-1)?.message, `line ${RAW_LOGS_CAP + 2}`);
});

test("appendCappedLogs caps after merging SSE deltas", () => {
  const prev = Array.from({ length: RAW_LOGS_CAP - 1 }, (_, i) => logAt(i));
  const next = [logAt(RAW_LOGS_CAP), logAt(RAW_LOGS_CAP + 1)];

  const capped = appendCappedLogs(prev, next);

  assert.equal(capped.length, RAW_LOGS_CAP);
  assert.equal(capped[0]?.message, "line 1");
  assert.equal(capped.at(-1)?.message, `line ${RAW_LOGS_CAP + 1}`);
});
