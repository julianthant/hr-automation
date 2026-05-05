import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskDependencyBatch,
  getDependencySummary,
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

function makeStoreWithOnePendingDependency(): {
  dir: string;
  store: ReturnType<typeof openTaskStoreForTests>;
} {
  const dir = mkdtempSync(join(tmpdir(), "task-scheduler-error-"));
  const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
  createTaskDependencyBatch(store, {
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
  return { dir, store };
}
