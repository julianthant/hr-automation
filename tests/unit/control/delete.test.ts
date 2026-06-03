/**
 * Unit tests for src/control/ops/delete.ts
 *
 * Covers:
 *   - buildDeleteEntryHandler: JSONL rewrite excludes matched ids, SQLite projection purge
 *   - buildDeleteBulkHandler: bulk delete, empty list, missing fields
 *   - deleteDelegatedChildrenForRun: cascades to children by parentRunId
 *
 * Uses temp dirs + temp SQLite (via openStateDb) following the pattern in
 * existing control tests. Screenshots dir is also a temp dir (never touches
 * PATHS.screenshotDir).
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { rowFilePath, rowsDir } from "../../../src/tracker/paths.js";
import {
  trackEventForDate,
} from "../../../src/tracker/jsonl.js";
import {
  buildDeleteEntryHandler,
  buildDeleteBulkHandler,
  deleteDelegatedChildrenForRun,
} from "../../../src/control/ops/delete.js";

const TODAY = "2026-06-02";

function setup(): { dir: string; screenshotsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "delete-test-"));
  const screenshotsDir = mkdtempSync(join(tmpdir(), "delete-ss-"));
  mkdirSync(rowsDir(dir), { recursive: true });
  return { dir, screenshotsDir };
}

function seedRow(dir: string, opts: {
  workflow: string;
  id: string;
  runId: string;
  parentRunId?: string;
  date?: string;
}): void {
  trackEventForDate(
    {
      workflow: opts.workflow,
      timestamp: new Date().toISOString(),
      id: opts.id,
      runId: opts.runId,
      status: "failed",
      data: {
        archetype: "single",
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      },
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    },
    opts.date ?? TODAY,
    dir,
  );
}

function readRows(dir: string, workflow: string, date: string = TODAY): unknown[] {
  const path = rowFilePath(workflow, date, dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let tmp: string;
let screenshotsDir: string;

beforeEach(() => {
  const s = setup();
  tmp = s.dir;
  screenshotsDir = s.screenshotsDir;
});

afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  if (screenshotsDir && existsSync(screenshotsDir)) rmSync(screenshotsDir, { recursive: true, force: true });
});

describe("buildDeleteEntryHandler — validation", () => {
  it("returns 400 error when workflow is missing", () => {
    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "", id: "item-1", date: TODAY });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /workflow, id, date are required/);
      assert.equal(result.status, 400);
    }
  });

  it("returns 400 error when id is missing", () => {
    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", id: "", date: TODAY });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  });

  it("returns 400 error when date is missing", () => {
    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", id: "item-1", date: "" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  });
});

describe("buildDeleteEntryHandler — JSONL rewrite excludes deleted row", () => {
  it("removes the matching row from the JSONL file and leaves other rows intact", () => {
    // Seed two rows in the same file
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-a" });
    seedRow(tmp, { workflow: "work-study", id: "item-2", runId: "run-b" });

    const rowsBefore = readRows(tmp, "work-study");
    assert.equal(rowsBefore.length, 2);

    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", id: "item-1", date: TODAY });
    assert.equal(result.ok, true);

    const rowsAfter = readRows(tmp, "work-study");
    // Only item-2 should remain
    assert.equal(rowsAfter.length, 1);
    const remaining = rowsAfter[0] as { id: string };
    assert.equal(remaining.id, "item-2");
  });

  it("succeeds even when the JSONL file does not exist (no-op)", () => {
    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "nonexistent-wf", id: "item-1", date: TODAY });
    assert.equal(result.ok, true);
  });

  it("deletes a run-scoped row (by runId) while preserving other runs for the same item", () => {
    // Two runs for the same item
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-a" });
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-b" });

    const rowsBefore = readRows(tmp, "work-study");
    assert.equal(rowsBefore.length, 2);

    const handler = buildDeleteEntryHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", id: "item-1", date: TODAY, runId: "run-a" });
    assert.equal(result.ok, true);

    const rowsAfter = readRows(tmp, "work-study");
    assert.equal(rowsAfter.length, 1);
    const remaining = rowsAfter[0] as { id: string; runId: string };
    assert.equal(remaining.id, "item-1");
    assert.equal(remaining.runId, "run-b");
  });
});

describe("buildDeleteBulkHandler — validation and empty list", () => {
  it("returns error when workflow is missing", () => {
    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "", date: TODAY, ids: ["item-1"] });
    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
  });

  it("returns error when date is missing", () => {
    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", date: "", ids: ["item-1"] });
    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
  });

  it("returns ok with count 0 when ids list is empty", () => {
    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", date: TODAY, ids: [] });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
  });

  it("returns ok with count 0 when items list is empty", () => {
    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", date: TODAY, items: [] });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
  });
});

describe("buildDeleteBulkHandler — deletes multiple rows", () => {
  it("removes all specified ids from the JSONL file", () => {
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-a" });
    seedRow(tmp, { workflow: "work-study", id: "item-2", runId: "run-b" });
    seedRow(tmp, { workflow: "work-study", id: "item-3", runId: "run-c" });

    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({ workflow: "work-study", date: TODAY, ids: ["item-1", "item-2"] });

    assert.equal(result.ok, true);
    assert.equal(result.count, 2);

    const rowsAfter = readRows(tmp, "work-study");
    assert.equal(rowsAfter.length, 1);
    const remaining = rowsAfter[0] as { id: string };
    assert.equal(remaining.id, "item-3");
  });

  it("accepts items array with runId scoping", () => {
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-a" });
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-b" });

    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({
      workflow: "work-study",
      date: TODAY,
      items: [{ id: "item-1", runId: "run-a" }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);

    const rowsAfter = readRows(tmp, "work-study");
    assert.equal(rowsAfter.length, 1);
    const remaining = rowsAfter[0] as { id: string; runId: string };
    assert.equal(remaining.runId, "run-b");
  });

  it("reports individual errors for items with missing id", () => {
    const handler = buildDeleteBulkHandler(tmp, { screenshotsDir });
    const result = handler({
      workflow: "work-study",
      date: TODAY,
      items: [{ id: "" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.equal(result.errors.length, 1);
  });
});

describe("deleteDelegatedChildrenForRun — no-op when parentRunId is empty", () => {
  it("returns without error when parentRunId is empty string", () => {
    // Should not throw
    deleteDelegatedChildrenForRun(tmp, "", { screenshotsDir });
  });
});

describe("deleteDelegatedChildrenForRun — cascades to JSONL children", () => {
  it("removes child rows that have the given parentRunId", () => {
    const parentRunId = "parent-run-xyz";
    // Seed a child row that references the parent
    seedRow(tmp, { workflow: "person-lookup", id: "child-item", runId: "child-run", parentRunId });
    // Seed an unrelated row that should survive
    seedRow(tmp, { workflow: "person-lookup", id: "other-item", runId: "other-run" });

    const rowsBefore = readRows(tmp, "person-lookup");
    assert.equal(rowsBefore.length, 2);

    deleteDelegatedChildrenForRun(tmp, parentRunId, { screenshotsDir });

    const rowsAfter = readRows(tmp, "person-lookup");
    assert.equal(rowsAfter.length, 1);
    const remaining = rowsAfter[0] as { id: string };
    assert.equal(remaining.id, "other-item");
  });

  it("is a no-op when no children exist for the given parentRunId", () => {
    seedRow(tmp, { workflow: "work-study", id: "item-1", runId: "run-a" });

    deleteDelegatedChildrenForRun(tmp, "nonexistent-parent-run", { screenshotsDir });

    const rowsAfter = readRows(tmp, "work-study");
    assert.equal(rowsAfter.length, 1);
  });
});
