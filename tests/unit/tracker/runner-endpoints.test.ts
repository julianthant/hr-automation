import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSpawnHandler,
  buildCancelHandler,
  buildActiveRunsHandler,
  buildWorkflowSchemaHandler,
} from "../../../src/tracker/dashboard.js";
import { RunnerError, RunnerRegistry } from "../../../src/tracker/runner.js";

class FakeChild extends EventEmitter {
  pid = 7777;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

function fakeSpawn(): typeof spawn {
  return ((_command: string, _args: readonly string[]) => {
    return new FakeChild() as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

// ── POST /api/workflows/:name/run ─────────────────────────

describe("buildSpawnHandler — workflow validation", () => {
  it("throws RunnerError(404) for unknown workflows", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const handler = buildSpawnHandler(reg);
    let thrown: unknown;
    try {
      handler("not-a-real-workflow", {});
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RunnerError);
    assert.equal((thrown as RunnerError).status, 404);
  });

  it("throws RunnerError(400) when input fails the argv mapper validation", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const handler = buildSpawnHandler(reg);
    let thrown: unknown;
    try {
      // onboarding requires `email` — missing → mapper throws → 400
      handler("onboarding", {});
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RunnerError);
    assert.equal((thrown as RunnerError).status, 400);
    assert.match((thrown as RunnerError).message, /email/);
  });

  it("throws RunnerError(429) when concurrency cap is exhausted", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn(), maxConcurrent: 1 });
    const handler = buildSpawnHandler(reg);
    handler("onboarding", { email: "a@b.com" });
    let thrown: unknown;
    try {
      handler("onboarding", { email: "c@d.com" });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RunnerError);
    assert.equal((thrown as RunnerError).status, 429);
  });

  it("returns { runId, pid } on successful spawn", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const handler = buildSpawnHandler(reg);
    const result = handler("work-study", { emplId: "10862930", effectiveDate: "01/01/2026" });
    assert.match(result.runId, /^[0-9a-f-]{36}$/);
    assert.equal(typeof result.pid, "number");
    assert.equal(reg.size(), 1);
  });

  it("forwards dryRun option to the argv mapper", () => {
    let captured: { command: string; args: readonly string[] } | null = null;
    const customSpawn = ((command: string, args: readonly string[]) => {
      captured = { command, args };
      return new FakeChild() as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const reg = new RunnerRegistry({ spawnFn: customSpawn });
    const handler = buildSpawnHandler(reg);
    handler("work-study", { emplId: "1", effectiveDate: "01/01/2026" }, { dryRun: true });
    assert.ok(captured);
    // dry-run swaps to work-study:dry — see ARGV_MAP test for the full spec.
    assert.ok((captured as { args: readonly string[] }).args.includes("work-study:dry"));
  });
});

// ── POST /api/runs/:runId/cancel ──────────────────────────

describe("buildCancelHandler", () => {
  it("returns { cancelled: true } when the run exists", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const spawnH = buildSpawnHandler(reg);
    const cancelH = buildCancelHandler(reg);
    const { runId } = spawnH("onboarding", { email: "a@b.com" });
    assert.deepEqual(cancelH(runId), { cancelled: true });
  });

  it("returns { cancelled: false } when the run is unknown", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const cancelH = buildCancelHandler(reg);
    assert.deepEqual(cancelH("not-a-real-runid"), { cancelled: false });
  });
});

// ── GET /api/runs/active ──────────────────────────────────

describe("buildActiveRunsHandler", () => {
  it("returns the live registry list", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const spawnH = buildSpawnHandler(reg);
    const activeH = buildActiveRunsHandler(reg);

    assert.deepEqual(activeH(), []);
    spawnH("onboarding", { email: "a@b.com" });
    spawnH("separations", { docId: "3508" });
    const active = activeH();
    assert.equal(active.length, 2);
    assert.equal(active[0].workflow, "onboarding");
    assert.equal(active[1].workflow, "separations");
  });
});

// ── GET /api/workflows/:name/schema ────────────────────────

describe("buildWorkflowSchemaHandler", () => {
  const TEST_DIR = ".schemas-test";

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns the parsed schema when the file exists", () => {
    const sample = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
    writeFileSync(join(TEST_DIR, "work-study.schema.json"), JSON.stringify(sample), "utf-8");
    const handler = buildWorkflowSchemaHandler(TEST_DIR);
    assert.deepEqual(handler("work-study"), sample);
  });

  it("returns null when the schema file is missing", () => {
    const handler = buildWorkflowSchemaHandler(TEST_DIR);
    assert.equal(handler("nonexistent"), null);
  });

  it("returns null on malformed JSON", () => {
    writeFileSync(join(TEST_DIR, "broken.schema.json"), "{ not-valid", "utf-8");
    const handler = buildWorkflowSchemaHandler(TEST_DIR);
    assert.equal(handler("broken"), null);
  });

  it("rejects path traversal in workflow name", () => {
    const handler = buildWorkflowSchemaHandler(TEST_DIR);
    assert.equal(handler("../etc/passwd"), null);
    assert.equal(handler("foo/bar"), null);
    assert.equal(handler(""), null);
  });

  it("accepts kebab-case + alphanumeric names", () => {
    const sample = { type: "object" };
    writeFileSync(join(TEST_DIR, "kronos-reports.schema.json"), JSON.stringify(sample), "utf-8");
    const handler = buildWorkflowSchemaHandler(TEST_DIR);
    assert.deepEqual(handler("kronos-reports"), sample);
  });
});
