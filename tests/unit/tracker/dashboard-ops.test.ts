/**
 * Dashboard ops handlers — retry input lookup, queue cancel, queue bump,
 * queue depth. Each handler is exercised against a tmp tracker directory
 * to keep the test hermetic. Daemon-list / daemon-spawn / daemon-stop are
 * not exercised here because they require live HTTP probing of running
 * daemons; the underlying file readers (queueFilePath, daemonsDir) are
 * already covered by tests in tests/unit/core/daemon-*.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLogEntries, trackEvent } from "../../../src/tracker/jsonl.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { createWorkerStore } from "../../../src/core/daemon/worker-store.js";
import {
  findEntryInput,
  findLatestEntryData,
  buildCancelQueuedHandler,
  buildCancelRunningHandler,
  buildDrainWorkerHandler,
  buildForceStopTaskHandler,
  buildKillBrowserHandler,
  buildQueueBumpHandler,
  buildStopWorkerHandler,
  buildDaemonsListHandler,
  buildRetryHandler,
  readQueueDepth,
} from "../../../src/tracker/dashboard/ops/index.js";
import { queueFilePath } from "../../../src/core/daemon/queue.js";
import type { QueueEvent } from "../../../src/core/daemon/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dash-ops-"));
});
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("findEntryInput", () => {
  it("returns the input from a pending tracker row", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.deepEqual(result, { input: { docId: "3930" } });
  });

  it("falls back to data when no row has stored input (CLI-enqueued path)", () => {
    // CLI adapters (runSeparationCli etc.) emit pending rows without `input`.
    // findEntryInput must derive the retry payload from `data` so retry works
    // for entries that didn't go through the HTTP enqueue path.
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        // no input field
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.deepEqual(result, { input: { docId: "3930" } });
  });

  it("strips kernel-internal keys from data when falling back", () => {
    // `instance` / `__name` / `__id` are stamped onto rows by the kernel +
    // legacy adapters; they aren't part of any workflow's Zod input schema
    // and must not leak into the reconstructed retry payload.
    trackEvent(
      {
        workflow: "eid-lookup",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "Smith, Jane",
        runId: "u-1",
        status: "pending",
        data: {
          searchName: "Smith, Jane",
          __name: "Smith, Jane",
          __id: "Smith, Jane",
          instance: "EID Lookup 1",
        },
      },
      tmp,
    );
    const result = findEntryInput("eid-lookup", "Smith, Jane", undefined, tmp);
    assert.deepEqual(result, { input: { searchName: "Smith, Jane" } });
  });

  it("returns an error when no entry exists for the id", () => {
    const result = findEntryInput("separations", "9999", undefined, tmp);
    assert.ok("error" in result);
  });

  it("picks the latest pending row when multiple runs exist", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930", v: "first" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T13:00:00.000Z",
        id: "3930",
        runId: "u-2",
        status: "pending",
        data: { docId: "3930" },
        input: { docId: "3930", v: "second" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", undefined, tmp);
    assert.ok("input" in result);
    assert.equal((result.input as { v: string }).v, "second");
  });

  it("filters by runId when supplied", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "u-1",
        status: "pending",
        data: {},
        input: { v: "first" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T13:00:00.000Z",
        id: "3930",
        runId: "u-2",
        status: "pending",
        data: {},
        input: { v: "second" },
      },
      tmp,
    );
    const result = findEntryInput("separations", "3930", "u-1", tmp);
    assert.ok("input" in result);
    assert.equal((result.input as { v: string }).v, "first");
  });

  it("prefers SQLite task input by runId before tracker fallback", () => {
    const store = createTaskStore(openControlDb({ trackerDir: tmp }));
    const [task] = store.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "3930", source: "sqlite" }],
      deriveItemId: (input) => input.docId,
      runIds: ["sqlite-run-1"],
    });
    assert.equal(task.runId, "sqlite-run-1");
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-24T12:00:00.000Z",
        id: "3930",
        runId: "sqlite-run-1",
        status: "pending",
        data: {},
        input: { docId: "3930", source: "tracker" },
      },
      tmp,
    );

    const result = findEntryInput("separations", "3930", "sqlite-run-1", tmp);
    assert.deepEqual(result, { input: { docId: "3930", source: "sqlite" } });
  });
});

describe("findLatestEntryData", () => {
  it("merges fields across rows so a later reduced-data row can't drop earlier ones", () => {
    // First row: full extraction data including rawTerminationType.
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T10:00:00.000Z",
        id: "X",
        runId: "u-1",
        status: "running",
        data: { name: "Le, J", eid: "EID1", rawTerminationType: "No Reason Given" },
      },
      tmp,
    );
    // Second row: synthetic cancel-queued / save-data row that only carries
    // the editable subset. Without merge-across-rows, this would clobber
    // rawTerminationType for the next edit-and-resume.
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T11:00:00.000Z",
        id: "X",
        runId: "u-1",
        status: "failed",
        step: "cancelled",
        data: { name: "Le, J", eid: "EID1" },
      },
      tmp,
    );
    const merged = findLatestEntryData("separations", "X", tmp);
    assert.deepEqual(merged, { name: "Le, J", eid: "EID1", rawTerminationType: "No Reason Given" });
  });

  it("excludes kernel-internal keys (__name, __id, instance)", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T10:00:00.000Z",
        id: "X",
        runId: "u-1",
        status: "done",
        data: { name: "Le, J", __name: "Le, J", __id: "X", instance: "Separation 1" },
      },
      tmp,
    );
    assert.deepEqual(findLatestEntryData("separations", "X", tmp), { name: "Le, J" });
  });

  it("returns empty object when no rows have data", () => {
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T10:00:00.000Z",
        id: "X",
        runId: "u-1",
        status: "failed",
        error: "x",
      },
      tmp,
    );
    assert.deepEqual(findLatestEntryData("separations", "X", tmp), {});
  });

  it("ignores empty-string values when merging", () => {
    // Done rows often emit empty strings for missing fields (see the doc 3936
    // run #1 "done" row, which had transactionNumber:"" because the txn # was
    // never extracted). The merge must not let "" replace a real value.
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T10:00:00.000Z",
        id: "X",
        runId: "u-1",
        status: "running",
        data: { transactionNumber: "T002109055" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "separations",
        timestamp: "2026-04-27T10:01:00.000Z",
        id: "X",
        runId: "u-1",
        status: "done",
        data: { transactionNumber: "" },
      },
      tmp,
    );
    assert.deepEqual(findLatestEntryData("separations", "X", tmp), { transactionNumber: "T002109055" });
  });
});

describe("buildCancelQueuedHandler", () => {
  it("cancels a queued SQLite task and writes a completed cancel_task command", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const workerStore = createWorkerStore(control);
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "3930" }],
      deriveItemId: (input) => input.docId,
      runIds: ["sqlite-run-queued"],
    });

    const result = await buildCancelQueuedHandler(tmp)({
      workflow: "separations",
      id: "3930",
      runId: "sqlite-run-queued",
    });

    assert.equal(result.ok, true);
    assert.equal(taskStore.getTask(enqueued.taskId)?.state, "cancelled");
    assert.equal(taskStore.getAttempt(enqueued.attemptId)?.state, "cancelled");
    const commands = workerStore.db.prepare("SELECT * FROM worker_commands").all() as Array<{
      command_type: string;
      state: string;
      target_task_id: string;
    }>;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command_type, "cancel_task");
    assert.equal(commands[0].state, "completed");
    assert.equal(commands[0].target_task_id, enqueued.taskId);
    const queueAudit = readFileSync(queueFilePath("separations", tmp), "utf8");
    assert.ok(queueAudit.includes('"type":"failed"'));
    assert.ok(queueAudit.includes("cancelled by user from dashboard"));
    const logs = readLogEntries("separations", "3930", tmp);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].runId, "sqlite-run-queued");
    assert.match(logs[0].message, /cancelled by user from dashboard/);
    workerStore.close();
  });

  it("returns 409 when a SQLite task is already running", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "3931" }],
      deriveItemId: (input) => input.docId,
      runIds: ["sqlite-run-running"],
    });
    const claimed = taskStore.claimNextTask({ workflow: "separations", workerId: "sep-worker" });
    assert.ok(claimed);
    taskStore.markTaskRunning({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      workerId: "sep-worker",
    });

    const result = await buildCancelQueuedHandler(tmp)({
      workflow: "separations",
      id: "3931",
      runId: "sqlite-run-running",
    });

    assert.equal(result.ok, false);
    assert.equal((result as { status?: number }).status, 409);
    taskStore.close();
  });

  it("appends a synthetic failed event for a queued item + writes a tracker row", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const enqueueEv: QueueEvent = {
      type: "enqueue",
      id: "3930",
      workflow: "separations",
      input: { docId: "3930" },
      enqueuedAt: "2026-04-24T12:00:00.000Z",
      enqueuedBy: "test",
      runId: "u-1",
    };
    writeFileSync(path, JSON.stringify(enqueueEv) + "\n");
    const handler = buildCancelQueuedHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, true);
    const after = readFileSync(path, "utf8");
    assert.ok(after.includes('"type":"failed"'));
    assert.ok(after.includes("cancelled by user from dashboard"));
    const logs = readLogEntries("separations", "3930", tmp);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].runId, "u-1");
    assert.match(logs[0].message, /cancelled by user from dashboard/);
  });

  it("returns 409 when the item is already claimed", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "3930",
        workflow: "separations",
        input: { docId: "3930" },
        enqueuedAt: "2026-04-24T12:00:00.000Z",
        enqueuedBy: "test",
        runId: "u-1",
      },
      {
        type: "claim",
        id: "3930",
        claimedBy: "sep-abc",
        claimedAt: "2026-04-24T12:01:00.000Z",
        runId: "u-1",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildCancelQueuedHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, false);
    assert.equal((result as { status?: number }).status, 409);
  });
});

describe("buildCancelRunningHandler", () => {
  it("queues cancel_task for the owning worker and marks the task cancel_requested", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const workerStore = createWorkerStore(control);
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "processing",
    });
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "4000" }],
      deriveItemId: (input) => input.docId,
      runIds: ["run-cancel-running"],
    });
    const claimed = taskStore.claimNextTask({ workflow: "separations", workerId: "sep-worker" });
    assert.ok(claimed);
    taskStore.markTaskRunning({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      workerId: "sep-worker",
    });

    const result = await buildCancelRunningHandler(tmp)({
      workflow: "separations",
      id: "4000",
      runId: "run-cancel-running",
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "worker-command");
    assert.equal(taskStore.getTask(enqueued.taskId)?.state, "cancel_requested");
    assert.equal(taskStore.getAttempt(enqueued.attemptId)?.state, "cancel_requested");
    const command = workerStore.getCommand(result.commandId);
    assert.equal(command?.commandType, "cancel_task");
    assert.equal(command?.state, "queued");
    assert.equal(command?.targetWorkerId, "sep-worker");
    assert.equal(command?.targetTaskId, enqueued.taskId);
    assert.equal(command?.targetAttemptId, enqueued.attemptId);
    const logs = readLogEntries("separations", "4000", tmp);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].runId, "run-cancel-running");
    assert.match(logs[0].message, /Cancellation requested by dashboard/);
    workerStore.close();
  });
});

describe("dashboard worker command helpers", () => {
  it("force-stops a task by terminalizing it as cancelled and killing its browser", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const workerStore = createWorkerStore(control);
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "processing",
    });
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "5000" }],
      deriveItemId: (input) => input.docId,
      runIds: ["run-force-stop"],
    });
    taskStore.claimNextTask({ workflow: "separations", workerId: "sep-worker" });
    taskStore.markTaskRunning({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      workerId: "sep-worker",
    });
    const browser = workerStore.upsertBrowserProcess({
      workerId: "sep-worker",
      workflow: "separations",
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      systemId: "ucpath",
      browserId: "ucpath",
      pid: 987654,
    });

    const result = await buildForceStopTaskHandler(tmp)({
      workflow: "separations",
      id: "5000",
      runId: "run-force-stop",
    });

    assert.equal(result.ok, true);
    assert.equal(result.killCommands.length, 1);
    assert.equal(workerStore.getCommand(result.commandId)?.commandType, "force_stop_task");
    assert.equal(workerStore.getCommand(result.commandId)?.state, "queued");
    assert.equal(taskStore.getTask(enqueued.taskId)?.state, "cancelled");
    assert.equal(taskStore.getAttempt(enqueued.attemptId)?.state, "cancelled");
    const killCommand = workerStore.getCommand(result.killCommands[0]);
    assert.equal(killCommand?.commandType, "kill_browser");
    assert.equal(killCommand?.state, "queued");
    assert.equal(killCommand?.targetBrowserProcessId, browser.browserProcessId);
    assert.equal(workerStore.findBrowserProcessById(browser.browserProcessId)?.status, "kill_requested");
    const trackerFile = readdirSync(tmp).find((file) => /^separations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file));
    assert.ok(trackerFile, "force-stop should emit a separations tracker file");
    const entries = readFileSync(join(tmp, trackerFile), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const cancelled = entries.find((entry) => entry.runId === "run-force-stop" && entry.status === "failed");
    assert.equal(cancelled?.step, "cancelled");
    assert.equal(cancelled?.error, "cancelled by user from dashboard");
    workerStore.close();
  });

  it("kill-browser targets a single browser process", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const workerStore = createWorkerStore(control);
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "processing",
    });
    const browser = workerStore.upsertBrowserProcess({
      workerId: "sep-worker",
      workflow: "separations",
      systemId: "ucpath",
      browserId: "ucpath",
      pid: 987655,
    });

    const result = await buildKillBrowserHandler(tmp)({ browserProcessId: browser.browserProcessId });

    assert.equal(result.ok, true);
    assert.equal(workerStore.getCommand(result.commandId)?.commandType, "kill_browser");
    assert.equal(workerStore.findBrowserProcessById(browser.browserProcessId)?.status, "kill_requested");
    workerStore.close();
  });

  it("stop and drain worker write queued worker commands", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const workerStore = createWorkerStore(control);
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "idle",
    });

    const stop = await buildStopWorkerHandler(tmp)({ workerId: "sep-worker" });
    const drain = await buildDrainWorkerHandler(tmp)({ workerId: "sep-worker" });

    assert.equal(stop.ok, true);
    assert.equal(drain.ok, true);
    assert.equal(workerStore.getCommand(stop.commandId)?.commandType, "stop_worker");
    assert.equal(workerStore.getCommand(stop.commandId)?.state, "queued");
    assert.equal(workerStore.getCommand(drain.commandId)?.commandType, "drain_worker");
    assert.equal(workerStore.getCommand(drain.commandId)?.state, "queued");
    workerStore.close();
  });

  it("daemon list omits terminal dead workers that no longer have a live lockfile", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const workerStore = createWorkerStore(control);
    workerStore.registerWorker({
      workerId: "eid-dead",
      workflow: "eid-lookup",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "exited",
      status: "dead",
    });

    const rows = await buildDaemonsListHandler(tmp)("eid-lookup");

    assert.deepEqual(rows, []);
    workerStore.close();
  });

  it("daemon list marks heartbeat-expired workers stale and removes their cards", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const workerStore = createWorkerStore(control);
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "stale-doc" }],
      deriveItemId: (input) => input.docId,
      runIds: ["run-stale-worker"],
      now: "2026-05-05T10:00:00.000Z",
    });
    workerStore.registerWorker({
      workerId: "stale-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "processing",
      heartbeatTtlMs: 1,
      now: "2026-05-05T10:00:00.000Z",
    });
    workerStore.heartbeatWorker({
      workerId: "stale-worker",
      phase: "processing",
      currentTaskId: enqueued.taskId,
      currentAttemptId: enqueued.attemptId,
      now: "2026-05-05T10:00:00.000Z",
    });

    const daemons = await buildDaemonsListHandler(tmp)("separations");

    assert.deepEqual(daemons.map((daemon) => daemon.workerId), []);
    assert.equal(workerStore.getWorker("stale-worker")?.status, "stale");
    assert.equal(workerStore.getWorker("stale-worker")?.currentTaskId, undefined);
    workerStore.close();
  });
});

describe("buildRetryHandler SQLite lineage", () => {
  it("writes a completed retry_task command and creates the next attempt", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);
    const workerStore = createWorkerStore(control);
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "6000" }],
      deriveItemId: (input) => input.docId,
      runIds: ["run-failed"],
    });
    taskStore.claimNextTask({ workflow: "separations", workerId: "sep-worker" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "boom",
    });

    const result = await buildRetryHandler(tmp)({
      workflow: "separations",
      id: "6000",
      runId: "run-failed",
    });

    assert.equal(result.ok, true);
    assert.equal(taskStore.listAttemptsForTask(enqueued.taskId).length, 2);
    assert.equal(taskStore.getTask(enqueued.taskId)?.state, "queued");
    const commands = workerStore.db.prepare("SELECT * FROM worker_commands WHERE command_type = 'retry_task'").all() as Array<{
      state: string;
      target_task_id: string;
    }>;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].state, "completed");
    assert.equal(commands[0].target_task_id, enqueued.taskId);
    workerStore.close();
  });
});

describe("buildQueueBumpHandler", () => {
  it("bumps a queued SQLite task so it is claimed next", async () => {
    const store = createTaskStore(openControlDb({ trackerDir: tmp }));
    try {
      store.enqueueTasks({
        workflow: "separations",
        inputs: [{ docId: "first" }, { docId: "second" }, { docId: "third" }],
        deriveItemId: (input) => input.docId,
      });
      const third = store.findTaskByIdentity({ workflow: "separations", itemId: "third" });
      assert.ok(third?.runId);

      const handler = buildQueueBumpHandler(tmp);
      const result = await handler({ workflow: "separations", id: "third", runId: third.runId });
      assert.equal(result.ok, true);

      const claimed = store.claimNextTask({ workflow: "separations", workerId: "worker-1" });
      assert.equal(claimed?.itemId, "third");
    } finally {
      store.close();
    }
  });

  it("moves a queued item's enqueue event to the head of the file", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "first",
        workflow: "separations",
        input: { docId: "first" },
        enqueuedAt: "t1",
        enqueuedBy: "test",
      },
      {
        type: "enqueue",
        id: "second",
        workflow: "separations",
        input: { docId: "second" },
        enqueuedAt: "t2",
        enqueuedBy: "test",
      },
      {
        type: "enqueue",
        id: "third",
        workflow: "separations",
        input: { docId: "third" },
        enqueuedAt: "t3",
        enqueuedBy: "test",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildQueueBumpHandler(tmp);
    const result = await handler({ workflow: "separations", id: "third" });
    assert.equal(result.ok, true);
    const after = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(after.length, 3);
    const firstParsed = JSON.parse(after[0]) as QueueEvent;
    assert.equal((firstParsed as { id: string }).id, "third");
  });

  it("rejects bumping a claimed item with status 409", async () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      {
        type: "enqueue",
        id: "3930",
        workflow: "separations",
        input: { docId: "3930" },
        enqueuedAt: "t1",
        enqueuedBy: "test",
      },
      {
        type: "claim",
        id: "3930",
        claimedBy: "sep-abc",
        claimedAt: "t2",
        runId: "u-1",
      },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const handler = buildQueueBumpHandler(tmp);
    const result = await handler({ workflow: "separations", id: "3930" });
    assert.equal(result.ok, false);
    assert.equal((result as { status?: number }).status, 409);
  });
});

describe("readQueueDepth", () => {
  it("counts queued SQLite tasks", () => {
    const store = createTaskStore(openControlDb({ trackerDir: tmp }));
    const [a, b] = store.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "a" }, { docId: "b" }],
      deriveItemId: (input) => input.docId,
    });
    store.markTaskCancelled({ taskId: b.taskId, attemptId: b.attemptId, reason: "not needed" });
    assert.equal(readQueueDepth("separations", tmp), 1);
    assert.equal(store.getTask(a.taskId)?.state, "queued");
    store.close();
  });

  it("counts only items in the queued state", () => {
    const path = queueFilePath("separations", tmp);
    mkdirSync(join(tmp, "daemons"), { recursive: true });
    const events: QueueEvent[] = [
      { type: "enqueue", id: "a", workflow: "separations", input: {}, enqueuedAt: "t1", enqueuedBy: "test" },
      { type: "enqueue", id: "b", workflow: "separations", input: {}, enqueuedAt: "t2", enqueuedBy: "test" },
      { type: "enqueue", id: "c", workflow: "separations", input: {}, enqueuedAt: "t3", enqueuedBy: "test" },
      { type: "claim", id: "a", claimedBy: "x", claimedAt: "t4", runId: "u-a" },
      { type: "done", id: "b", completedAt: "t5", runId: "u-b" },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(readQueueDepth("separations", tmp), 1);
  });

  it("returns 0 when the queue file does not exist", () => {
    assert.equal(readQueueDepth("never-existed", tmp), 0);
  });
});
