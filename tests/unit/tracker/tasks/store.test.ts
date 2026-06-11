import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cancelQueuedChildTasksForParentRun,
  createOcrActiveCheckDependencyBatch,
  createTaskDependencyBatch,
  getDependencySummaryByParentRunId,
  getDependencySummary,
  getTaskByTrackerIdentity,
  markDependencyTerminal,
  openTaskStore,
  openTaskStoreForTests,
  type TaskStore,
} from "../../../../src/tracker/tasks/store.js";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-store-"));
  return join(dir, "tracker.sqlite");
}

test("task store creates parent, children, attempts, and dependency edges atomically", () => {
  const dbPath = tempDbPath();
  try {
    const store = openTaskStoreForTests(dbPath);
    const batch = createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: { formType: "oath" },
      },
      children: [
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          taskKind: "workflow_item",
          status: "queued",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 0, lookupKind: "name", formType: "oath" },
        },
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-ocr-run-1-r1",
          runId: "child-run-1",
          taskKind: "workflow_item",
          status: "queued",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 1, lookupKind: "verify", formType: "oath" },
        },
      ],
      now: "2026-05-04T12:00:00.000Z",
    });

    assert.equal(batch.children.length, 2);
    assert.ok(batch.parentTaskId);

    const parent = getTaskByTrackerIdentity(store, {
      workflow: "ocr",
      itemId: "session-1",
      runId: "ocr-run-1",
    });
    assert.equal(parent?.status, "waiting_on_children");

    const summary = getDependencySummary(store, batch.parentTaskId);
    assert.deepEqual(summary, {
      total: 2,
      pending: 2,
      satisfied: 0,
      failed: 0,
      cancelled: 0,
    });
  } finally {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("getDependencySummaryByParentRunId picks latest run projection across tracker dates", () => {
  const dbPath = tempDbPath();
  try {
    const store = openTaskStoreForTests(dbPath);
    createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: { formType: "oath" },
      },
      children: [
        {
          workflow: "person-lookup",
          itemId: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          taskKind: "workflow_item",
          status: "running",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 0, lookupKind: "verify", formType: "oath" },
        },
      ],
      now: "2026-05-04T12:00:00.000Z",
    });
    store.db.prepare(`
      INSERT INTO runs (
        workflow, tracker_date, item_id, run_id, parent_run_id,
        first_any_ts, first_work_ts, latest_tracker_ts, latest_status,
        latest_step, latest_data_json, updated_at
      ) VALUES
        (
          'person-lookup', '2026-05-04', 'ocr-oath-ocr-run-1-r0', 'child-run-0', 'ocr-run-1',
          '2026-05-04T12:00:01.000Z', '2026-05-04T12:00:01.000Z', '2026-05-04T12:00:01.000Z', 'running',
          'person-org', '{"__traceId":"ou-120001-stale"}', '2026-05-04T12:00:01.000Z'
        ),
        (
          'person-lookup', '2026-05-05', 'ocr-oath-ocr-run-1-r0', 'child-run-0', 'ocr-run-1',
          '2026-05-04T12:00:01.000Z', '2026-05-04T12:00:01.000Z', '2026-05-05T08:00:01.000Z', 'running',
          'person-org', '{"__traceId":"ou-080001-fresh"}', '2026-05-05T08:00:01.000Z'
        )
    `).run();

    const result = getDependencySummaryByParentRunId(store, "ocr-run-1");

    assert.equal(result.children.length, 1);
    assert.equal(result.summary.total, 1);
    assert.equal(result.children[0]?.traceId, "ou-080001-fresh");
  } finally {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("getDependencySummaryByParentRunId returns child trace ids from run projections", () => {
  const dbPath = tempDbPath();
  try {
    const store = openTaskStoreForTests(dbPath);
    createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: { formType: "oath" },
      },
      children: [
        {
          workflow: "person-lookup",
          itemId: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          taskKind: "workflow_item",
          status: "running",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 0, lookupKind: "verify", formType: "oath" },
        },
      ],
      now: "2026-05-04T12:00:00.000Z",
    });
    store.db.prepare(`
      INSERT INTO runs (
        workflow, tracker_date, item_id, run_id, parent_run_id,
        first_any_ts, first_work_ts, latest_tracker_ts, latest_status,
        latest_step, latest_data_json, updated_at
      ) VALUES (
        'person-lookup', '2026-05-04', 'ocr-oath-ocr-run-1-r0', 'child-run-0', 'ocr-run-1',
        '2026-05-04T12:00:01.000Z', '2026-05-04T12:00:01.000Z', '2026-05-04T12:00:01.000Z', 'running',
        'person-org', '{"__traceId":"ou-120001-abcd"}', '2026-05-04T12:00:01.000Z'
      )
    `).run();

    const result = getDependencySummaryByParentRunId(store, "ocr-run-1");

    assert.equal(result.children[0]?.traceId, "ou-120001-abcd");
  } finally {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("markDependencyTerminal records result JSON and updates summary", () => {
  const dbPath = tempDbPath();
  try {
    const store = openTaskStoreForTests(dbPath);
    const batch = createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: {},
      },
      children: [
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          taskKind: "workflow_item",
          status: "queued",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 0, lookupKind: "name", formType: "oath" },
        },
      ],
      now: "2026-05-04T12:00:00.000Z",
    });

    markDependencyTerminal(store, {
      dependencyId: batch.dependencies[0].id,
      status: "satisfied",
      result: { workflow: "eid-lookup", itemId: "ocr-oath-ocr-run-1-r0", data: { emplId: "10000001" } },
      now: "2026-05-04T12:01:00.000Z",
    });

    const summary = getDependencySummary(store, batch.parentTaskId);
    assert.equal(summary.pending, 0);
    assert.equal(summary.satisfied, 1);
  } finally {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

function seedChildTask(
  store: TaskStore,
  args: { taskId: string; workflow: string; itemId: string; runId: string; parentRunId: string; state: string },
): void {
  const now = "2026-06-11T12:00:00.000Z";
  store.db.prepare(`
    INSERT INTO tasks (
      id, workflow, item_id, run_id, task_kind, data_json, input_json, original_input_json,
      control_state, priority, available_at, enqueued_at, parent_run_id, source,
      created_at, updated_at, terminal_at
    ) VALUES (
      @taskId, @workflow, @itemId, @runId, 'workflow_item', '{}', '{}', '{}',
      @state, 0, @now, @now, @parentRunId, 'daemon',
      @now, @now, @terminalAt
    )
  `).run({
    taskId: args.taskId,
    workflow: args.workflow,
    itemId: args.itemId,
    runId: args.runId,
    parentRunId: args.parentRunId,
    state: args.state,
    now,
    terminalAt: ["done", "failed", "cancelled"].includes(args.state) ? now : null,
  });
  store.db.prepare(`
    INSERT INTO task_attempts (
      id, task_id, attempt_no, run_id, control_state,
      tracker_workflow, tracker_item_id, data_json, created_at, updated_at
    ) VALUES (
      @attemptId, @taskId, 1, @runId, @attemptState,
      @workflow, @itemId, '{}', @now, @now
    )
  `).run({
    attemptId: `att-${args.taskId}`,
    taskId: args.taskId,
    runId: args.runId,
    workflow: args.workflow,
    itemId: args.itemId,
    attemptState: args.state === "queued" ? "pending" : args.state === "running" ? "running" : "done",
    now,
  });
}

test("cancelQueuedChildTasksForParentRun cancels non-terminal children of a parent run, leaves others", () => {
  const dbPath = tempDbPath();
  try {
    const store = openTaskStoreForTests(dbPath);
    // Two non-terminal children of our prep run (queued + running) — both cancellable.
    seedChildTask(store, { taskId: "t-queued", workflow: "person-lookup", itemId: "ocr-verify-run-1-r0", runId: "c0", parentRunId: "ocr-run-1", state: "queued" });
    seedChildTask(store, { taskId: "t-running", workflow: "i9-lookup", itemId: "ocr-verify-i9-run-1-r1", runId: "c1", parentRunId: "ocr-run-1", state: "running" });
    // An already-done child of the same parent — must NOT be re-cancelled.
    seedChildTask(store, { taskId: "t-done", workflow: "person-lookup", itemId: "ocr-verify-run-1-r2", runId: "c2", parentRunId: "ocr-run-1", state: "done" });
    // A queued child of a DIFFERENT parent run — must be untouched.
    seedChildTask(store, { taskId: "t-other", workflow: "person-lookup", itemId: "ocr-verify-run-9-r0", runId: "c9", parentRunId: "ocr-run-OTHER", state: "queued" });

    const cancelled = cancelQueuedChildTasksForParentRun(store, { parentRunId: "ocr-run-1" });
    assert.equal(cancelled, 2, "queued + running children of the prep run are cancelled");

    const stateOf = (taskId: string): string =>
      (store.db.prepare("SELECT control_state AS s FROM tasks WHERE id = ?").get(taskId) as { s: string }).s;
    assert.equal(stateOf("t-queued"), "cancelled");
    assert.equal(stateOf("t-running"), "cancelled");
    assert.equal(stateOf("t-done"), "done", "terminal child is not re-cancelled");
    assert.equal(stateOf("t-other"), "queued", "a different parent run's child is untouched");

    // Cancelling again is a no-op (the children are now terminal).
    assert.equal(cancelQueuedChildTasksForParentRun(store, { parentRunId: "ocr-run-1" }), 0);
  } finally {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("createOcrActiveCheckDependencyBatch records active-check child dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-active-check-"));
  try {
    const batch = createOcrActiveCheckDependencyBatch({
      trackerDir: dir,
      parent: { workflow: "ocr", itemId: "session-active", runId: "ocr-run-active", formType: "oath" },
      children: [{
        workflow: "active-check",
        itemId: "ocr-active-ocr-run-active-r0",
        runId: "active-child-0",
        recordIndex: 0,
        lookupKind: "verify",
        formType: "oath",
      }],
      now: "2026-05-05T12:00:00.000Z",
    });
    const store = openTaskStore(dir);

    assert.equal(batch.children.length, 1);
    const parent = getTaskByTrackerIdentity(store, {
      workflow: "ocr",
      itemId: "session-active",
      runId: "ocr-run-active",
    });
    assert.equal(parent?.status, "waiting_on_children");

    const row = store.db.prepare(`
      SELECT kind, metadata_json AS metadataJson
      FROM task_dependencies
      WHERE parent_task_id = @parentTaskId
    `).get({ parentTaskId: batch.parentTaskId }) as { kind: string; metadataJson: string } | undefined;
    assert.equal(row?.kind, "ocr-active-check");
    assert.deepEqual(JSON.parse(row?.metadataJson ?? "{}"), {
      recordIndex: 0,
      lookupKind: "verify",
      formType: "oath",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
