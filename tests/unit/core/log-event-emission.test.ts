/**
 * Proof for the stable structured log-event names (Phase 1 Task 6).
 *
 * Drives small REAL workflows through `runWorkflow` against a temp tracker
 * root and asserts the run-scope log file `logs/<workflow>-<date>.jsonl`
 * carries entries stamped with the closed-set `event` names + the identity
 * fields (`runId`, `step`, `childWorkflow`, `count`) the Tier-1 harness's
 * `waitForEvent` will match on. The assertions deliberately MIRROR what
 * `waitForEvent(name, { runId, step, childWorkflow })` will filter by — this
 * test is also the harness de-risk.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";
import { logFilePath } from "../../../src/tracker/paths.js";
import type { LogEntry } from "../../../src/tracker/jsonl.js";

function readLogs(trackerDir: string, workflow: string): LogEntry[] {
  const file = logFilePath(workflow, dateLocal(), trackerDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function eventsNamed(logs: LogEntry[], event: string): LogEntry[] {
  return logs.filter((l) => l.event === event);
}

test("a real run emits step:start, step:done, and run:terminal with event + runId on the run-scope log", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "log-event-emit-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const wf = defineWorkflow({
    name: "log-event-basic",
    archetype: "single",
    inputSubject: "name",
    code: "le",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ name: z.string() }),
    getName: (d) => d.name ?? "",
    getId: (d) => d.name ?? "",
    handler: async (ctx) => {
      await ctx.step("work", async () => {});
    },
  });

  const runId = "11112222-3333-4444-5555-666677778888";
  await runWorkflow(wf, { name: "Ada" }, { trackerDir, preAssignedRunId: runId });

  const logs = readLogs(trackerDir, "log-event-basic");
  assert.ok(logs.length > 0, "run-scope log file should have entries");

  // step:start — fires at the step boundary, carries the step name.
  const startEvents = eventsNamed(logs, "step:start");
  assert.ok(
    startEvents.some((e) => e.step === "work" && e.runId === runId),
    `step:start{step:"work",runId} must be present; got ${JSON.stringify(startEvents.map((e) => ({ step: e.step, runId: e.runId })))}`,
  );

  // step:done — fires after the step body resolves, carries the step name.
  const doneEvents = eventsNamed(logs, "step:done");
  assert.ok(
    doneEvents.some((e) => e.step === "work" && e.runId === runId),
    "step:done{step:\"work\",runId} must be present",
  );

  // run:terminal — fires once at the run's terminal emit, outcome=completed.
  const terminalEvents = eventsNamed(logs, "run:terminal");
  assert.equal(terminalEvents.length, 1, "exactly one run:terminal per run");
  assert.equal(terminalEvents[0].runId, runId, "run:terminal carries the runId");
  assert.equal(terminalEvents[0].occasion, "completed", "successful run:terminal outcome=completed");

  // Every event entry carries a runId — the harness scopes by runId.
  for (const e of logs.filter((l) => l.event)) {
    assert.ok(e.runId, `event ${e.event} must carry a runId`);
  }
});

test("a delegating parent emits delegation:children-spawned with childWorkflow + count", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "log-event-deleg-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = defineWorkflow({
    name: "log-event-child",
    archetype: "single",
    inputSubject: "name",
    code: "lc",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ name: z.string() }),
    getName: (d) => d.name ?? "",
    getId: (d) => d.name ?? "",
    handler: async (ctx, input) => {
      await ctx.step("work", async () => {
        ctx.updateData({ name: input.name });
      });
    },
  });

  const parent = defineWorkflow({
    name: "log-event-parent",
    archetype: "single",
    inputSubject: "name",
    code: "lp",
    systems: [],
    authSteps: false,
    steps: ["delegate"] as const,
    schema: z.object({ name: z.string() }),
    getName: (d) => d.name ?? "",
    getId: (d) => d.name ?? "",
    handler: async (ctx) => {
      await ctx.step("delegate", async () => {
        await ctx.delegateToAll(child, [{ name: "Grace" }, { name: "Katherine" }]);
      });
    },
  });

  const parentRunId = "aaaa1111-2222-3333-4444-555566667777";
  await runWorkflow(parent, { name: "Roster" }, { trackerDir, preAssignedRunId: parentRunId });

  // The fan-out event lands on the PARENT's run-scope log (it's emitted from
  // inside the parent handler's log context).
  const parentLogs = readLogs(trackerDir, "log-event-parent");
  const spawned = eventsNamed(parentLogs, "delegation:children-spawned");
  assert.ok(spawned.length >= 1, "delegation:children-spawned must be emitted on the parent log");
  const fanOut = spawned.find((e) => e.childWorkflow === "log-event-child");
  assert.ok(fanOut, "delegation:children-spawned must carry childWorkflow=log-event-child");
  assert.equal(fanOut!.count, 2, "count must equal the number of children spawned");
  assert.equal(fanOut!.runId, parentRunId, "fan-out event carries the parent runId");

  // Children also reach terminal — proving the chain is observable end-to-end.
  const childLogs = readLogs(trackerDir, "log-event-child");
  const childTerminals = eventsNamed(childLogs, "run:terminal");
  assert.equal(childTerminals.length, 2, "each child emits its own run:terminal");
});

test("a failing run emits run:terminal with occasion=failed", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "log-event-fail-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const wf = defineWorkflow({
    name: "log-event-fail",
    archetype: "single",
    inputSubject: "name",
    code: "lf",
    systems: [],
    authSteps: false,
    steps: ["boom"] as const,
    schema: z.object({ name: z.string() }),
    getName: (d) => d.name ?? "",
    getId: (d) => d.name ?? "",
    handler: async (ctx) => {
      await ctx.step("boom", async () => {
        throw new Error("intentional failure");
      });
    },
  });

  const runId = "ffff0000-1111-2222-3333-444455556666";
  await assert.rejects(
    runWorkflow(wf, { name: "Edsger" }, { trackerDir, preAssignedRunId: runId }),
    /intentional failure/,
  );

  const logs = readLogs(trackerDir, "log-event-fail");
  const terminalEvents = eventsNamed(logs, "run:terminal");
  assert.equal(terminalEvents.length, 1, "exactly one run:terminal on the failure path");
  assert.equal(terminalEvents[0].occasion, "failed", "failed run:terminal outcome=failed");
  assert.equal(terminalEvents[0].runId, runId, "run:terminal carries the runId");
  // `lastStep` at the terminal emit is the encoded failed-step string written
  // by `emitFailedFn` (`<step>:failed:<error>`) — the run:terminal event
  // carries it verbatim. The harness scopes on runId + event + occasion, not
  // the exact step string, so this is informational.
  assert.match(terminalEvents[0].step ?? "", /^boom:failed:/, "failed run:terminal preserves the in-flight (encoded) step");
});
