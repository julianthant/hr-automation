import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { emitTrackerRow } from "../../../src/tracker/jsonl.js";
import { findFrozenTraceId } from "../../../src/tracker/find-latest-entry.js";

/**
 * `findFrozenTraceId` reads back the trace id stamped on a run's first row so a
 * later re-emit (daemon worker re-emitting `pending`, or a cancel/shutdown
 * rebuild) reuses the exact id rather than minting a fresh, time-drifted one.
 */
describe("findFrozenTraceId", () => {
  it("returns the trace id frozen on an earlier row for the same runId", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "frozen-trace-"));
    try {
      emitTrackerRow(
        {
          workflow: "oath-upload",
          timestamp: new Date().toISOString(),
          id: "item-1",
          runId: "174b838e-2b62-4c07-ba99-637976a38a4c",
          status: "pending",
          data: { archetype: "single", queueRowKind: "file", __traceId: "ou-053126155036-174b" },
        },
        dir,
      );

      const frozen = findFrozenTraceId({
        workflow: "oath-upload",
        runId: "174b838e-2b62-4c07-ba99-637976a38a4c",
        trackerDir: dir,
      });
      assert.equal(frozen, "ou-053126155036-174b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no prior row for the run carries a trace id", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "frozen-trace-"));
    try {
      emitTrackerRow(
        {
          workflow: "oath-upload",
          timestamp: new Date().toISOString(),
          id: "item-1",
          runId: "run-without-trace",
          status: "pending",
          data: { archetype: "single", queueRowKind: "file" },
        },
        dir,
      );

      const frozen = findFrozenTraceId({
        workflow: "oath-upload",
        runId: "run-without-trace",
        trackerDir: dir,
      });
      assert.equal(frozen, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match a different run's frozen trace id", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "frozen-trace-"));
    try {
      emitTrackerRow(
        {
          workflow: "oath-upload",
          timestamp: new Date().toISOString(),
          id: "item-1",
          runId: "run-A",
          status: "pending",
          data: { archetype: "single", queueRowKind: "file", __traceId: "ou-053126155036-aaaa" },
        },
        dir,
      );

      const frozen = findFrozenTraceId({
        workflow: "oath-upload",
        runId: "run-B",
        trackerDir: dir,
      });
      assert.equal(frozen, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
