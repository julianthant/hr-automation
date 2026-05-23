import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskDependencyBatch,
  getDependencySummary,
  getTaskByTrackerIdentity,
  openTaskStoreForTests,
} from "../../../../src/tracker/tasks/store.js";
import { runDependencySchedulerTick } from "../../../../src/tracker/tasks/scheduler.js";

test("scheduler marks child dependency satisfied from projected child run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
    const batch = createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: {},
      },
      children: [{
        workflow: "eid-lookup",
        itemId: "ocr-oath-ocr-run-1-r0",
        runId: "child-run-0",
        taskKind: "workflow_item",
        status: "queued",
        dependencyKind: "ocr-eid-lookup",
        failurePolicy: "record_unresolved",
        metadata: { recordIndex: 0, lookupKind: "name", formType: "oath" },
      }],
      now: "2026-05-04T12:00:00.000Z",
    });

    const emitted: unknown[] = [];
    const result = await runDependencySchedulerTick({
      store,
      now: "2026-05-04T12:01:00.000Z",
      projection: {
        getLatestRun: async () => ({
          workflow: "eid-lookup",
          id: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          status: "done",
          step: "cross-verification",
          data: { emplId: "10000001", hrStatus: "Active", department: "Housing Dining Hospitality" },
          timestamp: "2026-05-04T12:00:30.000Z",
        }),
        getLatestParentRun: async () => ({
          workflow: "ocr",
          id: "session-1",
          runId: "ocr-run-1",
          status: "done",
          step: "awaiting-approval",
          data: { records: JSON.stringify([{ printedName: "Liam", matchState: "lookup-pending", selected: true }]) },
          timestamp: "2026-05-04T12:00:00.000Z",
        }),
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(result.dependenciesResolved, 1);
    assert.equal(getDependencySummary(store, batch.parentTaskId).satisfied, 1);
    assert.equal(emitted.length, 1, "OCR continuation should emit one patched tracker event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler marks failed child as failed and OCR continuation leaves record unresolved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-fail-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
    const batch = createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-1",
        runId: "ocr-run-1",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: {},
      },
      children: [{
        workflow: "eid-lookup",
        itemId: "ocr-oath-ocr-run-1-r0",
        runId: "child-run-0",
        taskKind: "workflow_item",
        status: "queued",
        dependencyKind: "ocr-eid-lookup",
        failurePolicy: "record_unresolved",
        metadata: { recordIndex: 0, lookupKind: "name", formType: "oath" },
      }],
      now: "2026-05-04T12:00:00.000Z",
    });

    const emitted: Array<{ data?: Record<string, string> }> = [];
    await runDependencySchedulerTick({
      store,
      now: "2026-05-04T12:01:00.000Z",
      projection: {
        getLatestRun: async () => ({
          workflow: "eid-lookup",
          id: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          status: "failed",
          error: "no result",
          data: {},
          timestamp: "2026-05-04T12:00:30.000Z",
        }),
        getLatestParentRun: async () => ({
          workflow: "ocr",
          id: "session-1",
          runId: "ocr-run-1",
          status: "done",
          step: "awaiting-approval",
          data: { records: JSON.stringify([{ printedName: "Liam", matchState: "lookup-pending", selected: true, warnings: [] }]) },
          timestamp: "2026-05-04T12:00:00.000Z",
        }),
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(getDependencySummary(store, batch.parentTaskId).failed, 1);
    const records = JSON.parse(emitted[0].data?.records ?? "[]") as Array<{ matchState?: string; warnings?: string[] }>;
    assert.equal(records[0].matchState, "unresolved");
    assert.ok(records[0].warnings?.some((warning) => warning.includes("eid-lookup failed")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler applies active-check continuation from projected child run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-active-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
    const batch = createTaskDependencyBatch(store, {
      parent: {
        workflow: "ocr",
        itemId: "session-active",
        runId: "ocr-run-active",
        taskKind: "ocr",
        status: "waiting_on_children",
        data: {},
      },
      children: [{
        workflow: "active-check",
        itemId: "ocr-active-ocr-run-active-r0",
        runId: "active-child-0",
        taskKind: "workflow_item",
        status: "queued",
        dependencyKind: "ocr-active-check",
        failurePolicy: "record_unresolved",
        metadata: { recordIndex: 0, lookupKind: "verify", formType: "oath" },
      }],
      now: "2026-05-05T12:00:00.000Z",
    });

    const emitted: Array<{ data?: Record<string, string> }> = [];
    const result = await runDependencySchedulerTick({
      store,
      now: "2026-05-05T12:01:00.000Z",
      projection: {
        getLatestRun: async () => ({
          workflow: "active-check",
          id: "ocr-active-ocr-run-active-r0",
          runId: "active-child-0",
          status: "done",
          step: "checking",
          data: {
            emplId: "10000001",
            activeStatus: "active",
            isActive: "true",
            isHdhAccepted: "true",
            hrStatus: "Active",
            department: "Housing Dining Hospitality",
          },
          timestamp: "2026-05-05T12:00:30.000Z",
        }),
        getLatestParentRun: async () => ({
          workflow: "ocr",
          id: "session-active",
          runId: "ocr-run-active",
          status: "running",
          step: "awaiting-approval",
          data: {
            records: JSON.stringify([{ printedName: "Liam", employeeId: "10000001", matchState: "matched", selected: true }]),
          },
          timestamp: "2026-05-05T12:00:00.000Z",
        }),
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(result.dependenciesResolved, 1);
    assert.equal(result.continuationsApplied, 1);
    assert.equal(getDependencySummary(store, batch.parentTaskId).satisfied, 1);
    const records = JSON.parse(emitted[0].data?.records ?? "[]") as Array<{ verification?: { state?: string } }>;
    assert.equal(records[0].verification?.state, "verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler records per-dependency errors and continues", async () => {
  const { dir, store } = makeStoreWithOnePendingDependency();
  try {
    const result = await runDependencySchedulerTick({
      store,
      projection: {
        getLatestRun: async () => {
          throw new Error("projection unavailable");
        },
        getLatestParentRun: async () => null,
      },
    });

    assert.equal(result.dependenciesResolved, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /projection unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler leaves OCR dependency pending when the parent projection is not ready", async () => {
  const { dir, store, parentTaskId } = makeStoreWithOnePendingDependency();
  try {
    const emitted: unknown[] = [];
    const result = await runDependencySchedulerTick({
      store,
      now: "2026-05-04T12:01:00.000Z",
      projection: {
        getLatestRun: async () => ({
          workflow: "eid-lookup",
          id: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          status: "done",
          data: { emplId: "10000001" },
          timestamp: "2026-05-04T12:00:30.000Z",
        }),
        getLatestParentRun: async () => null,
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(result.dependenciesResolved, 0);
    assert.equal(result.continuationsApplied, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /parent run .* not found/);
    assert.equal(getDependencySummary(store, parentTaskId).pending, 1);
    assert.equal(emitted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler marks dependency terminal after already-applied OCR continuation without duplicate tracker event", async () => {
  const { dir, store, parentTaskId } = makeStoreWithOnePendingDependency();
  try {
    const emitted: unknown[] = [];
    const result = await runDependencySchedulerTick({
      store,
      now: "2026-05-04T12:02:00.000Z",
      projection: {
        getLatestRun: async () => ({
          workflow: "eid-lookup",
          id: "ocr-oath-ocr-run-1-r0",
          runId: "child-run-0",
          status: "done",
          data: { emplId: "10000001", hrStatus: "Active", department: "Housing Dining Hospitality" },
          timestamp: "2026-05-04T12:00:30.000Z",
        }),
        getLatestParentRun: async () => ({
          workflow: "ocr",
          id: "session-1",
          runId: "ocr-run-1",
          status: "running",
          step: "awaiting-approval",
          data: {
            records: JSON.stringify([{
              printedName: "Liam",
              employeeId: "10000001",
              matchState: "resolved",
              matchSource: "eid-lookup",
              selected: true,
              verification: {
                state: "verified",
                hrStatus: "Active",
                department: "Housing Dining Hospitality",
                screenshotFilename: "",
                checkedAt: "2026-05-04T12:01:00.000Z",
              },
            }]),
          },
          timestamp: "2026-05-04T12:01:00.000Z",
        }),
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(result.dependenciesResolved, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(emitted.length, 0);
    assert.equal(getDependencySummary(store, parentTaskId).satisfied, 1);
    assert.equal(getTaskByTrackerIdentity(store, {
      workflow: "ocr",
      itemId: "session-1",
      runId: "ocr-run-1",
    })?.status, "waiting_on_children");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler resolves only terminal child while another dependency remains pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-partial-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
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
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-ocr-run-1-r1",
          runId: "child-run-1",
          taskKind: "workflow_item",
          status: "queued",
          dependencyKind: "ocr-eid-lookup",
          failurePolicy: "record_unresolved",
          metadata: { recordIndex: 1, lookupKind: "name", formType: "oath" },
        },
      ],
      now: "2026-05-04T12:00:00.000Z",
    });

    const emitted: unknown[] = [];
    const result = await runDependencySchedulerTick({
      store,
      now: "2026-05-04T12:01:00.000Z",
      projection: {
        getLatestRun: async ({ itemId }) => {
          if (itemId === "ocr-oath-ocr-run-1-r0") {
            return {
              workflow: "eid-lookup",
              id: "ocr-oath-ocr-run-1-r0",
              runId: "child-run-0",
              status: "done",
              data: { emplId: "10000001", hrStatus: "Active", department: "Housing Dining Hospitality" },
              timestamp: "2026-05-04T12:00:30.000Z",
            };
          }
          return {
            workflow: "eid-lookup",
            id: "ocr-oath-ocr-run-1-r1",
            runId: "child-run-1",
            status: "running",
            data: {} as Record<string, string>,
            timestamp: "2026-05-04T12:00:30.000Z",
          };
        },
        getLatestParentRun: async () => ({
          workflow: "ocr",
          id: "session-1",
          runId: "ocr-run-1",
          status: "running",
          step: "awaiting-approval",
          data: {
            records: JSON.stringify([
              { printedName: "Liam", matchState: "lookup-pending", selected: true },
              { printedName: "Avery", matchState: "lookup-pending", selected: true },
            ]),
          },
          timestamp: "2026-05-04T12:00:00.000Z",
        }),
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.equal(result.dependenciesResolved, 1);
    assert.deepEqual(getDependencySummary(store, batch.parentTaskId), {
      total: 2,
      pending: 1,
      satisfied: 1,
      failed: 0,
      cancelled: 0,
    });
    assert.equal(getTaskByTrackerIdentity(store, {
      workflow: "ocr",
      itemId: "session-1",
      runId: "ocr-run-1",
    })?.status, "waiting_on_children");
    assert.equal(getTaskByTrackerIdentity(store, {
      workflow: "eid-lookup",
      itemId: "ocr-oath-ocr-run-1-r0",
      runId: "child-run-0",
    })?.status, "done");
    assert.equal(getTaskByTrackerIdentity(store, {
      workflow: "eid-lookup",
      itemId: "ocr-oath-ocr-run-1-r1",
      runId: "child-run-1",
    })?.status, "queued");
    const attempts = store.db.prepare(`
      SELECT tracker_item_id AS itemId, control_state AS status
      FROM task_attempts
      ORDER BY tracker_item_id
    `).all() as Array<{ itemId: string; status: string }>;
    assert.deepEqual(attempts.map((r) => ({ ...r })), [
      { itemId: "ocr-oath-ocr-run-1-r0", status: "done" },
      { itemId: "ocr-oath-ocr-run-1-r1", status: "pending" },
    ]);
    assert.equal(emitted.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStoreWithOnePendingDependency(): {
  dir: string;
  store: ReturnType<typeof openTaskStoreForTests>;
  parentTaskId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-error-"));
  const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
  const batch = createTaskDependencyBatch(store, {
    parent: {
      workflow: "ocr",
      itemId: "session-1",
      runId: "ocr-run-1",
      taskKind: "ocr",
      status: "waiting_on_children",
      data: {},
    },
    children: [{
      workflow: "eid-lookup",
      itemId: "ocr-oath-ocr-run-1-r0",
      runId: "child-run-0",
      taskKind: "workflow_item",
      status: "queued",
      dependencyKind: "ocr-eid-lookup",
      failurePolicy: "record_unresolved",
      metadata: { recordIndex: 0, lookupKind: "name", formType: "oath" },
    }],
    now: "2026-05-04T12:00:00.000Z",
  });
  return { dir, store, parentTaskId: batch.parentTaskId };
}
