import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOcrActiveCheckDependencyBatch,
  createTaskDependencyBatch,
  getDependencySummaryByParentRunId,
  getDependencySummary,
  getTaskByTrackerIdentity,
  markDependencyTerminal,
  openTaskStore,
  openTaskStoreForTests,
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
