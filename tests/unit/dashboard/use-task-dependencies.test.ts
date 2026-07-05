import { test } from "vitest";
import assert from "node:assert/strict";

import {
  applyTaskDependencyPoll,
  INITIAL_TASK_DEPENDENCIES_STATE,
  type TaskDependenciesState,
} from "../../../src/dashboard/components/hooks/useTaskDependencies.js";

test("applyTaskDependencyPoll keeps prior summary/children and marks unknown on error (C8 fix)", () => {
  const prev: TaskDependenciesState = {
    summary: { total: 3, pending: 2, satisfied: 1, failed: 0, cancelled: 0 },
    children: [
      { workflow: "person-lookup", itemId: "a", status: "running", metadata: {} },
    ],
    unknown: false,
  };

  const next = applyTaskDependencyPoll(prev, { kind: "error" });

  // The bug: a thrown poll used to clear summary→null, which read as
  // "0 pending" and silently unblocked Approve. Must NOT happen.
  assert.deepEqual(next.summary, prev.summary);
  assert.deepEqual(next.children, prev.children);
  assert.equal(next.unknown, true);
});

test("applyTaskDependencyPoll does not report 0 pending after a failed poll following real pending work", () => {
  const prev: TaskDependenciesState = {
    summary: { total: 1, pending: 1, satisfied: 0, failed: 0, cancelled: 0 },
    children: [],
    unknown: false,
  };

  const next = applyTaskDependencyPoll(prev, { kind: "error" });

  assert.equal(next.summary?.pending, 1, "pending count must survive a poll error");
  assert.equal(next.unknown, true, "caller must treat this as unknown, not 0-pending");
});

test("applyTaskDependencyPoll replaces state and clears unknown on success", () => {
  const prev: TaskDependenciesState = { ...INITIAL_TASK_DEPENDENCIES_STATE, unknown: true };

  const next = applyTaskDependencyPoll(prev, {
    kind: "success",
    summary: { total: 2, pending: 0, satisfied: 2, failed: 0, cancelled: 0 },
    children: [{ workflow: "i9-lookup", itemId: "b", status: "done", metadata: {} }],
  });

  assert.equal(next.unknown, false);
  assert.equal(next.summary?.pending, 0);
  assert.equal(next.children.length, 1);
});

test("applyTaskDependencyPoll success with a null summary still clears unknown (a real, verified 0-dependency state)", () => {
  const prev: TaskDependenciesState = { ...INITIAL_TASK_DEPENDENCIES_STATE, unknown: true };

  const next = applyTaskDependencyPoll(prev, { kind: "success", summary: null, children: [] });

  assert.equal(next.unknown, false);
  assert.equal(next.summary, null);
});

test("applyTaskDependencyPoll is a no-op (same reference) when already unknown and another error arrives", () => {
  const prev: TaskDependenciesState = { ...INITIAL_TASK_DEPENDENCIES_STATE, unknown: true };

  const next = applyTaskDependencyPoll(prev, { kind: "error" });

  assert.equal(next, prev);
});
