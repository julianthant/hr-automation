/**
 * Retry state guard (Bug #2 from Contract 1-5 post-review fixes).
 *
 * `cancel.ts` rejects cancel-queued requests against rows in active states
 * (`claimed | running | cancel_requested | cancelling`). Retry was missing
 * the same guard, so retrying a running task would reset the row to
 * `queued` while the daemon kept running the old attempt — producing two
 * concurrent attempts.
 *
 * These tests exercise the SQLite-backed retry branch in
 * `src/control/ops/retry.ts:reEnqueueEntry` and assert the structured
 * error fires before `retryTaskFromAttempt` mutates state.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import {
  __resetDaemonSpawnLocksForTests,
  __setSpawnDaemonImplForTests,
} from "../../../src/core/daemon/client.js";
import {
  ensureDaemonsDir,
  lockfilePath,
  writeLockfile,
} from "../../../src/core/daemon/registry.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { buildRetryHandler } from "../../../src/control/ops/retry.js";

let tmp: string;
const servers: Server[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-state-guard-"));
});
afterEach(async () => {
  __setSpawnDaemonImplForTests(null);
  __resetDaemonSpawnLocksForTests();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function stubDaemonSpawn(): void {
  ensureDaemonsDir(tmp);
  __setSpawnDaemonImplForTests(async (workflow, trackerDir) => {
    const instanceId = "retry-state-guard";
    const server = createServer((req, res) => {
      if (req.url === "/whoami" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workflow, instanceId, pid: process.pid, version: 1 }));
        return;
      }
      if (req.url === "/wake" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const startedAt = new Date().toISOString();
    const path = lockfilePath(workflow, instanceId, trackerDir);
    writeLockfile(
      { workflow, instanceId, pid: process.pid, port, startedAt, hostname: "host", version: 1 },
      path,
    );
    return { workflow, instanceId, pid: process.pid, port, startedAt, lockfilePath: path };
  });
}

describe("retry state guard — blocks retry against active attempts", () => {
  it("returns structured error when task is in `claimed` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "1111", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-claimed"],
    });

    // Claim the task — sets control_state = 'claimed'.
    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "1111",
      runId: "active-run-claimed",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently claimed/);
    assert.match(result.error, /cancel the active attempt before retrying/);
    assert.match(result.error, /active-run-claimed/);
  });

  it("returns structured error when task is in `running` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "2222", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-running"],
    });

    // Claim + transition to 'running' (mirrors what the daemon does after claim).
    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'running' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "2222",
      runId: "active-run-running",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently running/);
  });

  it("returns structured error when task is in `cancel_requested` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "3333", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-cancel-req"],
    });

    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'cancel_requested' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "3333",
      runId: "active-run-cancel-req",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently cancel_requested/);
  });

  it("returns structured error when task is in `cancelling` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "4444", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-cancelling"],
    });

    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'cancelling' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "4444",
      runId: "active-run-cancelling",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently cancelling/);
  });

  it("allows retry against a `failed` task (terminal — guard does not fire)", async () => {
    stubDaemonSpawn();
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    const [enqueued] = taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "5555", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["failed-run"],
    });

    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "transient failure",
    });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "5555",
      runId: "failed-run",
    });

    // The guard does not block terminal `failed`. The retry should proceed.
    assert.equal(result.ok, true);
  });
});
