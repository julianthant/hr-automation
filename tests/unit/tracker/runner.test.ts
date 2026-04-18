import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  ARGV_MAP,
  RunnerError,
  RunnerRegistry,
  __resetRunnerRegistry,
  getRunnerRegistry,
  DEFAULT_MAX_CONCURRENT,
} from "../../../src/tracker/runner.js";

// ── argv mapper table-driven tests ──────────────────────
//
// Each workflow's mapper is a pure function. We pin the exact spawn shape
// the operator's terminal would invoke — if these change, that's a real
// behavior change and the test should be updated alongside the mapper.

describe("ARGV_MAP — onboarding", () => {
  it("maps email to `npm run start-onboarding -- <email>`", () => {
    const result = ARGV_MAP.onboarding({ email: "jane@ucsd.edu" });
    assert.equal(result.command, "npm");
    assert.deepEqual(result.args, ["run", "start-onboarding", "--", "jane@ucsd.edu"]);
  });

  it("dryRun swaps to start-onboarding:dry", () => {
    const result = ARGV_MAP.onboarding({ email: "jane@ucsd.edu" }, { dryRun: true });
    assert.deepEqual(result.args, ["run", "start-onboarding:dry", "--", "jane@ucsd.edu"]);
  });

  it("throws when email missing", () => {
    assert.throws(() => ARGV_MAP.onboarding({}), /email/);
  });
});

describe("ARGV_MAP — separations", () => {
  it("maps single docId to `npm run separation -- <id>`", () => {
    const result = ARGV_MAP.separations({ docId: "3508" });
    assert.equal(result.command, "npm");
    assert.deepEqual(result.args, ["run", "separation", "--", "3508"]);
  });

  it("maps docIds array to batch invocation", () => {
    const result = ARGV_MAP.separations({ docIds: ["3881", "3882", "3883"] });
    assert.deepEqual(result.args, ["run", "separation", "--", "3881", "3882", "3883"]);
  });

  it("dryRun swaps to separation:dry", () => {
    const result = ARGV_MAP.separations({ docId: "3508" }, { dryRun: true });
    assert.deepEqual(result.args, ["run", "separation:dry", "--", "3508"]);
  });

  it("throws when neither docId nor docIds present", () => {
    assert.throws(() => ARGV_MAP.separations({}), /docId/);
  });

  it("throws when docIds is empty array", () => {
    assert.throws(() => ARGV_MAP.separations({ docIds: [] }), /at least one/);
  });

  it("filters out empty strings in docIds array", () => {
    const result = ARGV_MAP.separations({ docIds: ["3881", "", "3882"] });
    assert.deepEqual(result.args, ["run", "separation", "--", "3881", "3882"]);
  });
});

describe("ARGV_MAP — work-study", () => {
  it("maps emplId + effectiveDate to npm script", () => {
    const result = ARGV_MAP["work-study"]({ emplId: "10862930", effectiveDate: "01/01/2026" });
    assert.equal(result.command, "npm");
    assert.deepEqual(result.args, ["run", "work-study", "--", "10862930", "01/01/2026"]);
  });

  it("dryRun swaps to work-study:dry", () => {
    const result = ARGV_MAP["work-study"]({ emplId: "10862930", effectiveDate: "01/01/2026" }, { dryRun: true });
    assert.deepEqual(result.args, ["run", "work-study:dry", "--", "10862930", "01/01/2026"]);
  });

  it("throws when emplId missing", () => {
    assert.throws(() => ARGV_MAP["work-study"]({ effectiveDate: "01/01/2026" }), /emplId/);
  });

  it("throws when effectiveDate missing", () => {
    assert.throws(() => ARGV_MAP["work-study"]({ emplId: "10862930" }), /effectiveDate/);
  });
});

describe("ARGV_MAP — emergency-contact", () => {
  it("accepts batchPath", () => {
    const result = ARGV_MAP["emergency-contact"]({ batchPath: ".tracker/emergency-contact/batch-2026-04-18.yml" });
    assert.equal(result.command, "npm");
    assert.deepEqual(result.args, [
      "run",
      "emergency-contact",
      "--",
      ".tracker/emergency-contact/batch-2026-04-18.yml",
    ]);
  });

  it("falls back to batchYaml alias", () => {
    const result = ARGV_MAP["emergency-contact"]({ batchYaml: "/tmp/x.yml" });
    assert.deepEqual(result.args, ["run", "emergency-contact", "--", "/tmp/x.yml"]);
  });

  it("dryRun swaps to emergency-contact:dry", () => {
    const result = ARGV_MAP["emergency-contact"]({ batchPath: "/x.yml" }, { dryRun: true });
    assert.deepEqual(result.args, ["run", "emergency-contact:dry", "--", "/x.yml"]);
  });

  it("throws when path missing", () => {
    assert.throws(() => ARGV_MAP["emergency-contact"]({}), /batchPath/);
  });
});

describe("ARGV_MAP — kronos-reports", () => {
  it("invokes npm run kronos with no flags by default", () => {
    const result = ARGV_MAP["kronos-reports"]({});
    assert.equal(result.command, "npm");
    assert.deepEqual(result.args, ["run", "kronos", "--"]);
  });

  it("appends --workers when present", () => {
    const result = ARGV_MAP["kronos-reports"]({ workers: 8 });
    assert.deepEqual(result.args, ["run", "kronos", "--", "--workers", "8"]);
  });

  it("appends date flags when present", () => {
    const result = ARGV_MAP["kronos-reports"]({ startDate: "1/01/2026", endDate: "1/31/2026" });
    assert.deepEqual(result.args, [
      "run", "kronos", "--",
      "--start-date", "1/01/2026",
      "--end-date", "1/31/2026",
    ]);
  });

  it("dryRun swaps to kronos:dry", () => {
    const result = ARGV_MAP["kronos-reports"]({ workers: 4 }, { dryRun: true });
    assert.deepEqual(result.args, ["run", "kronos:dry", "--", "--workers", "4"]);
  });

  it("ignores invalid worker counts", () => {
    const result = ARGV_MAP["kronos-reports"]({ workers: 0 });
    assert.deepEqual(result.args, ["run", "kronos", "--"]);
  });
});

describe("ARGV_MAP — eid-lookup", () => {
  it("invokes tsx directly (no npm script)", () => {
    const result = ARGV_MAP["eid-lookup"]({ names: ["Hein, Julian"] });
    assert.equal(result.command, "tsx");
    assert.deepEqual(result.args, ["--env-file=.env", "src/cli.ts", "eid-lookup", "Hein, Julian"]);
  });

  it("appends --workers when present", () => {
    const result = ARGV_MAP["eid-lookup"]({ names: ["A", "B"], workers: 2 });
    assert.deepEqual(result.args, [
      "--env-file=.env", "src/cli.ts", "eid-lookup",
      "--workers", "2",
      "A", "B",
    ]);
  });

  it("appends --no-crm when useCrm: false", () => {
    const result = ARGV_MAP["eid-lookup"]({ names: ["A"], useCrm: false });
    assert.deepEqual(result.args, [
      "--env-file=.env", "src/cli.ts", "eid-lookup",
      "--no-crm",
      "A",
    ]);
  });

  it("appends --dry-run", () => {
    const result = ARGV_MAP["eid-lookup"]({ names: ["A"] }, { dryRun: true });
    assert.deepEqual(result.args, [
      "--env-file=.env", "src/cli.ts", "eid-lookup",
      "--dry-run",
      "A",
    ]);
  });

  it("throws when names array empty", () => {
    assert.throws(() => ARGV_MAP["eid-lookup"]({ names: [] }), /at least one name/);
  });

  it("throws when names missing", () => {
    assert.throws(() => ARGV_MAP["eid-lookup"]({}), /at least one name/);
  });
});

// ── RunnerRegistry behavior ─────────────────────────────
//
// We mock `child_process.spawn` so the tests don't actually exec npm/tsx.
// The mock returns an EventEmitter that we drive through the lifecycle
// (exit/error) manually.

class FakeChild extends EventEmitter {
  pid = 12345;
  killed = false;
  // Drainable stdout/stderr — the real spawn returns Readable streams; an
  // EventEmitter is enough since RunnerRegistry just attaches `.on('data')`.
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(_signal?: string): boolean {
    this.killed = true;
    // Simulate the child exiting in response to the signal.
    setImmediate(() => this.emit("exit", null, _signal ?? "SIGTERM"));
    return true;
  }
}

function fakeSpawn(): typeof spawn {
  let nextPid = 1000;
  return ((_command: string, _args: readonly string[]) => {
    const child = new FakeChild();
    child.pid = nextPid++;
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

describe("RunnerRegistry.spawn", () => {
  it("returns a fresh runId + pid + child", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const result = reg.spawn("onboarding", { command: "npm", args: ["run", "start-onboarding"] });
    assert.match(result.runId, /^[0-9a-f-]{36}$/);
    assert.equal(result.pid, 1000);
    assert.equal(reg.size(), 1);
  });

  it("auto-removes from registry on child exit", async () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const { child } = reg.spawn("onboarding", { command: "npm", args: [] });
    assert.equal(reg.size(), 1);
    child.emit("exit", 0, null);
    // Wait one microtask for the listener to fire.
    await new Promise((r) => setImmediate(r));
    assert.equal(reg.size(), 0);
  });

  it("auto-removes from registry on child error (e.g. ENOENT)", async () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const { child } = reg.spawn("onboarding", { command: "npm", args: [] });
    assert.equal(reg.size(), 1);
    child.emit("error", new Error("ENOENT"));
    await new Promise((r) => setImmediate(r));
    assert.equal(reg.size(), 0);
  });

  it("enforces concurrency cap and throws RunnerError(429)", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn(), maxConcurrent: 2 });
    reg.spawn("onboarding", { command: "npm", args: [] });
    reg.spawn("onboarding", { command: "npm", args: [] });
    let thrown: unknown;
    try {
      reg.spawn("onboarding", { command: "npm", args: [] });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RunnerError);
    assert.equal((thrown as RunnerError).status, 429);
    assert.match((thrown as RunnerError).message, /Concurrency cap reached \(2/);
  });
});

describe("RunnerRegistry.cancel", () => {
  it("kills an in-flight child and returns true", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const { runId, child } = reg.spawn("onboarding", { command: "npm", args: [] });
    const fake = child as unknown as FakeChild;
    assert.equal(fake.killed, false);
    const result = reg.cancel(runId);
    assert.equal(result, true);
    assert.equal(fake.killed, true);
  });

  it("returns false for unknown runId", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    assert.equal(reg.cancel("not-a-real-runid"), false);
  });

  it("returns false after the child has already exited", async () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const { runId, child } = reg.spawn("onboarding", { command: "npm", args: [] });
    child.emit("exit", 0, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(reg.cancel(runId), false);
  });
});

describe("RunnerRegistry.list", () => {
  it("reports all in-flight runs with pid + workflow + startedAt", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    reg.spawn("onboarding", { command: "npm", args: [] });
    reg.spawn("separations", { command: "npm", args: [] });
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].workflow, "onboarding");
    assert.equal(list[1].workflow, "separations");
    assert.match(list[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof list[0].pid, "number");
  });
});

describe("RunnerRegistry.cleanup", () => {
  it("kills all in-flight children and clears the registry", () => {
    const reg = new RunnerRegistry({ spawnFn: fakeSpawn() });
    const { child: c1 } = reg.spawn("onboarding", { command: "npm", args: [] });
    const { child: c2 } = reg.spawn("separations", { command: "npm", args: [] });
    const f1 = c1 as unknown as FakeChild;
    const f2 = c2 as unknown as FakeChild;
    reg.cleanup();
    assert.equal(f1.killed, true);
    assert.equal(f2.killed, true);
    assert.equal(reg.size(), 0);
  });
});

describe("getRunnerRegistry — singleton", () => {
  beforeEach(() => __resetRunnerRegistry());
  afterEach(() => __resetRunnerRegistry());

  it("returns the same instance on repeated calls", () => {
    const a = getRunnerRegistry();
    const b = getRunnerRegistry();
    assert.equal(a, b);
  });

  it("default cap matches DEFAULT_MAX_CONCURRENT exported constant", () => {
    assert.equal(DEFAULT_MAX_CONCURRENT, 4);
  });
});
