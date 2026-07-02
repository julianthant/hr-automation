/**
 * Central workflow action engine — scope-boundary behavior.
 *
 * `performWorkflowAction` is the single dispatcher for operator cancel /
 * retry / delete / bump. These tests pin the blast radius: a queue-panel
 * row action touches exactly one run, a operation-view visible action touches
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
import { readEntries, trackEvent } from "../../../src/tracker/jsonl.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import {
  resetDaemonSpawnStubs,
  stubDaemonSpawn,
} from "../../_utils/stub-daemon-spawn.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-actions-"));
});

afterEach(async () => {
  await resetDaemonSpawnStubs();
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

function seedPriorRow(workflow: string, id: string, runId: string, status: "pending" | "failed" = "pending") {
  trackEvent(
    {
      workflow,
      timestamp: new Date().toISOString(),
      id,
      runId,
      status,
      data: { archetype: "single" },
      input: { docId: id },
    },
    dir,
  );
}

describe("performWorkflowAction — cancel scope", () => {
  it("cancels exactly one queued run for scope=row", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "3930", runId: "run-a" },
    ]);
    try {
      seedPriorRow("separations", "3930", "run-a");
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
      seedPriorRow("separations", "a", "run-a");
      seedPriorRow("separations", "b", "run-b");
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "visible-view",
        source: "operation-view",
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

  it("reports a clear error and leaves the task queued when cancel cannot find the prior tracker row", async () => {
    const { store, enqueued } = seedQueued("separations", [
      { docId: "missing-cancel-row", runId: "run-missing-cancel-row" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "cancel",
        scope: "row",
        source: "queue-panel",
        workflowId: "separations",
        targets: [
          {
            workflowId: "separations",
            id: "missing-cancel-row",
            runId: "run-missing-cancel-row",
            status: "pending",
          },
        ],
      }, { dir });

      assert.equal(result.ok, false);
      assert.equal(result.count, 0);
      assert.match(result.errors[0]?.error ?? "", /cannot cancel/i);
      assert.match(result.errors[0]?.error ?? "", /prior tracker row/i);
      assert.equal(store.getTask(enqueued[0].taskId)?.state, "queued");
    } finally {
      store.close();
    }
  });

  it("terminalizing a stranded operation coordinator reports a FLAT detail (no detail.detail nesting)", async () => {
    // A display-only operation coordinator: prior tracker row, but no SQLite
    // task and no descendants. Cancel terminalizes it — and the target result's
    // `detail` must be the flat object passed to okTarget (okTarget already
    // wraps its second argument in `{ detail }`; double-wrapping produced a
    // malformed `detail.detail.terminalizedCoordinator`).
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id: "input-run-orphan",
        runId: "coord-run-orphan",
        status: "pending",
        data: { archetype: "operation", queueRowKind: "person" },
      },
      dir,
    );

    const result = await performWorkflowAction({
      action: "cancel",
      scope: "row",
      source: "queue-panel",
      workflowId: "oath-signature",
      targets: [{
        workflowId: "oath-signature",
        id: "input-run-orphan",
        runId: "coord-run-orphan",
        status: "pending",
      }],
    }, { dir });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.results[0]?.detail, { terminalizedCoordinator: true });
  });

  it("cancel falling through to descendants reports a FLAT cancelledDescendants detail", async () => {
    // Coordinator with no SQLite task of its own, but one live queued member:
    // the direct cancel misses ("task not found"), the tree walk cancels the
    // member, and the coordinator's result carries the flat descendant count.
    const store = createTaskStore(openControlDb({ trackerDir: dir }));
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [member] = store.enqueueTasks({
        workflow: "emergency-contact",
        inputs: [{ emplId: "10000009" }],
        deriveItemId: (input) => input.emplId,
        runIds: ["member-run-9"],
        parentRunId: "coord-run-9",
      });
      seedPriorRow("emergency-contact", "10000009", "member-run-9");
      // Project the member into the runs table so the tree BFS finds it under
      // the coordinator runId.
      seedRunRow({
        workflow: "emergency-contact",
        date: today,
        itemId: "10000009",
        runId: "member-run-9",
        parentRunId: "coord-run-9",
        latestStatus: "pending",
      });

      const result = await performWorkflowAction({
        action: "cancel",
        scope: "row",
        source: "queue-panel",
        workflowId: "emergency-contact",
        targets: [{
          workflowId: "emergency-contact",
          id: "input-run-ec-coord-9",
          runId: "coord-run-9",
          status: "pending",
        }],
      }, { dir });

      assert.equal(result.ok, true);
      assert.equal(result.count, 1);
      assert.deepEqual(result.results[0]?.detail, { cancelledDescendants: 1 });
      assert.equal(store.getTask(member.taskId)?.state, "cancelled");
    } finally {
      store.close();
    }
  });

  it("routes an OCR prep cancel to file-scope discard", async () => {
    trackEvent(
      {
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "ocr-sess-1",
        runId: "ocr-run-1",
        status: "pending",
        data: { archetype: "operation" },
      },
      dir,
    );
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
      stubDaemonSpawn(dir);
      seedPriorRow("separations", "a", "run-a", "failed");
      seedPriorRow("separations", "b", "run-b", "failed");
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

  it("reports a clear error when retry cannot find the prior tracker row", async () => {
    const { store } = seedQueued("separations", [
      { docId: "missing-row", runId: "run-missing-row" },
    ]);
    try {
      const result = await performWorkflowAction({
        action: "retry",
        scope: "row",
        source: "queue-panel",
        workflowId: "separations",
        targets: [{ workflowId: "separations", id: "missing-row", runId: "run-missing-row" }],
      }, { dir });

      assert.equal(result.ok, false);
      assert.equal(result.count, 0);
      assert.match(result.errors[0]?.error ?? "", /cannot retry/i);
      assert.match(result.errors[0]?.error ?? "", /prior tracker row/i);
      assert.equal(store.listAttemptsForTask(store.findTaskByIdentity({
        workflow: "separations",
        itemId: "missing-row",
      })!.taskId).length, 1);
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

  it("excludes tree roots when treeExcludeRoots is set (display-only operation coordinators)", () => {
    seedRunRow({ workflow: "emergency-contact", date: DATE, itemId: "coord-1", runId: "coord-run", latestStatus: "pending" });
    seedRunRow({
      workflow: "emergency-contact",
      date: DATE,
      itemId: "member-1",
      runId: "member-run",
      parentRunId: "coord-run",
      latestStatus: "pending",
    });

    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "tree",
      treeExcludeRoots: true,
      source: "queue-panel",
      workflowId: "emergency-contact",
      targets: [{ workflowId: "emergency-contact", id: "coord-1", runId: "coord-run", status: "pending" }],
    };
    const resolved = resolveActionTargets(req, dir);
    assert.ok(resolved.ok);
    const runIds = resolved.targets.map((t) => t.runId);
    assert.ok(!runIds.includes("coord-run"), "display-only coordinator root must be excluded");
    assert.ok(runIds.includes("member-run"), "pending member must be included");
    assert.equal(resolved.targets.length, 1);
  });
});
