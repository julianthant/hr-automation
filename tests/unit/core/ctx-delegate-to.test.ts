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
import { rowFilePath } from "../../../src/tracker/paths.js";

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
  const file = rowFilePath(workflow, dateLocal(), trackerDir);
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
    getName: (d) => d.parentPayload ?? "",
    getId: (d) => d.parentPayload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ parentPayload: input.parentPayload });
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
    "single",
    "default archetype for single child stays single; parentRunId carries delegated scope",
  );
  assert.deepEqual(pending!.input, { payload: "hello-child" }, "pristine input persisted on pending row");
  const r = observedResult as { status: string; data?: Record<string, string> };
  assert.equal(r.status, "done", "child reached terminal done status");
});

test("ctx.delegateTo with renderAs: 'flat' leaves row archetype canonical", async (t) => {
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
  assert.equal(pending!.parentRunId !== undefined, true);
  assert.equal((pending!.data as { archetype?: string }).archetype, "single");
});

test("ctx.delegateTo stamps a natural batch child as batch when it has a parent", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-batch-child-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = defineWorkflow({
    name: "deleg-child-batch-natural",
    archetype: "batch",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ pdfOriginalName: z.string(), sessionId: z.string() }),
    detailFields: [{ key: "pdfOriginalName", label: "PDF" }],
    getName: (d) => d.pdfOriginalName ?? "",
    getId: (d) => d.sessionId ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
      });
      await ctx.step("work", async () => {});
    },
  });
  const parent = makeParentWorkflow({
    name: "deleg-parent-batch-natural",
    onCtx: async (ctx) => {
      const c = ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> };
      await c.delegateTo(child, {
        pdfOriginalName: "oath-batch.pdf",
        sessionId: "oath-session-1",
      });
    },
  });

  await runWorkflow(parent, { parentPayload: "p" }, { trackerDir });

  const lines = readWorkflowLines(trackerDir, "deleg-child-batch-natural");
  const pending = lines.find((l) => l.status === "pending");
  const done = lines.find((l) => l.status === "done");
  assert.ok(pending, "child pending row must be emitted");
  assert.equal((pending!.data as { archetype?: string }).archetype, "batch");
  assert.deepEqual(pending!.input, {
    pdfOriginalName: "oath-batch.pdf",
    sessionId: "oath-session-1",
  });
  assert.ok(done, "child done row must be emitted");
  assert.equal((done!.data as { archetype?: string }).archetype, "batch");
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

// Bug #5 — fire-and-forget catch must emit a terminal `failed` JSONL row when
// `runWorkflow` rejects synchronously (schema-parse error, before
// `withTrackedWorkflow` is installed). Otherwise the pre-emitted pending row
// gets stuck pending forever in the dashboard.
test("delegateToImpl fire-and-forget emits terminal failed row when runWorkflow rejects synchronously", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-faf-reject-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  // Schema requires a string, but we'll force a number through with `as`,
  // triggering Zod's parse error in runWorkflow BEFORE withTrackedWorkflow
  // attaches a lifecycle — i.e. before any terminal row could be written
  // by the kernel itself.
  const child = defineWorkflow({
    name: "deleg-child-faf-reject",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    detailFields: [{ key: "payload", label: "Payload" }],
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async () => {
      // Unreachable — schema rejection fires before the handler runs.
    },
  });

  const result = await delegateToImpl({
    parentRunId: "parent-run-faf-reject",
    trackerDir,
    child,
    // Intentionally malformed for the schema:
    input: { payload: 12345 } as unknown as { payload: string },
    itemId: "faf-reject-item",
    runId: "faf-reject-run",
    fireAndForget: true,
  });

  // delegateToImpl itself returns pending immediately — the reject lands later.
  assert.equal(result.status, "pending");
  assert.equal(result.itemId, "faf-reject-item");
  assert.equal(result.runId, "faf-reject-run");

  // Yield several microtasks + a macrotask to let the void-Promise's catch run.
  await new Promise((r) => setTimeout(r, 50));

  const lines = readWorkflowLines(trackerDir, "deleg-child-faf-reject");
  const pending = lines.find((l) => l.status === "pending");
  assert.ok(pending, "fire-and-forget still pre-emits the pending row");
  assert.equal(pending!.id, "faf-reject-item");
  assert.equal(pending!.runId, "faf-reject-run");

  const failed = lines.find((l) => l.status === "failed");
  assert.ok(failed, "terminal failed row must be emitted on synchronous reject (Bug #5)");
  assert.equal(failed!.id, "faf-reject-item", "failed row keys on same itemId as pending");
  assert.equal(failed!.runId, "faf-reject-run", "failed row keys on same runId as pending");
  assert.equal(failed!.parentRunId, "parent-run-faf-reject", "failed row inherits parentRunId");
  assert.equal(
    (failed!.data as { archetype?: string }).archetype,
    "single",
    "failed row stamps the same archetype as the pending row",
  );
});

// Bug #4 — delegateToImpl in-process fire-and-forget result MUST carry the
// runId we generated, not an empty string (retry-by-runId / dashboard
// navigation / watchChildRuns correlation all key off runId). The
// in-process branch returns `childRunId` directly; this test pins the
// behavior so a future refactor can't silently drop it.
test("delegateToImpl fire-and-forget in-process result carries the assigned runId", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-faf-runid-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "deleg-child-faf-runid" });
  const result = await delegateToImpl({
    parentRunId: "parent-run-faf-runid",
    trackerDir,
    child,
    input: { payload: "x" },
    itemId: "faf-runid-item",
    runId: "faf-runid-run",
    fireAndForget: true,
  });
  assert.equal(result.runId, "faf-runid-run", "fire-and-forget result must carry the runId, never empty (Bug #4)");
  assert.notEqual(result.runId, "");
  // Drain the child so the tracker file is fully written before teardown.
  await new Promise((r) => setTimeout(r, 50));
});

// Trace-id provenance (Part B): a delegated child's `data.__traceId` is
// prefixed with the delegating PARENT's 2-char code (threaded as `rootCode`
// from `buildDelegateApi`), so an operator can trace a child row back to the
// workflow that spawned it. The parent below is "trace-parent" → code "tr";
// the child is "trace-child" → its OWN code would be "tr" too, so we give the
// child an explicit distinct code ("zz") to prove the prefix comes from the
// PARENT, not the child.
test("ctx.delegateTo stamps the child trace id with the parent's code (provenance)", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-trace-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = defineWorkflow({
    name: "trace-child-wf",
    code: "zz",
    inputSubject: "name",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {});
    },
  });
  const parent = defineWorkflow({
    name: "trace-parent-wf",
    code: "tr",
    inputSubject: "name",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["delegate"] as const,
    schema: z.object({ parentPayload: z.string() }),
    getName: (d) => d.parentPayload ?? "",
    getId: (d) => d.parentPayload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ parentPayload: input.parentPayload });
      await ctx.step("delegate", async () => {
        const c = ctx as unknown as { delegateTo: (...args: unknown[]) => Promise<unknown> };
        await c.delegateTo(child, { payload: "hello-child" });
      });
    },
  });

  await runWorkflow(parent, { parentPayload: "p1" }, { trackerDir });

  const childPending = readWorkflowLines(trackerDir, "trace-child-wf")
    .find((l) => l.status === "pending");
  assert.ok(childPending, "child pending row must be emitted");
  const childTrace = (childPending!.data as { __traceId?: string }).__traceId;
  assert.ok(childTrace, "child pending row must carry a trace id");
  // Parent code "tr", NOT the child's own "zz".
  assert.match(childTrace!, /^tr-\d{6}-[a-z0-9]{4}$/);

  const parentPending = readWorkflowLines(trackerDir, "trace-parent-wf")
    .find((l) => l.status === "pending");
  // The parent is a root run — its own code "tr" is also "tr" here, but the
  // point is it uses its OWN code, not an inherited one.
  if (parentPending) {
    const parentTrace = (parentPending.data as { __traceId?: string }).__traceId;
    if (parentTrace) assert.match(parentTrace, /^tr-\d{6}-[a-z0-9]{4}$/);
  }
});

// The rootCode also rides the child input's `__runtimeOptions` channel so it
// survives the SQLite task store to a daemon worker's own re-emit. Pin that
// `delegateToImpl` injects it for the in-process pending row's trace id when
// passed explicitly.
test("delegateToImpl threads an explicit rootCode into the child trace id", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-rootcode-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = defineWorkflow({
    name: "rootcode-child-wf",
    code: "zz",
    inputSubject: "name",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {});
    },
  });

  await delegateToImpl({
    parentRunId: "rootcode-parent-run",
    trackerDir,
    child,
    input: { payload: "x" },
    itemId: "rootcode-item",
    runId: "rootcode-run-abcd",
    fireAndForget: false,
    rootCode: "os",
  });

  const pending = readWorkflowLines(trackerDir, "rootcode-child-wf")
    .find((l) => l.status === "pending");
  assert.ok(pending, "child pending row must be emitted");
  const trace = (pending!.data as { __traceId?: string }).__traceId;
  assert.ok(trace, "child pending row must carry a trace id");
  // Originating code "os", NOT the child's own "zz".
  assert.match(trace!, /^os-\d{6}-root$/);
});

// ─── Root trace-id propagation ──────────────────────────────────────────────
// A delegated child must DISPLAY the originating run's FULL trace id (not just
// its code, and not a per-child recompute). `delegateToImpl` stamps the
// inherited `rootTraceId` verbatim as the child's `data.__traceId`.
test("delegateToImpl stamps the child trace id with the inherited rootTraceId verbatim", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-roottrace-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const child = makeChildWorkflow({ name: "roottrace-child-wf" });
  const ROOT_ID = "tr-101010-aaaa";
  await delegateToImpl({
    parentRunId: "roottrace-parent-run",
    trackerDir,
    child,
    input: { payload: "x" },
    itemId: "roottrace-item",
    runId: "roottrace-run-bbbb",
    fireAndForget: false,
    // rootCode would prefix "os" if it won; rootTraceId must beat it.
    rootCode: "os",
    rootTraceId: ROOT_ID,
  });

  const pending = readWorkflowLines(trackerDir, "roottrace-child-wf")
    .find((l) => l.status === "pending");
  assert.ok(pending, "child pending row must be emitted");
  const trace = (pending!.data as { __traceId?: string }).__traceId;
  // The child displays the ROOT's full id, NOT a recompute off its own runId.
  assert.equal(trace, ROOT_ID);
});

// Transitivity: a root → child → grandchild chain (three DISTINCT codes) must
// have the grandchild still display the ROOT's id. We simulate the originating
// run (e.g. OCR) by delegating the child with an explicit `rootTraceId` (the
// root's frozen id), exactly as OCR's orchestrator passes its `ou-...` id. The
// child must (a) display that id and (b) forward it to its OWN grandchild —
// proving each non-root parent passes through what it inherited, so the
// grandchild shows the ORIGINAL root, not the immediate parent's id.
test("delegated trace id propagates transitively to a grandchild (root → child → grandchild)", async (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ctx-delegate-transitive-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

  const grandchild = defineWorkflow({
    name: "transitive-grandchild-wf",
    code: "gc",
    inputSubject: "name",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ payload: z.string() }),
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("work", async () => {});
    },
  });
  const child = defineWorkflow({
    name: "transitive-child-wf",
    code: "ch",
    inputSubject: "name",
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["delegate"] as const,
    schema: z.object({ payload: z.string() }),
    getName: (d) => d.payload ?? "",
    getId: (d) => d.payload ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ payload: input.payload });
      await ctx.step("delegate", async () => {
        const c = ctx as unknown as { delegateTo: (...args: unknown[]) => Promise<unknown> };
        // The child delegates WITHOUT re-passing a rootTraceId — it must
        // forward the one it inherited (via makeCtx's forwardRootTraceId).
        await c.delegateTo(grandchild, { payload: "gc-payload" });
      });
    },
  });

  // ROOT's frozen id, code "rt" — distinct from the child's "ch" and the
  // grandchild's "gc" so a recompute at any level would be detectable.
  const ROOT_ID = "rt-090553-1a57";
  await delegateToImpl({
    parentRunId: "transitive-root-run",
    trackerDir,
    child,
    input: { payload: "ch-payload" },
    itemId: "transitive-child-item",
    runId: "transitive-child-run",
    fireAndForget: false,
    rootCode: "rt",
    rootTraceId: ROOT_ID,
  });

  // The immediate child shows the ROOT's id, not "ch-..." or a recompute.
  const childRows = readWorkflowLines(trackerDir, "transitive-child-wf");
  const childPending = childRows.find((l) => l.status === "pending");
  assert.ok(childPending, "child pending row must be emitted");
  assert.equal((childPending!.data as { __traceId?: string }).__traceId, ROOT_ID);
  // And it rides every child row, not just pending.
  for (const row of childRows) {
    if ((row.data as { __traceId?: string })?.__traceId) {
      assert.equal((row.data as { __traceId?: string }).__traceId, ROOT_ID, `child ${row.status} row carries root id`);
    }
  }

  // The grandchild ALSO shows the ROOT's id, not "gc-..." or the child's id.
  const gcPending = readWorkflowLines(trackerDir, "transitive-grandchild-wf")
    .find((l) => l.status === "pending");
  assert.ok(gcPending, "grandchild pending row must be emitted");
  assert.equal((gcPending!.data as { __traceId?: string }).__traceId, ROOT_ID);
});
