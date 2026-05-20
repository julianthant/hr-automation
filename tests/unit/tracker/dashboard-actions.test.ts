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
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { performWorkflowAction } from "../../../src/tracker/dashboard/actions/perform-workflow-action.js";
import { resolveActionTargets } from "../../../src/tracker/dashboard/actions/resolve-targets.js";
import type { WorkflowActionRequest } from "../../../src/tracker/dashboard/actions/types.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { readEntries } from "../../../src/tracker/jsonl.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";

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
        cancelMode: "cooperative",
        targets: [{ id: "3930", runId: "run-a", status: "pending" }],
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
        cancelMode: "cooperative",
        targets: [
          { id: "a", runId: "run-a", status: "pending" },
          { id: "b", runId: "run-b", status: "pending" },
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
      targets: [{ id: "ocr-sess-1", runId: "ocr-run-1" }],
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
          { id: "a", runId: "run-a" },
          { id: "b", runId: "run-b" },
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
        targets: [{ id: "3930", runId: "run-a" }],
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
      targets: [{ id: "3930", runId: "run-a" }],
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
      targets: [{ id: "3930", runId: "run-a" }],
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
        { id: "a", runId: "run-a" },
        { id: "b", runId: "run-b" },
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
