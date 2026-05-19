import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFormType,
  readParentRunId,
  readOriginWorkflow,
  readDryRun,
} from "../../../../src/tracker/dashboard/ocr/shared.js";

function yesterdayLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function makeOcrRow(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id,
    runId: `${id}#1`,
    status: "done",
    step: "awaiting-approval",
    data: {
      formType: "oath",
      originWorkflow: "oath-upload",
      dryRun: "false",
    },
    parentRunId: "parent-run-abc",
    ...overrides,
  });
}

describe("ocr shared readers — cross-day JSONL walk", () => {
  test("readFormType finds session written to yesterday's JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      appendFileSync(join(dir, `ocr-${yesterdayLocal()}.jsonl`), makeOcrRow("sess-1") + "\n");
      assert.equal(readFormType("sess-1", dir), "oath");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("readParentRunId finds session written to yesterday's JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      appendFileSync(join(dir, `ocr-${yesterdayLocal()}.jsonl`), makeOcrRow("sess-2") + "\n");
      assert.equal(readParentRunId("sess-2", dir), "parent-run-abc");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("readOriginWorkflow finds session written to yesterday's JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      appendFileSync(join(dir, `ocr-${yesterdayLocal()}.jsonl`), makeOcrRow("sess-3") + "\n");
      assert.equal(readOriginWorkflow("sess-3", dir), "oath-upload");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("readDryRun finds session written to yesterday's JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      appendFileSync(
        join(dir, `ocr-${yesterdayLocal()}.jsonl`),
        makeOcrRow("sess-4", { data: { dryRun: "true" } }) + "\n",
      );
      assert.equal(readDryRun("sess-4", dir), true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("readFormType returns null when session not found in any day", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      assert.equal(readFormType("nonexistent", dir), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("readDryRun returns false when dryRun is 'false'", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
    try {
      appendFileSync(join(dir, `ocr-${yesterdayLocal()}.jsonl`), makeOcrRow("sess-5") + "\n");
      assert.equal(readDryRun("sess-5", dir), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
