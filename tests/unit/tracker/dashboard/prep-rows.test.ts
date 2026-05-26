import { test } from "vitest";
import assert from "node:assert/strict";

import {
  isDelegatedOcrAwaitingApprovalEntry,
  isOcrAwaitingApprovalEntry,
} from "../../../../src/tracker/dashboard/prep-rows.js";

test("isDelegatedOcrAwaitingApprovalEntry is true only for delegated OCR rows", () => {
  // New approval contract (2026-05-25): OCR awaiting-approval rows carry
  // status="running" (not terminal "done"). They flip to "done" only when
  // the operator approves.
  const standalone: Parameters<typeof isDelegatedOcrAwaitingApprovalEntry>[0] = {
    workflow: "ocr",
    id: "s1",
    runId: "s1#1",
    timestamp: "2026-05-12T12:00:00.000Z",
    status: "running",
    step: "awaiting-approval",
    data: { mode: "prepare" },
  };
  assert.equal(isOcrAwaitingApprovalEntry(standalone), true);
  assert.equal(isDelegatedOcrAwaitingApprovalEntry(standalone), false);

  const delegated: typeof standalone = {
    ...standalone,
    id: "s2",
    runId: "s2#1",
    parentRunId: "upload-parent-run",
  };
  assert.equal(isOcrAwaitingApprovalEntry(delegated), true);
  assert.equal(isDelegatedOcrAwaitingApprovalEntry(delegated), true);
});
