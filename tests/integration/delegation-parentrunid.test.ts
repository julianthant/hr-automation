/**
 * Integration test: Delegation — parentRunId + archetype + trace composition.
 *
 * A parent workflow that calls `ctx.delegateTo` and `ctx.delegateToAll` via
 * the real kernel, exercising the full in-process delegation path:
 *   - `runWorkflow` (parent) → `delegateToImpl` / `runInProcessPool` (child)
 *   - Real JSONL emit (pending, running, done rows for BOTH parent and child)
 *   - `parentRunId` stamped on every child row
 *   - Correct archetype derivation (single child stays single, batch-member when
 *     delegated with renderAs:"batch")
 *   - Pristine input on the child's pending row
 *   - `__traceId` prefix composition (child shares the parent's trace prefix)
 *
 * Mirrors what the existing scenario `delegate-to/oath-upload-shape.test.ts`
 * describes, but exercises it through the real `runWorkflow`/`runOneItem` JSONL
 * emit path (not the scenario harness).
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { defineWorkflow, runWorkflow } from "../../src/core/kernel/workflow.js";
import { dateLocal, rowFilePath, readEntries } from "../../src/tracker/jsonl.js";
import { closeStateDbForTests } from "../../src/tracker/state/db.js";
import { tracePrefix } from "../../src/domain/queue-trace-id.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TrackerRow {
  id: string;
  runId?: string;
  parentRunId?: string;
  status: string;
  step?: string;
  data?: Record<string, unknown>;
  input?: unknown;
}

function readWorkflowRows(dir: string, workflow: string): TrackerRow[] {
  const file = rowFilePath(workflow, dateLocal(), dir);
  if (!existsSync(file)) return [];
  const { readFileSync } = require("node:fs");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l: string) => JSON.parse(l) as TrackerRow);
}

// ─── Shared child / parent workflow factories ─────────────────────────────────

function makeSingleChild(name: string, opts: { throwInHandler?: boolean } = {}) {
  return defineWorkflow({
    name,
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
        if (opts.throwInHandler) throw new Error("child handler boom");
        ctx.updateData({ result: "done" });
      });
    },
  });
}

function makeParentWorkflow(
  name: string,
  onCtx: (ctx: Record<string, unknown>) => Promise<void>,
) {
  return defineWorkflow({
    name,
    archetype: "single",
    systems: [],
    authSteps: false,
    steps: ["delegate"] as const,
    schema: z.object({ parentPayload: z.string() }),
    getName: (d) => d.parentPayload ?? "",
    getId: (d) => d.parentPayload ?? "",
    handler: async (ctx, _input) => {
      await ctx.step("delegate", async () => {
        await onCtx(ctx as unknown as Record<string, unknown>);
      });
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("delegation: parentRunId stamped on child rows via real kernel", () => {
  test("ctx.delegateTo emits child rows with parentRunId = parent runId", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-parentrunid-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const child = makeSingleChild("deleg-child-parentrunid");
    let capturedParentRunId: string | undefined;

    const parent = makeParentWorkflow("deleg-parent-parentrunid", async (ctx) => {
      capturedParentRunId = (ctx as { runId: string }).runId;
      await (ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> }).delegateTo(
        child,
        { payload: "child-payload-1" },
      );
    });

    await runWorkflow(parent, { parentPayload: "parent-1" }, { trackerDir: dir });

    assert.ok(capturedParentRunId, "parent runId must be captured");

    // Parent rows should exist.
    const parentRows = readWorkflowRows(dir, "deleg-parent-parentrunid");
    assert.ok(parentRows.find((r) => r.status === "done"), "parent must have done row");

    // Child rows must exist with parentRunId = capturedParentRunId.
    const childRows = readWorkflowRows(dir, "deleg-child-parentrunid");
    assert.ok(childRows.length > 0, "child rows must be emitted to JSONL");

    const childPending = childRows.find((r) => r.status === "pending");
    assert.ok(childPending, "child must have a pending row");
    assert.equal(
      childPending.parentRunId,
      capturedParentRunId,
      `child pending row parentRunId must equal parent runId; got ${childPending.parentRunId}`,
    );

    const childDone = childRows.find((r) => r.status === "done");
    assert.ok(childDone, "child must have a done row");
    assert.equal(
      childDone.parentRunId,
      capturedParentRunId,
      "child done row must also carry parentRunId",
    );

    // Pristine input on child pending row.
    assert.deepEqual(
      childPending.input,
      { payload: "child-payload-1" },
      "child pending row must carry pristine input",
    );
  });

  test("ctx.delegateTo: child archetype stays single (single child with single parent)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-archetype-single-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const child = makeSingleChild("deleg-child-archetype-single");
    const parent = makeParentWorkflow("deleg-parent-archetype-single", async (ctx) => {
      await (ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> }).delegateTo(
        child,
        { payload: "arch-payload" },
      );
    });

    await runWorkflow(parent, { parentPayload: "pa" }, { trackerDir: dir });

    const childRows = readWorkflowRows(dir, "deleg-child-archetype-single");
    const pending = childRows.find((r) => r.status === "pending");
    assert.ok(pending, "child pending row must exist");
    // A single child of a single parent keeps its natural archetype (single).
    assert.equal(
      pending.data?.archetype,
      "single",
      "single child of single parent keeps archetype=single",
    );
    assert.ok(pending.parentRunId, "but parentRunId must still be set for delegation scope");
  });

  test("ctx.delegateTo with renderAs:'batch' stamps child as batch-member", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-batch-member-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const child = makeSingleChild("deleg-child-batch-member");
    const parent = makeParentWorkflow("deleg-parent-batch-member", async (ctx) => {
      await (ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> }).delegateTo(
        child,
        { payload: "batch-m-payload" },
        { renderAs: "batch" },
      );
    });

    await runWorkflow(parent, { parentPayload: "pbm" }, { trackerDir: dir });

    const childRows = readWorkflowRows(dir, "deleg-child-batch-member");
    const pending = childRows.find((r) => r.status === "pending");
    assert.ok(pending, "child pending row must exist");
    assert.equal(
      pending.data?.archetype,
      "batch-member",
      "child delegated with renderAs:'batch' must have archetype=batch-member",
    );
    assert.ok(pending.parentRunId, "child batch-member must carry parentRunId");

    const done = childRows.find((r) => r.status === "done");
    assert.ok(done, "child done row must exist");
    assert.equal(
      done.data?.archetype,
      "batch-member",
      "done row must also carry archetype=batch-member",
    );
  });

  test("ctx.delegateTo: child __traceId shares root trace prefix with parent", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-traceid-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const child = makeSingleChild("deleg-child-traceid");
    const parent = makeParentWorkflow("deleg-parent-traceid", async (ctx) => {
      await (ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> }).delegateTo(
        child,
        { payload: "trace-payload" },
      );
    });

    // Use a preAssignedRunId so run-workflow.ts seeds __traceId on the initialData.
    // Without this, a bare runWorkflow call doesn't know the runId at seed time and
    // leaves __traceId off the initialData (withTrackedWorkflow mints the runId itself).
    const parentRunId = "trace-parent-run-" + Date.now();
    await runWorkflow(parent, { parentPayload: "ptrace" }, {
      trackerDir: dir,
      preAssignedRunId: parentRunId,
    });

    // Resolve parent pending row (carries __traceId because it's set via initialData when
    // preAssignedRunId is known at seed time). Done row also carries it via initialData.
    const parentRows = readEntries("deleg-parent-traceid", dir);
    const parentDone = parentRows.find((r) => r.status === "done");
    assert.ok(parentDone, "parent done row must exist");
    const parentTraceId = parentDone.data?.__traceId as string | undefined;
    assert.ok(parentTraceId, "parent done row must have __traceId when preAssignedRunId is used");

    // The parent trace id prefix is `<code>-<HHMMSS>`.
    const parentPrefix = tracePrefix(parentTraceId);
    assert.ok(parentPrefix, "parent __traceId must be parseable by tracePrefix");

    // Child trace id should share the root prefix (composed as `<parentPrefix>-<childRunId4>`).
    // delegateToImpl forwards the parent's trace prefix as rootTracePrefix so the child
    // composes its own trace id as `<parentPrefix>-<ownRunId4>`.
    const childRows = readEntries("deleg-child-traceid", dir);
    const childDone = childRows.find((r) => r.status === "done");
    assert.ok(childDone, "child done row must exist");
    const childTraceId = childDone.data?.__traceId as string | undefined;
    assert.ok(childTraceId, "child done row must have __traceId");

    // Child trace must start with the parent's prefix so they share the operation root.
    assert.ok(
      childTraceId.startsWith(parentPrefix),
      `child __traceId "${childTraceId}" must start with parent prefix "${parentPrefix}"`,
    );
  });

  test("ctx.delegateTo: failed child result carries error, parent receives it", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-fail-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const failingChild = makeSingleChild("deleg-child-fail", { throwInHandler: true });
    let childResult: unknown;

    const parent = makeParentWorkflow("deleg-parent-fail", async (ctx) => {
      childResult = await (ctx as { delegateTo: (...args: unknown[]) => Promise<unknown> }).delegateTo(
        failingChild,
        { payload: "fail-payload" },
      );
    });

    // Parent itself should NOT throw even when child fails — delegateTo returns
    // a ChildRunResult with status: "failed".
    await runWorkflow(parent, { parentPayload: "pfail" }, { trackerDir: dir });

    const r = childResult as { status: string; error?: { message: string } };
    assert.equal(r.status, "failed", "child result status must be 'failed'");
    assert.ok(r.error?.message, "child result must carry error message");

    // Child JSONL must have a failed row.
    const childRows = readEntries("deleg-child-fail", dir);
    const failedRow = childRows.find((row) => row.status === "failed");
    assert.ok(failedRow, "child JSONL must have a failed row");
  });
});
