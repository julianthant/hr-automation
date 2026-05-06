import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchChildRuns } from "../../../src/tracker/watch-child-runs.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";

function setupTrackerDir(): string {
  const dir = join(tmpdir(), `wcr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEntry(file: string, entry: object): void {
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

test("resolves when all expected itemIds reach terminal status", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  // Pre-write one terminal entry
  writeEntry(file, {
    workflow: "eid-lookup", id: "test-r0", runId: "r0",
    status: "done", data: { emplId: "10000001" }, timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["test-r0", "test-r1"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  // After 100ms, write the second terminal entry
  setTimeout(() => {
    writeEntry(file, {
      workflow: "eid-lookup", id: "test-r1", runId: "r1",
      status: "failed", error: "no result", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 2);
  const r0 = outcomes.find((o) => o.itemId === "test-r0");
  const r1 = outcomes.find((o) => o.itemId === "test-r1");
  assert.ok(r0); assert.equal(r0.status, "done"); assert.equal(r0.data?.emplId, "10000001");
  assert.ok(r1); assert.equal(r1.status, "failed"); assert.equal(r1.error, "no result");
  rmSync(dir, { recursive: true, force: true });
});

test("uses SQLite task rows when all expected child tasks exist", async () => {
  const dir = setupTrackerDir();
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  const [a, b] = taskStore.enqueueTasks({
    workflow: "oath-signature",
    inputs: [{ emplId: "10000001" }, { emplId: "10000002" }],
    deriveItemId: (input) => input.emplId,
    runIds: ["sig-run-a", "sig-run-b"],
  });

  const promise = watchChildRuns({
    workflow: "oath-signature",
    expectedItemIds: ["10000001", "10000002"],
    trackerDir: dir,
    timeoutMs: 5000,
  });

  setTimeout(() => {
    taskStore.markTaskDone({ taskId: a.taskId, attemptId: a.attemptId });
    taskStore.markTaskFailed({ taskId: b.taskId, attemptId: b.attemptId, error: "blocked" });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.find((o) => o.itemId === "10000001")?.status, "done");
  assert.equal(outcomes.find((o) => o.itemId === "10000002")?.status, "failed");
  taskStore.close();
  rmSync(dir, { recursive: true, force: true });
});

test("closes SQLite watcher connection after terminal outcomes", async () => {
  const dir = setupTrackerDir();
  let reopenedStore: ReturnType<typeof createTaskStore> | null = null;
  try {
    const seedStore = createTaskStore(openControlDb({ trackerDir: dir }));
    const [task] = seedStore.enqueueTasks({
      workflow: "oath-signature",
      inputs: [{ emplId: "10000004" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["sig-run-d"],
    });
    seedStore.markTaskDone({ taskId: task.taskId, attemptId: task.attemptId });
    seedStore.close();

    const outcomes = await watchChildRuns({
      workflow: "oath-signature",
      expectedItemIds: ["10000004"],
      trackerDir: dir,
      timeoutMs: 1000,
    });
    assert.equal(outcomes.length, 1);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    reopenedStore = createTaskStore(openControlDb({ trackerDir: dir }));
    assert.deepEqual(reopenedStore.listTasksForWorkflow("oath-signature"), []);
  } finally {
    reopenedStore?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite child failure with block_parent rejects for operator intervention", async () => {
  const dir = setupTrackerDir();
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  const [parent] = taskStore.enqueueTasks({
    workflow: "oath-upload",
    inputs: [{ sessionId: "parent" }],
    deriveItemId: () => "parent",
    runIds: ["parent-run"],
  });
  const [child] = taskStore.enqueueTasks({
    workflow: "oath-signature",
    inputs: [{ emplId: "10000003" }],
    deriveItemId: (input) => input.emplId,
    runIds: ["sig-run-c"],
  });
  taskStore.createDependency({
    parentTaskId: parent.taskId,
    childTaskId: child.taskId,
    onChildFailed: "block_parent",
  });

  const promise = watchChildRuns({
    workflow: "oath-signature",
    expectedItemIds: ["10000003"],
    trackerDir: dir,
    timeoutMs: 5000,
    isTerminal: (entry) => entry.status === "done",
  });

  setTimeout(() => {
    taskStore.markTaskFailed({ taskId: child.taskId, attemptId: child.attemptId, error: "no oath" });
    taskStore.markDependencyFromChildTerminal({ childTaskId: child.taskId, childState: "failed" });
  }, 100);

  await assert.rejects(() => promise, /blocked by parent task/);
  taskStore.close();
  rmSync(dir, { recursive: true, force: true });
});

test("times out cleanly when items don't terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  await assert.rejects(
    () => watchChildRuns({
      workflow: "eid-lookup",
      expectedItemIds: ["never-arrives"],
      trackerDir: dir,
      date,
      timeoutMs: 200,
    }),
    /timeout/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("ignores non-matching itemIds in the JSONL", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");
  writeEntry(file, {
    workflow: "eid-lookup", id: "other-item", runId: "x",
    status: "done", timestamp: new Date().toISOString(),
  });
  writeEntry(file, {
    workflow: "eid-lookup", id: "wanted", runId: "y",
    status: "done", timestamp: new Date().toISOString(),
  });

  const outcomes = await watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["wanted"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "wanted");
  rmSync(dir, { recursive: true, force: true });
});

test("custom isTerminal predicate (waiting for step=approved)", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `ocr-${date}.jsonl`);
  writeFileSync(file, "");

  // status=done step=awaiting-approval should NOT be terminal under custom predicate
  writeEntry(file, {
    workflow: "ocr", id: "session-1", runId: "r1",
    status: "done", step: "awaiting-approval", timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "ocr",
    expectedItemIds: ["session-1"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
    isTerminal: (e) =>
      (e.status === "done" && e.step === "approved") ||
      (e.status === "failed" && (e.step === "discarded" || e.step === "superseded")),
  });

  setTimeout(() => {
    writeEntry(file, {
      workflow: "ocr", id: "session-1", runId: "r1",
      status: "done", step: "approved", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "session-1");
  rmSync(dir, { recursive: true, force: true });
});

test("calls onProgress as items terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  const progressCalls: Array<{ itemId: string; remaining: number }> = [];

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["a", "b", "c"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
    onProgress: (outcome, remaining) => {
      progressCalls.push({ itemId: outcome.itemId, remaining });
    },
  });

  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "a", runId: "1", status: "done", timestamp: new Date().toISOString() }), 50);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "b", runId: "2", status: "done", timestamp: new Date().toISOString() }), 100);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "c", runId: "3", status: "done", timestamp: new Date().toISOString() }), 150);

  await promise;
  assert.equal(progressCalls.length, 3);
  assert.equal(progressCalls[0].remaining, 2);
  assert.equal(progressCalls[1].remaining, 1);
  assert.equal(progressCalls[2].remaining, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("survives when target file doesn't exist initially", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  // file does NOT exist yet

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["arrives-late"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  setTimeout(() => {
    writeFileSync(file, "");
    appendFileSync(file, JSON.stringify({
      workflow: "eid-lookup", id: "arrives-late", runId: "1",
      status: "done", timestamp: new Date().toISOString(),
    }) + "\n");
  }, 200);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("abortIfRowState: rejects when parent row reaches the sentinel step", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const parentFile = join(dir, `oath-upload-${date}.jsonl`);

  // Pre-write a non-sentinel running entry so the file exists.
  writeEntry(parentFile, {
    workflow: "oath-upload", id: "parent-1", runId: "p1",
    status: "running", step: "loading-roster", timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["never-comes"],
    trackerDir: dir,
    date,
    timeoutMs: 30_000,
    abortIfRowState: { workflow: "oath-upload", id: "parent-1", step: "cancel-requested" },
  });

  // After ~250ms append the cancel sentinel — watcher should catch it on the next poll.
  setTimeout(() => {
    writeEntry(parentFile, {
      workflow: "oath-upload", id: "parent-1", runId: "p1",
      status: "running", step: "cancel-requested", timestamp: new Date().toISOString(),
    });
  }, 250);

  await assert.rejects(
    () => promise,
    (err: Error) => {
      assert.ok(/aborted by parent row state/.test(err.message), `unexpected message: ${err.message}`);
      assert.ok(err.message.includes("oath-upload"), `missing workflow in message: ${err.message}`);
      assert.ok(err.message.includes("parent-1"), `missing id in message: ${err.message}`);
      assert.ok(err.message.includes("cancel-requested"), `missing step in message: ${err.message}`);
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("abortIfRowState: rejects immediately when sentinel is pre-written before watch starts", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const parentFile = join(dir, `oath-upload-${date}.jsonl`);

  // Pre-write the cancel sentinel BEFORE calling watchChildRuns.
  writeEntry(parentFile, {
    workflow: "oath-upload", id: "parent-2", runId: "p2",
    status: "running", step: "cancel-requested", timestamp: new Date().toISOString(),
  });

  const start = Date.now();
  await assert.rejects(
    () => watchChildRuns({
      workflow: "eid-lookup",
      expectedItemIds: ["never-comes"],
      trackerDir: dir,
      date,
      timeoutMs: 30_000,
      abortIfRowState: { workflow: "oath-upload", id: "parent-2", step: "cancel-requested" },
    }),
    (err: Error) => {
      assert.ok(/aborted by parent row state/.test(err.message), `unexpected message: ${err.message}`);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  // Should abort during the initial synchronous check — well under 100ms.
  assert.ok(elapsed < 100, `expected immediate abort but took ${elapsed}ms`);
  rmSync(dir, { recursive: true, force: true });
});
