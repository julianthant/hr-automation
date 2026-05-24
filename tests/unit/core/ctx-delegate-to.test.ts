/**
 * Contract 3 — Delegation API (`ctx.delegateTo` / `ctx.delegateToAll`).
 *
 * Exercises the kernel-managed child-run path end-to-end against real
 * tracker JSONL: parent + child workflows are declared in-test with
 * empty systems[], the parent's handler invokes `ctx.delegateTo` (or
 * `delegateToAll` via the impl), and we read back the child's pending
 * row from `<trackerDir>/<child>-<date>.jsonl` to assert archetype,
 * parentRunId, and pristine input stamping.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";
import {
  delegateToAllImpl,
  delegateToImpl,
} from "../../../src/core/delegate.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";

interface TrackerLine {
  workflow: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: string;
  step?: string;
  data?: Record<string, unknown>;
  input?: unknown;
}

function readWorkflowLines(trackerDir: string, workflow: string): TrackerLine[] {
  const file = join(trackerDir, `${workflow}-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

function makeChildWorkflow(opts: { name: string; throwInHandler?: boolean }) {
  return defineWorkflow({
    name: opts.name,
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    detailFields: [{ key: "payload", label: "Payload" }],
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {
        if (opts.throwInHandler) throw new Error("child boom");
      });
    },
  });
}

function makeParentWorkflow(opts: { name: string; onCtx: (ctx: unknown) => Promise<void> }) {
  return defineWorkflow({
    name: opts.name,
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["delegate"] as const,
    schema: z.object({ parentPayload: z.string() }),
    detailFields: [{ key: "parentPayload", label: "Parent Payload" }],
    getName: (d) => d.parentPayload ?? "",
    getId: (d) => d.parentPayload ?? "",
    handler: async (ctx, _input) => {
      await ctx.step("delegate", async () => {
        await opts.onCtx(ctx);
      });
    },
  });
}

test("ctx.delegateTo pre-emits child pending row with parentRunId, derived archetype, and pristine input", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-to-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "deleg-child-default" });
  let observedResult: unknown;
  const parent = makeParentWorkflow({
    name: "deleg-parent-default",
    onCtx: async (ctx) => {
      const c = ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> };
      observedResult = await c.delegateTo(child, { payload: "hello-child" });
    },
  });

  await runWorkflow(parent, { parentPayload: "p1" }, { trackerDir });

  const childLines = readWorkflowLines(trackerDir, "deleg-child-default");
  const pending = childLines.find((l) => l.status === "pending");
  assert.ok(pending, "child pending row must be emitted");
  assert.equal(pending!.parentRunId !== undefined, true, "child pending row must carry parentRunId");
  assert.equal(
    (pending!.data as { archetype?: string }).archetype,
    "delegate-child",
    "default archetype for single child with parentRunId is delegate-child",
  );
  assert.deepEqual(pending!.input, { payload: "hello-child" }, "pristine input persisted on pending row");
  const r = observedResult as { status: string; data?: Record<string, string> };
  assert.equal(r.status, "done", "child reached terminal done status");
});

test("ctx.delegateTo with renderAs: 'flat' stamps passive-child archetype", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-flat-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "deleg-child-flat" });
  const parent = makeParentWorkflow({
    name: "deleg-parent-flat",
    onCtx: async (ctx) => {
      const c = ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> };
      await c.delegateTo(child, { payload: "p" }, { renderAs: "flat" });
    },
  });
  await runWorkflow(parent, { parentPayload: "p" }, { trackerDir });

  const pending = readWorkflowLines(trackerDir, "deleg-child-flat")
    .find((l) => l.status === "pending");
  assert.ok(pending);
  assert.equal((pending!.data as { archetype?: string }).archetype, "passive-child");
});

test("delegateToAllImpl with concurrency: 1 runs children sequentially", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-pool-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  let inFlight = 0;
  let maxInFlight = 0;
  const child = defineWorkflow({
    name: "deleg-child-pool",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    detailFields: [{ key: "payload", label: "Payload" }],
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so a competing handler would interleave if not gated.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      });
    },
  });

  const results = await delegateToAllImpl({
    parentRunId: "parent-run-pool",
    trackerDir,
    child,
    inputs: [{ payload: "A" }, { payload: "B" }, { payload: "C" }],
    fireAndForget: false,
    concurrency: 1,
  });
  assert.equal(results.length, 3);
  assert.equal(maxInFlight, 1, "concurrency: 1 means at most one child runs at a time");
  for (const r of results) assert.equal(r.status, "done");
});

test("ctx.delegateTo with fireAndForget: true returns pending immediately; child completes after parent returns", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-faf-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  let parentReturnedAt = 0;
  let childCompletedAt = 0;
  let childResolve!: () => void;
  const childCompleted = new Promise<void>((resolve) => {
    childResolve = resolve;
  });
  const child = defineWorkflow({
    name: "deleg-child-faf",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    detailFields: [{ key: "payload", label: "Payload" }],
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {
        // Force a microtask boundary so the parent can return BEFORE
        // the child's terminal row lands.
        await new Promise((resolve) => setTimeout(resolve, 25));
        childResolve();
      });
    },
  });

  let observed: unknown;
  const parent = makeParentWorkflow({
    name: "deleg-parent-faf",
    onCtx: async (ctx) => {
      const c = ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> };
      observed = await c.delegateTo(child, { payload: "x" }, { fireAndForget: true });
    },
  });

  await runWorkflow(parent, { parentPayload: "p" }, { trackerDir });
  parentReturnedAt = Date.now();
  const r = observed as { status: string };
  assert.equal(r.status, "pending", "fireAndForget returns pending immediately");
  await childCompleted;
  childCompletedAt = Date.now();
  assert.ok(childCompletedAt >= parentReturnedAt, "child completes after parent returns");
  const pending = readWorkflowLines(trackerDir, "deleg-child-faf")
    .find((l) => l.status === "pending");
  assert.ok(pending, "child pending row still emitted by delegateTo");
});

test("ctx.delegateTo propagates child failure as ChildRunResult { status: 'failed' }", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-fail-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "deleg-child-fail", throwInHandler: true });
  let observed: unknown;
  const parent = makeParentWorkflow({
    name: "deleg-parent-fail",
    onCtx: async (ctx) => {
      const c = ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> };
      observed = await c.delegateTo(child, { payload: "x" });
    },
  });
  await runWorkflow(parent, { parentPayload: "p" }, { trackerDir });
  const r = observed as { status: string; error?: { message: string } };
  assert.equal(r.status, "failed");
  assert.ok(r.error?.message?.includes("child boom"));
});

test("delegateToImpl with explicit itemId/runId pins the child's row identifiers", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-pinned-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "deleg-child-pinned" });
  const result = await delegateToImpl({
    parentRunId: "parent-run-pinned",
    trackerDir,
    child,
    input: { payload: "x" },
    itemId: "pinned-item",
    runId: "pinned-run",
    fireAndForget: false,
  });
  assert.equal(result.itemId, "pinned-item");
  assert.equal(result.runId, "pinned-run");
  assert.equal(result.status, "done");
  const lines = readWorkflowLines(trackerDir, "deleg-child-pinned");
  const pending = lines.find((l) => l.status === "pending");
  assert.equal(pending?.id, "pinned-item");
  assert.equal(pending?.runId, "pinned-run");
  assert.equal(pending?.parentRunId, "parent-run-pinned");
});
