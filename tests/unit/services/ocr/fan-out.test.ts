import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type {
  ChildOutcome,
  WatchChildRunsOpts,
} from "../../../../src/tracker/delegation/watch-child-runs.js";
import type { FanOutChild } from "../../../../src/services/ocr/fan-out.js";

// fanOutAndWatch is the shared OCR dispatch→watch→cascade-cancel pipeline (BM-1).
// These tests pin its contract independent of the call sites that reuse it: the
// dispatch override is honored, outcomes are keyed by itemId, missing itemIds
// are reported, and an operator discard-abort cascade-cancels queued children.

const mocks = vi.hoisted(() => ({
  cascadeCalls: [] as Array<{ parentRunId: string }>,
}));

vi.mock("../../../../src/tracker/tasks/store.js", () => ({
  openTaskStore: vi.fn(() => ({ db: {} })),
  cancelQueuedChildTasksForParentRun: vi.fn(
    (_store: unknown, input: { parentRunId: string }) => {
      mocks.cascadeCalls.push({ parentRunId: input.parentRunId });
      return 1;
    },
  ),
}));

vi.mock("../../../../src/tracker/ocr-prepare-abort.js", () => ({
  isOcrPrepareAbortRequested: vi.fn(() => false),
  isOperatorDiscardAbortError: (err: unknown) =>
    err instanceof Error && err.name === "OcrPrepareOperatorDiscardAbort",
}));

// A fake "child workflow" — only `.config.name` is read by fanOutAndWatch.
const fakeChild = { config: { name: "person-lookup" } } as never;

function child(itemId: string, name: string): FanOutChild<{ name: string }> {
  return { input: { name }, itemId };
}

describe("fanOutAndWatch", () => {
  it("dispatches via the override, keys outcomes by itemId, and reports missing itemIds", async () => {
    mocks.cascadeCalls.length = 0;
    vi.resetModules();
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");

    let dispatched: ReadonlyArray<FanOutChild<{ name: string }>> | null = null;
    let watchedWorkflow = "";
    const result = await fanOutAndWatch<{ name: string }>({
      sessionId: "s1",
      runId: "r1",
      parentRunId: "parent-1",
      trackerDir: undefined,
      date: "2026-06-11",
      child: fakeChild,
      children: [child("item-a", "Doe, Jane"), child("item-b", "Roe, Sam")],
      timeoutMs: 1000,
      dispatch: async (children) => {
        dispatched = children;
      },
      watch: async (opts: WatchChildRunsOpts): Promise<ChildOutcome[]> => {
        watchedWorkflow = opts.workflow;
        // Only item-a returns; item-b times out (no outcome).
        return [
          { workflow: "person-lookup", itemId: "item-a", runId: "cr-a", status: "done" },
        ];
      },
    });

    assert.ok(dispatched, "dispatch override must be invoked");
    assert.equal((dispatched as ReadonlyArray<FanOutChild<{ name: string }>>).length, 2);
    assert.equal(watchedWorkflow, "person-lookup", "watch keys on child.config.name by default");
    assert.equal(result.outcomes.length, 1);
    assert.ok(result.byItemId.has("item-a"));
    assert.deepEqual(result.missingItemIds, ["item-b"]);
  });

  it("honors an explicit watchWorkflow override (i9-lookup vs the delegated child)", async () => {
    vi.resetModules();
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");
    let watchedWorkflow = "";
    await fanOutAndWatch<{ name: string }>({
      sessionId: "s1",
      runId: "r1",
      parentRunId: "parent-1",
      trackerDir: undefined,
      date: "2026-06-11",
      child: fakeChild,
      watchWorkflow: "i9-lookup",
      children: [child("item-a", "Doe, Jane")],
      timeoutMs: 1000,
      dispatch: async () => {},
      watch: async (opts: WatchChildRunsOpts): Promise<ChildOutcome[]> => {
        watchedWorkflow = opts.workflow;
        return [];
      },
    });
    assert.equal(watchedWorkflow, "i9-lookup");
  });

  it("cascade-cancels queued children on an operator discard-abort, then rethrows", async () => {
    mocks.cascadeCalls.length = 0;
    vi.resetModules();
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");

    let threw: unknown;
    try {
      await fanOutAndWatch<{ name: string }>({
        sessionId: "s1",
        runId: "r1",
        parentRunId: "parent-cancel",
        trackerDir: "unused",
        date: "2026-06-11",
        child: fakeChild,
        children: [child("item-a", "Doe, Jane")],
        timeoutMs: 1000,
        dispatch: async () => {},
        watch: async (): Promise<ChildOutcome[]> => {
          const err = new Error("operator discarded OCR prep");
          err.name = "OcrPrepareOperatorDiscardAbort";
          throw err;
        },
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, "fanOutAndWatch must rethrow the discard-abort error");
    assert.equal((threw as Error).name, "OcrPrepareOperatorDiscardAbort");
    assert.equal(mocks.cascadeCalls.length, 1);
    assert.equal(mocks.cascadeCalls[0]?.parentRunId, "parent-cancel");
  });

  it("does NOT cascade-cancel on a non-abort watch failure (propagates as-is)", async () => {
    mocks.cascadeCalls.length = 0;
    vi.resetModules();
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");

    let threw: unknown;
    try {
      await fanOutAndWatch<{ name: string }>({
        sessionId: "s1",
        runId: "r1",
        parentRunId: "parent-fail",
        trackerDir: "unused",
        date: "2026-06-11",
        child: fakeChild,
        children: [child("item-a", "Doe, Jane")],
        timeoutMs: 1000,
        dispatch: async () => {},
        watch: async (): Promise<ChildOutcome[]> => {
          throw new Error("watchChildRuns timeout");
        },
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, "a non-abort watch failure must propagate");
    assert.equal((threw as Error).message, "watchChildRuns timeout");
    assert.equal(mocks.cascadeCalls.length, 0, "no cascade-cancel on a non-abort failure");
  });

  it("derives child itemIds by JSON (survives delegateToAllImpl's input clone), not object identity", async () => {
    // delegateToAllImpl wraps each input with __runtimeOptions then strips them
    // via splitPrefilled before calling deriveItemId — so deriveItemId sees a
    // NEW cleaned object, never the original `c.input` reference. A
    // reference-keyed map would miss → empty itemId → invisible row → the watch
    // hangs (the bug the Tier-1 ocr-verify-lookup test caught). Mock the real
    // delegate path to invoke deriveItemId with a structural CLONE and assert the
    // correct itemIds still come back.
    vi.resetModules();
    vi.doMock("../../../../src/core/delegate.js", () => ({
      delegateToAllImpl: async (opts: {
        inputs: ReadonlyArray<{ name: string }>;
        deriveItemId: (input: { name: string }) => string;
      }) =>
        opts.inputs.map((input, index) => {
          // Clone (drop reference identity) like splitPrefilled does.
          const cleaned = JSON.parse(JSON.stringify(input)) as { name: string };
          return { itemId: opts.deriveItemId(cleaned), runId: `cr-${index}`, workflow: "person-lookup", status: "pending" as const };
        }),
    }));
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");

    const dispatchedItemIds: string[] = [];
    await fanOutAndWatch<{ name: string }>({
      sessionId: "s1",
      runId: "r1",
      parentRunId: "p1",
      trackerDir: undefined,
      date: "2026-06-11",
      child: fakeChild,
      children: [child("item-a", "Doe, Jane"), child("item-b", "Roe, Sam")],
      timeoutMs: 1000,
      onDispatched: (results) => dispatchedItemIds.push(...results.map((r) => r.itemId)),
      watch: async (): Promise<ChildOutcome[]> => [],
    });
    // If deriveItemId had keyed by object identity, these would be "" (empty).
    assert.deepEqual(dispatchedItemIds.sort(), ["item-a", "item-b"]);
    vi.doUnmock("../../../../src/core/delegate.js");
  });

  it("assigns duplicate logical inputs distinct itemIds in FIFO order", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/core/delegate.js", () => ({
      delegateToAllImpl: async (opts: {
        inputs: ReadonlyArray<{ name: string }>;
        deriveItemId: (input: { name: string }) => string;
      }) => opts.inputs.map((input, index) => ({
        itemId: opts.deriveItemId(JSON.parse(JSON.stringify(input))),
        runId: `duplicate-${index}`,
      })),
    }));
    const { fanOutAndWatch } = await import("../../../../src/services/ocr/fan-out.js");
    const dispatched: string[] = [];
    await fanOutAndWatch({
      sessionId: "s-duplicate", runId: "r-duplicate", parentRunId: "p-duplicate",
      trackerDir: undefined, date: "2026-07-15",
      child: fakeChild,
      children: [child("duplicate-a", "Same Person"), child("duplicate-b", "Same Person")],
      timeoutMs: 100,
      onDispatched: (rows) => { dispatched.push(...rows.map((row) => row.itemId)); },
      watch: async () => [],
    });
    assert.deepEqual(dispatched, ["duplicate-a", "duplicate-b"]);
    vi.doUnmock("../../../../src/core/delegate.js");
  });
});
