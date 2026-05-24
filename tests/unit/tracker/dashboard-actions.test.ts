/**
 * Central workflow action engine — scope-boundary behavior.
 *
 * `performWorkflowAction` is the single dispatcher for operator cancel /
 * retry / delete / bump. These tests pin the blast radius: a queue-panel
 * row action touches exactly one run, a batch-view visible action touches
 * only the rows the caller passed, a group retry touches only the listed
 * members, an OCR prep cancel routes to file-scope discard, and daemon stop
 * is refused outright.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { performWorkflowAction } from "../../../src/control/actions/perform-workflow-action.js";
import { resolveActionTargets } from "../../../src/control/actions/resolve-targets.js";
import type { WorkflowActionRequest } from "../../../src/control/actions/types.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { readEntries } from "../../../src/tracker/jsonl.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-actions-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function seedQueued(workflow: string, items: Array<{ docId: string; runId: string }>) {
  const store = createTaskStore(openControlDb({ trackerDir: dir }));
  const enqueued = store.enqueueTasks({
    workflow,
    inputs: items.map((i) => ({ docId: i.docId })),
    deriveItemId: (input) => input.docId,
    runIds: items.map((i) => i.runId),
  });
  return { store, enqueued };
}

describe("performWorkflowAction — cancel scope", () => {
  it("cancels exactly one queued run for scope=row", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "3930", runId: "run-a" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "row",
        source: "queue-panel",
        workflowId: "separations",
        targets: [{ workflowId: "separations", id: "3930", runId: "run-a", status: "pending" }],
      }, { dir });

      assert.equal(result.ok, true);
      assert.equal(result.count, 1);
      assert.equal(result.results.length, 1);
      assert.equal(store.getTask(enqueued[0].taskId)?.state, "cancelled");
    } finally {
      store.close();
    }
  });

  it("visible-view cancel only cancels the provided visible rows", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "a", runId: "run-a" },
      { docId: "b", runId: "run-b" },
      { docId: "c", runId: "run-c" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "visible-view",
        source: "batch-view",
        workflowId: "separations",
        targets: [
          { workflowId: "separations", id: "a", runId: "run-a", status: "pending" },
          { workflowId: "separations", id: "b", runId: "run-b", status: "pending" },
        ],
      }, { dir });

      assert.equal(result.ok, true);
      assert.equal(result.count, 2);
      assert.equal(store.getTask(enqueued[0].taskId)?.state, "cancelled");
      assert.equal(store.getTask(enqueued[1].taskId)?.state, "cancelled");
      // The third row was never passed as a target — it must stay queued.
      assert.equal(store.getTask(enqueued[2].taskId)?.state, "queued");
    } finally {
      store.close();
    }
  });

  it("routes an OCR prep cancel to file-scope discard", async () => {
    const result = await performWorkflowAction({
      action: "cancel",
      scope: "row",
      source: "queue-panel",
      workflowId: "ocr",
      ocrSessionId: "ocr-sess-1",
      targets: [{ workflowId: "ocr", id: "ocr-sess-1", runId: "ocr-run-1" }],
    }, { dir });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    const discarded = readEntries("ocr", dir).filter(
      (e) => e.runId === "ocr-run-1" && e.status === "failed" && e.step === "discarded",
    );
    assert.equal(discarded.length, 1);
  });
});

describe("performWorkflowAction — retry scope", () => {
  it("group retry retries only the provided group members", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "a", runId: "run-a" },
      { docId: "b", runId: "run-b" },
      { docId: "c", runId: "run-c" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "retry",
        scope: "group",
        source: "queue-panel",
        workflowId: "separations",
        targets: [
          { workflowId: "separations", id: "a", runId: "run-a" },
          { workflowId: "separations", id: "b", runId: "run-b" },
        ],
      }, { dir });

      assert.equal(result.ok, true);
      assert.equal(result.count, 2);
      assert.equal(store.listAttemptsForTask(enqueued[0].taskId).length, 2);
      assert.equal(store.listAttemptsForTask(enqueued[1].taskId).length, 2);
      // The third member was not in the group — no extra attempt created.
      assert.equal(store.listAttemptsForTask(enqueued[2].taskId).length, 1);
    } finally {
      store.close();
    }
  });
});

describe("performWorkflowAction — rejected combinations", () => {
  it("rejects daemon-sourced cancel as a workflow tree cancel", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "3930", runId: "run-a" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "tree",
        source: "daemon",
        workflowId: "separations",
        targets: [{ workflowId: "separations", id: "3930", runId: "run-a" }],
      }, { dir });

      assert.equal(result.ok, false);
      assert.equal(result.count, 0);
      assert.equal(result.results.length, 0);
      assert.match(result.error ?? "", /daemon/i);
      // The daemon-sourced request must not have touched the task.
      assert.equal(store.getTask(enqueued[0].taskId)?.state, "queued");
    } finally {
      store.close();
    }
  });

  it("rejects stop-daemon as a workflow action", async () => {
    const result = await performWorkflowAction({
      action: "stop-daemon",
      scope: "row",
      source: "queue-panel",
      workflowId: "separations",
      targets: [{ workflowId: "separations", id: "3930", runId: "run-a" }],
    }, { dir });

    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
    assert.match(result.error ?? "", /operational/i);
  });

  it("rejects bump for a non-row scope", async () => {
    const result = await performWorkflowAction({
      action: "bump",
      scope: "group",
      source: "queue-panel",
      workflowId: "separations",
      targets: [{ workflowId: "separations", id: "3930", runId: "run-a" }],
    }, { dir });

    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
    assert.match(result.error ?? "", /row/i);
  });
});

describe("resolveActionTargets", () => {
  it("returns the provided targets verbatim for scope=group", () => {
    const req: WorkflowActionRequest = {
      action: "retry",
      scope: "group",
      source: "queue-panel",
      workflowId: "separations",
      targets: [
        { workflowId: "separations", id: "a", runId: "run-a" },
        { workflowId: "separations", id: "b", runId: "run-b" },
      ],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.equal(resolved.ok, true);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.targets, [
      { workflow: "separations", id: "a", runId: "run-a" },
      { workflow: "separations", id: "b", runId: "run-b" },
    ]);
  });

  it("rejects an empty target list", () => {
    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "row",
      source: "queue-panel",
      workflowId: "separations",
      targets: [],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.equal(resolved.ok, false);
  });
});

// ── Helper: seed runs rows directly into the SQLite projection ────────────────

function seedRunRow(opts: {
  workflow: string;
  date: string;
  itemId: string;
  runId: string;
  parentRunId?: string;
  latestStatus: string;
}): void {
  const db = openStateDb(dir);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO runs
      (workflow, tracker_date, item_id, run_id, parent_run_id,
       first_any_ts, latest_tracker_ts, latest_status,
       run_ordinal, screenshot_count, updated_at)
    VALUES
      (@workflow, @date, @itemId, @runId, @parentRunId,
       @now, @now, @latestStatus,
       1, 0, @now)
  `).run({
    workflow: opts.workflow,
    date: opts.date,
    itemId: opts.itemId,
    runId: opts.runId,
    parentRunId: opts.parentRunId ?? null,
    latestStatus: opts.latestStatus,
    now,
  });
}

describe("resolveActionTargets — tree scope descendant resolution", () => {
  const DATE = "2026-05-20";

  it("includes pending and running descendants with correct status field", () => {
    // Root: oath-upload row
    seedRunRow({ workflow: "oath-upload", date: DATE, itemId: "sess-1", runId: "root-run", latestStatus: "running" });
    // Pending child (OCR)
    seedRunRow({ workflow: "ocr", date: DATE, itemId: "ocr-1", runId: "child-run-1", parentRunId: "root-run", latestStatus: "pending" });
    // Running child (oath-signature)
    seedRunRow({ workflow: "oath-signature", date: DATE, itemId: "sig-1", runId: "child-run-2", parentRunId: "root-run", latestStatus: "running" });

    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "tree",
      source: "queue-panel",
      workflowId: "oath-upload",
      targets: [{ workflowId: "oath-upload", id: "sess-1", runId: "root-run", status: "running" }],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.ok(resolved.ok);

    const targets = resolved.targets;
    // Root + 2 non-terminal children
    assert.equal(targets.length, 3);

    const pending = targets.find((t) => t.runId === "child-run-1");
    assert.ok(pending, "pending child must be included");
    assert.equal(pending?.status, "pending");

    const running = targets.find((t) => t.runId === "child-run-2");
    assert.ok(running, "running child must be included");
    assert.equal(running?.status, "running");
  });

  it("excludes terminal (done/failed/skipped) descendants from the cancel set", () => {
    seedRunRow({ workflow: "oath-upload", date: DATE, itemId: "sess-2", runId: "root-run-2", latestStatus: "running" });
    // Done child — must be excluded
    seedRunRow({ workflow: "ocr", date: DATE, itemId: "ocr-2", runId: "done-child", parentRunId: "root-run-2", latestStatus: "done" });
    // Failed child — must be excluded
    seedRunRow({ workflow: "oath-signature", date: DATE, itemId: "sig-2", runId: "failed-child", parentRunId: "root-run-2", latestStatus: "failed" });
    // Pending child — must be included
    seedRunRow({ workflow: "eid-lookup", date: DATE, itemId: "eid-1", runId: "pending-child", parentRunId: "root-run-2", latestStatus: "pending" });

    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "tree",
      source: "queue-panel",
      workflowId: "oath-upload",
      targets: [{ workflowId: "oath-upload", id: "sess-2", runId: "root-run-2", status: "running" }],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.ok(resolved.ok);

    const runIds = resolved.targets.map((t) => t.runId);
    // Root and pending child only — terminal rows excluded
    assert.ok(runIds.includes("root-run-2"), "root must be included");
    assert.ok(runIds.includes("pending-child"), "pending child must be included");
    assert.ok(!runIds.includes("done-child"), "done child must be excluded");
    assert.ok(!runIds.includes("failed-child"), "failed child must be excluded");
    assert.equal(resolved.targets.length, 2);
  });

  it("still descends through terminal nodes to find non-terminal grandchildren", () => {
    seedRunRow({ workflow: "oath-upload", date: DATE, itemId: "sess-3", runId: "root-run-3", latestStatus: "running" });
    // Done intermediate — excluded from cancel set but BFS must continue through it
    seedRunRow({ workflow: "ocr", date: DATE, itemId: "ocr-3", runId: "done-mid", parentRunId: "root-run-3", latestStatus: "done" });
    // Running grandchild under the done intermediate — must be included
    seedRunRow({ workflow: "oath-signature", date: DATE, itemId: "sig-3", runId: "running-grand", parentRunId: "done-mid", latestStatus: "running" });

    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "tree",
      source: "queue-panel",
      workflowId: "oath-upload",
      targets: [{ workflowId: "oath-upload", id: "sess-3", runId: "root-run-3", status: "running" }],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.ok(resolved.ok);

    const runIds = resolved.targets.map((t) => t.runId);
    assert.ok(runIds.includes("root-run-3"), "root must be included");
    assert.ok(!runIds.includes("done-mid"), "terminal intermediate must be excluded from cancel set");
    assert.ok(runIds.includes("running-grand"), "non-terminal grandchild must still be reached via BFS");
    assert.equal(resolved.targets.length, 2);
  });
});
