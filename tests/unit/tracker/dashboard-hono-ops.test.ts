import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openControlDb } from "../../../src/core/control-db.js";
import { queueFilePath } from "../../../src/core/daemon/queue.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { createWorkerStore } from "../../../src/core/daemon/worker-store.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import { dateLocal, trackEventForDate } from "../../../src/tracker/jsonl.js";
import { rowFilePath, rowsDir } from "../../../src/tracker/paths.js";
import {
  resetDaemonSpawnStubs,
  stubDaemonSpawn,
} from "../../_utils/stub-daemon-spawn.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-ops-"));
});

afterEach(async () => {
  await resetDaemonSpawnStubs();
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({ dir, stateDb: openStateDb(dir) });
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("Hono /api/cancel-queued cancels a queued task", async () => {
  const control = openControlDb({ trackerDir: dir });
  const taskStore = createTaskStore(control);
  try {
    const [task] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "3930" }],
      deriveItemId: (input) => input.docId,
      runIds: ["run-queued"],
    });
    trackEventForDate({
      workflow: "separations",
      timestamp: new Date().toISOString(),
      id: "3930",
      runId: "run-queued",
      status: "pending",
      data: { archetype: "single" },
      input: { docId: "3930" },
    }, dateLocal(), dir);

    const res = await app().request("/api/cancel-queued", jsonRequest({
      workflow: "separations",
      id: "3930",
      runId: "run-queued",
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(taskStore.getTask(task.taskId)?.state, "cancelled");
    assert.equal(taskStore.getAttempt(task.attemptId)?.state, "cancelled");
  } finally {
    taskStore.close();
  }
});

test("Hono /api/cancel-queued honors explicit tree scope for descendants", async () => {
  openStateDb(dir);
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  try {
    const date = "2026-05-20";
    const [parent] = taskStore.enqueueTasks({
      workflow: "oath-upload",
      inputs: [{ sessionId: "oath-parent" }],
      deriveItemId: (input) => input.sessionId,
      runIds: ["oath-parent-run"],
    });
    const [child] = taskStore.enqueueTasks({
      workflow: "oath-signature",
      inputs: [{ emplId: "10000001" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["signature-child-run"],
      parentRunId: "oath-parent-run",
    });
    trackEventForDate({
      workflow: "oath-upload",
      timestamp: "2026-05-20T10:00:00.000Z",
      id: "oath-parent",
      runId: "oath-parent-run",
      status: "pending",
      data: { archetype: "operation" },
    }, date, dir);
    trackEventForDate({
      workflow: "oath-signature",
      timestamp: "2026-05-20T10:01:00.000Z",
      id: "10000001",
      runId: "signature-child-run",
      parentRunId: "oath-parent-run",
      status: "pending",
    }, date, dir);

    const res = await app().request("/api/cancel-queued", jsonRequest({
      workflow: "oath-upload",
      id: "oath-parent",
      runId: "oath-parent-run",
      scope: "tree",
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(taskStore.getTask(parent.taskId)?.state, "cancelled");
    assert.equal(taskStore.getTask(child.taskId)?.state, "cancelled");
  } finally {
    taskStore.close();
  }
});

test("Hono /api/cancel-queued routes OCR discard context through workflow actions", async () => {
  trackEventForDate({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: "ocr-session",
    runId: "ocr-run",
    status: "pending",
    data: { archetype: "operation" },
  }, dateLocal(), dir);
  trackEventForDate({
    workflow: "oath-upload",
    timestamp: new Date().toISOString(),
    id: "oath-parent",
    runId: "parent-run",
    status: "running",
    data: { archetype: "single" },
  }, dateLocal(), dir);

  const res = await app().request("/api/cancel-queued", jsonRequest({
    workflow: "oath-upload",
    id: "oath-parent",
    runId: "ocr-run",
    ocrSessionId: "ocr-session",
    reason: "Cancelled from oath-upload queue",
    parentWorkflow: "oath-upload",
    parentRunId: "parent-run",
    parentItemId: "oath-parent",
    formType: "oath-signature",
  }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const parentFile = rowFilePath("oath-upload", dateLocal(), dir);
  assert.ok(existsSync(parentFile));
  const parentLines = readFileSync(parentFile, "utf-8").split("\n").filter(Boolean);
  const parent = JSON.parse(parentLines[parentLines.length - 1]);
  assert.equal(parent.id, "oath-parent");
  assert.equal(parent.runId, "parent-run");
  assert.equal(parent.status, "failed");
  assert.equal(parent.step, "discarded");
  assert.equal(parent.error, "Cancelled from oath-upload queue");
});

test("Hono /api/cancel-queued auto-routes emergency-contact operation prep rows to OCR discard", async () => {
  const date = dateLocal();
  trackEventForDate({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: "ec-ocr-session",
    runId: "ec-ocr-run",
    status: "running",
    step: "preparing",
    data: {
      archetype: "operation",
      mode: "prepare",
      formType: "emergency-contact",
      operationWorkflow: "emergency-contact",
    },
  }, date, dir);
  trackEventForDate({
    workflow: "emergency-contact",
    timestamp: new Date().toISOString(),
    id: "ocr-prep-ec-ocr-session",
    runId: "ec-coord-run",
    status: "running",
    step: "ocr-prep",
    data: {
      archetype: "operation",
      mode: "prepare",
      formType: "emergency-contact",
      ocrSessionId: "ec-ocr-session",
      ocrRunId: "ec-ocr-run",
      ocrStatus: "preparing",
      pdfOriginalName: "contacts.pdf",
    },
  }, date, dir);

  const res = await app().request("/api/cancel-queued", jsonRequest({
    workflow: "emergency-contact",
    id: "ocr-prep-ec-ocr-session",
    runId: "ec-coord-run",
    status: "running",
  }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const ecFile = rowFilePath("emergency-contact", date, dir);
  const ecLines = readFileSync(ecFile, "utf-8").split("\n").filter(Boolean);
  const ecRow = JSON.parse(ecLines[ecLines.length - 1]);
  assert.equal(ecRow.status, "failed");
  assert.equal(ecRow.step, "discarded");
});

test("Hono /api/cancel-queued treeExcludeRoots cancels member tasks under a display-only coordinator", async () => {
  openStateDb(dir);
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  try {
    const date = "2026-05-21";
    const [child] = taskStore.enqueueTasks({
      workflow: "emergency-contact",
      inputs: [{ emplId: "10000002" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["ec-member-run"],
      parentRunId: "ec-coord-run-2",
    });
    trackEventForDate({
      workflow: "emergency-contact",
      timestamp: "2026-05-21T10:00:00.000Z",
      id: "input-run-ec-coord",
      runId: "ec-coord-run-2",
      status: "pending",
      data: { archetype: "operation" },
    }, date, dir);
    trackEventForDate({
      workflow: "emergency-contact",
      timestamp: "2026-05-21T10:01:00.000Z",
      id: "10000002",
      runId: "ec-member-run",
      parentRunId: "ec-coord-run-2",
      status: "pending",
      data: { archetype: "operation-member" },
    }, date, dir);

    const res = await app().request("/api/cancel-queued", jsonRequest({
      workflow: "emergency-contact",
      id: "input-run-ec-coord",
      runId: "ec-coord-run-2",
      scope: "tree",
      treeExcludeRoots: true,
      status: "pending",
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(taskStore.getTask(child.taskId)?.state, "cancelled");
  } finally {
    taskStore.close();
  }
});

test("Hono /api/cancel-queued terminalizes a stranded operation coordinator with no task and no live descendants", async () => {
  // Reproduces the real-world orphan: an operation coordinator is a display-only
  // row with NO SQLite task of its own (by design), and its fan-out members
  // already completed off-projection (or were never projected) — so a single-row
  // × finds no task AND no live descendants. Before the fix this dead-ended with
  // "task not found in SQLite control store" and stranded the row in the queue
  // forever (a pending row offers no delete affordance). Cancel must instead
  // terminalize the display row so it leaves the queue. Protects every workflow
  // that produces an operation coordinator (oath-signature / emergency-contact /
  // onbase + any multi-person input run), not just the one that surfaced it.
  openStateDb(dir);
  const date = dateLocal();
  trackEventForDate({
    workflow: "oath-signature",
    timestamp: new Date().toISOString(),
    id: "input-run-orphan",
    runId: "coord-run-orphan",
    status: "pending",
    data: { archetype: "operation", queueRowKind: "person" },
  }, date, dir);

  // Single-row × → scope defaults to "row", no treeExcludeRoots. No task was
  // ever enqueued for the coordinator, and no descendant rows exist.
  const res = await app().request("/api/cancel-queued", jsonRequest({
    workflow: "oath-signature",
    id: "input-run-orphan",
    runId: "coord-run-orphan",
    date,
  }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const file = rowFilePath("oath-signature", date, dir);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]) as {
    id: string; runId: string; status: string; step: string; data: { archetype: string };
  };
  assert.equal(last.id, "input-run-orphan");
  assert.equal(last.runId, "coord-run-orphan");
  assert.equal(last.status, "failed");
  assert.equal(last.step, "cancelled");
  assert.equal(last.data.archetype, "operation");
});

test("Hono /api/cancel-queued still 404s a genuinely missing item (no phantom terminal row)", async () => {
  // The terminalize path must NOT fabricate a cancelled row when there is no
  // prior tracker row to inherit from — a missing item with a runId keeps the
  // honest not-found error rather than silently "succeeding".
  openStateDb(dir);
  mkdirSync(join(dir, "daemons"), { recursive: true });
  writeFileSync(queueFilePath("separations", dir), "");

  const res = await app().request("/api/cancel-queued", jsonRequest({
    workflow: "separations",
    id: "ghost",
    runId: "ghost-run",
  }));

  assert.equal(res.status, 404);
  const body = await res.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "task not found in SQLite control store");
});

test("Hono /api/cancel-queued returns not-found shape for missing queue item", async () => {
  mkdirSync(join(dir, "daemons"), { recursive: true });
  writeFileSync(queueFilePath("separations", dir), "");
  const res = await app().request("/api/cancel-queued", jsonRequest({
    workflow: "separations",
    id: "missing",
  }));

  assert.equal(res.status, 404);
  const body = await res.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "task not found in SQLite control store");
});

test("Hono /api/cancel-running requires workflow, id, and runId", async () => {
  const res = await app().request("/api/cancel-running", jsonRequest({
    workflow: "separations",
    id: "3930",
  }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "workflow, id, runId are required",
  });
});

test("Hono /api/queue/bump moves a queued SQLite task ahead and validates input", async () => {
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  try {
    taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "first" }, { docId: "second" }, { docId: "third" }],
      deriveItemId: (input) => input.docId,
    });
    const third = taskStore.findTaskByIdentity({ workflow: "separations", itemId: "third" });
    assert.ok(third?.runId);

    const bumped = await app().request("/api/queue/bump", jsonRequest({
      workflow: "separations",
      id: "third",
      runId: third.runId,
    }));
    assert.equal(bumped.status, 200);
    assert.deepEqual(await bumped.json(), { ok: true });
    assert.equal(taskStore.claimNextTask({ workflow: "separations", workerId: "worker-1" })?.itemId, "third");

    const invalid = await app().request("/api/queue/bump", jsonRequest({ workflow: "separations" }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { ok: boolean }).ok, false);
  } finally {
    taskStore.close();
  }
});

test("Hono bulk routes ignore unsupported source and scope values", async () => {
  const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
  try {
    const [task] = taskStore.enqueueTasks({
      workflow: "separations",
      inputs: [{ docId: "visible" }],
      deriveItemId: (input) => input.docId,
      runIds: ["visible-run"],
    });
    stubDaemonSpawn(dir);
    trackEventForDate({
      workflow: "separations",
      timestamp: new Date().toISOString(),
      id: "visible",
      runId: "visible-run",
      status: "failed",
      data: { archetype: "single" },
      input: { docId: "visible" },
    }, dateLocal(), dir);

    const retry = await app().request("/api/retry-bulk", jsonRequest({
      workflow: "separations",
      source: "daemon",
      scope: "daemon",
      items: [{ workflowId: "separations", id: "visible", runId: "visible-run" }],
    }));

    assert.equal(retry.status, 202);
    assert.deepEqual(await retry.json(), { ok: true, count: 1, errors: [] });
    assert.equal(taskStore.listAttemptsForTask(task.taskId).length, 2);

    const deletionDate = "2026-05-21";
    trackEventForDate({
      workflow: "separations",
      timestamp: "2026-05-21T10:00:00.000Z",
      id: "visible",
      runId: "visible-run",
      status: "failed",
    }, deletionDate, dir);

    const deleted = await app().request("/api/delete-bulk", jsonRequest({
      workflow: "separations",
      date: deletionDate,
      source: "daemon",
      scope: "daemon",
      items: [{ workflowId: "separations", id: "visible", runId: "visible-run" }],
    }));

    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, count: 1, errors: [] });
  } finally {
    taskStore.close();
  }
});

test("Hono worker drain and stop routes enqueue worker commands", async () => {
  const workerStore = createWorkerStore(openControlDb({ trackerDir: dir }));
  try {
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: "separations",
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "idle",
    });

    const drain = await app().request("/api/worker/drain", jsonRequest({ workerId: "sep-worker" }));
    const stop = await app().request("/api/worker/stop", jsonRequest({ workerId: "sep-worker" }));

    assert.equal(drain.status, 202);
    assert.equal(stop.status, 202);
    const drainBody = await drain.json() as { ok: boolean; commandId: string };
    const stopBody = await stop.json() as { ok: boolean; commandId: string };
    assert.equal(drainBody.ok, true);
    assert.equal(stopBody.ok, true);
    assert.equal(workerStore.getCommand(drainBody.commandId)?.commandType, "drain_worker");
    assert.equal(workerStore.getCommand(stopBody.commandId)?.commandType, "stop_worker");
  } finally {
    workerStore.close();
  }
});

test("Hono /api/browser/kill accepts pid targeting and rejects missing target", async () => {
  const workerStore = createWorkerStore(openControlDb({ trackerDir: dir }));
  try {
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

    const missing = await app().request("/api/browser/kill", jsonRequest({}));
    assert.equal(missing.status, 400);

    const killed = await app().request("/api/browser/kill", jsonRequest({ pid: 987655 }));
    assert.equal(killed.status, 202);
    const body = await killed.json() as { ok: boolean; commandId: string };
    assert.equal(body.ok, true);
    assert.equal(workerStore.getCommand(body.commandId)?.commandType, "kill_browser");
    assert.equal(workerStore.findBrowserProcessById(browser.browserProcessId)?.status, "kill_requested");
  } finally {
    workerStore.close();
  }
});

test("Hono /api/daemon/stop preserves empty daemon response shape", async () => {
  const res = await app().request("/api/daemon/stop", jsonRequest({
    workflow: "separations",
    force: false,
  }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    workflow: "separations",
    force: false,
    stopped: 0,
    daemonsStopped: 0,
    processesKilled: 0,
    browsersKilled: 0,
    queuedCancelled: 0,
    phantomsCleared: 0,
  });
});
