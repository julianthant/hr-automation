import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskDependencyBatch,
  listPendingDependencies,
  openTaskStoreForTests,
} from "../../../../src/tracker/tasks/store.js";
import {
  applyOcrActiveCheckContinuation,
  applyOcrEidLookupContinuation,
} from "../../../../src/tracker/tasks/ocr-continuation.js";

test("applyOcrEidLookupContinuation emits patched awaiting-approval OCR tracker row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-continuation-"));
  try {
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

    const [dependency] = listPendingDependencies(store);
    const emitted: Array<{ data?: Record<string, string>; step?: string; status?: string }> = [];
    const result = await applyOcrEidLookupContinuation({
      store,
      dependency,
      now: "2026-05-04T12:01:00.000Z",
      parentRun: {
        workflow: "ocr",
        id: "session-1",
        runId: "ocr-run-1",
        status: "done",
        step: "awaiting-approval",
        data: {
          pdfOriginalName: "oath.pdf",
          records: JSON.stringify([{ printedName: "Liam", matchState: "lookup-pending", selected: true }]),
        },
        timestamp: "2026-05-04T12:00:00.000Z",
      },
      childRun: {
        workflow: "eid-lookup",
        id: "ocr-oath-ocr-run-1-r0",
        runId: "child-run-0",
        status: "done",
        data: { emplId: "10000001", hrStatus: "Active", department: "Housing Dining Hospitality" },
        timestamp: "2026-05-04T12:00:30.000Z",
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].step, "awaiting-approval");
    assert.equal(emitted[0].status, "running");
    assert.equal(emitted[0].data?.verifiedCount, "1");
    const records = JSON.parse(emitted[0].data?.records ?? "[]") as Array<{ employeeId?: string; verification?: { state?: string } }>;
    assert.equal(records[0].employeeId, "10000001");
    assert.equal(records[0].verification?.state, "verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOcrEidLookupContinuation does not emit duplicate row for already resolved EID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-continuation-idempotent-"));
  try {
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

    const [dependency] = listPendingDependencies(store);
    const emitted: unknown[] = [];
    const result = await applyOcrEidLookupContinuation({
      store,
      dependency,
      now: "2026-05-04T12:02:00.000Z",
      parentRun: {
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
      },
      childRun: {
        workflow: "eid-lookup",
        id: "ocr-oath-ocr-run-1-r0",
        runId: "child-run-0",
        status: "done",
        data: { emplId: "10000001", hrStatus: "Active", department: "Housing Dining Hospitality" },
        timestamp: "2026-05-04T12:00:30.000Z",
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(emitted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOcrEidLookupContinuation does not duplicate failed lookup warnings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-continuation-failed-idempotent-"));
  try {
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

    const [dependency] = listPendingDependencies(store);
    const emitted: unknown[] = [];
    const result = await applyOcrEidLookupContinuation({
      store,
      dependency,
      now: "2026-05-04T12:02:00.000Z",
      parentRun: {
        workflow: "ocr",
        id: "session-1",
        runId: "ocr-run-1",
        status: "running",
        step: "awaiting-approval",
        data: {
          records: JSON.stringify([{
            printedName: "Liam",
            matchState: "unresolved",
            selected: true,
            warnings: ["eid-lookup failed"],
          }]),
        },
        timestamp: "2026-05-04T12:01:00.000Z",
      },
      childRun: {
        workflow: "eid-lookup",
        id: "ocr-oath-ocr-run-1-r0",
        runId: "child-run-0",
        status: "failed",
        data: {},
        error: "no result",
        timestamp: "2026-05-04T12:00:30.000Z",
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(emitted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOcrActiveCheckContinuation emits verified OCR tracker row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-active-continuation-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
    createTaskDependencyBatch(store, {
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

    const [dependency] = listPendingDependencies(store);
    const emitted: Array<{ data?: Record<string, string>; step?: string; status?: string }> = [];
    const result = await applyOcrActiveCheckContinuation({
      store,
      dependency,
      now: "2026-05-05T12:01:00.000Z",
      parentRun: {
        workflow: "ocr",
        id: "session-active",
        runId: "ocr-run-active",
        status: "running",
        step: "awaiting-approval",
        data: {
          records: JSON.stringify([{ printedName: "Liam", employeeId: "10000001", matchState: "matched", selected: true }]),
        },
        timestamp: "2026-05-05T12:00:00.000Z",
      },
      childRun: {
        workflow: "active-check",
        id: "ocr-active-ocr-run-active-r0",
        runId: "active-child-0",
        status: "done",
        data: {
          emplId: "10000001",
          activeStatus: "active",
          isActive: "true",
          isHdhAccepted: "true",
          hrStatus: "Active",
          department: "Housing Dining Hospitality",
          personOrgScreenshot: "active-check.png",
        },
        timestamp: "2026-05-05T12:00:30.000Z",
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].step, "awaiting-approval");
    assert.equal(emitted[0].status, "running");
    assert.equal(emitted[0].data?.verifiedCount, "1");
    const records = JSON.parse(emitted[0].data?.records ?? "[]") as Array<{ verification?: { state?: string; screenshotFilename?: string }; selected?: boolean }>;
    assert.equal(records[0].verification?.state, "verified");
    assert.equal(records[0].verification?.screenshotFilename, "active-check.png");
    assert.equal(records[0].selected, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOcrActiveCheckContinuation flags inactive records for manual edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-active-continuation-inactive-"));
  try {
    const store = openTaskStoreForTests(join(dir, "tracker.sqlite"));
    createTaskDependencyBatch(store, {
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

    const [dependency] = listPendingDependencies(store);
    const emitted: Array<{ data?: Record<string, string> }> = [];
    const result = await applyOcrActiveCheckContinuation({
      store,
      dependency,
      now: "2026-05-05T12:01:00.000Z",
      parentRun: {
        workflow: "ocr",
        id: "session-active",
        runId: "ocr-run-active",
        status: "running",
        step: "awaiting-approval",
        data: {
          records: JSON.stringify([{ printedName: "Liam", employeeId: "10000001", matchState: "matched", selected: true }]),
        },
        timestamp: "2026-05-05T12:00:00.000Z",
      },
      childRun: {
        workflow: "active-check",
        id: "ocr-active-ocr-run-active-r0",
        runId: "active-child-0",
        status: "done",
        data: {
          emplId: "10000001",
          activeStatus: "inactive",
          isActive: "false",
          hrStatus: "Inactive",
          department: "Housing Dining Hospitality",
          terminationDate: "04/30/2026",
        },
        timestamp: "2026-05-05T12:00:30.000Z",
      },
      emitTracker: (entry) => emitted.push(entry),
    });

    assert.deepEqual(result, { ok: true });
    const records = JSON.parse(emitted[0].data?.records ?? "[]") as Array<{ verification?: { state?: string }; selected?: boolean }>;
    assert.equal(records[0].verification?.state, "inactive");
    assert.equal(records[0].selected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
