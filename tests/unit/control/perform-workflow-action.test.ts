/**
 * Unit tests for src/control/actions/perform-workflow-action.ts
 *
 * Covers the action dispatcher: routing cancel/retry/delete/bump to the right
 * handler per target status; rejections for invalid action/scope/source combos.
 *
 * Strategy: mock the low-level ops handlers and resolveActionTargets so we can
 * assert the correct handler is called with the expected arguments without
 * requiring a real filesystem or SQLite DB.
 */
import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works.
//
// We mock the ops/index module (which re-exports all handler builders) and
// resolve-targets so that performWorkflowAction routes to our spies instead
// of real implementations.
// ---------------------------------------------------------------------------

const mockCancelQueuedFn = vi.fn().mockResolvedValue({ ok: true });
const mockCancelRunningFn = vi.fn().mockResolvedValue({ ok: true });
const mockReEnqueueFn = vi.fn().mockResolvedValue({ ok: true });
const mockDeleteFn = vi.fn().mockReturnValue({ ok: true });
const mockBumpFn = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../../../src/control/ops/index.js", () => ({
  buildCancelQueuedHandler: () => mockCancelQueuedFn,
  buildCancelRunningHandler: () => mockCancelRunningFn,
  buildEntryReEnqueueHandler: () => mockReEnqueueFn,
  buildDeleteEntryHandler: () => mockDeleteFn,
  buildQueueBumpHandler: () => mockBumpFn,
}));

vi.mock("../../../src/control/ocr/discard.js", () => ({
  buildOcrDiscardHandler: () => vi.fn().mockResolvedValue({ status: 200, body: { ok: true } }),
}));

vi.mock("../../../src/control/actions/resolve-targets.js", () => ({
  resolveActionTargets: vi.fn(),
}));

// Import after mocks so the mocked versions are used
import { performWorkflowAction } from "../../../src/control/actions/perform-workflow-action.js";
import { resolveActionTargets } from "../../../src/control/actions/resolve-targets.js";

const mockedResolveTargets = vi.mocked(resolveActionTargets);

const DEPS = { dir: "/tmp/fake-tracker" };

function makeRequest(
  overrides: Partial<Parameters<typeof performWorkflowAction>[0]>,
): Parameters<typeof performWorkflowAction>[0] {
  return {
    action: "cancel",
    scope: "row",
    source: "queue-panel",
    workflowId: "work-study",
    targets: [{ workflowId: "work-study", id: "item-1", date: "2026-06-02" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: resolveActionTargets returns a healthy target set
  mockedResolveTargets.mockReturnValue({
    ok: true,
    targets: [
      {
        workflow: "work-study",
        id: "item-1",
        runId: "run-a",
        date: "2026-06-02",
        status: "pending" as const,
      },
    ],
  });
});

describe("performWorkflowAction — request-level rejections", () => {
  it("rejects stop-daemon action with a descriptive error", async () => {
    const result = await performWorkflowAction(
      makeRequest({ action: "stop-daemon" as never }),
      DEPS,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /stop-daemon is operational control/);
    assert.equal(result.count, 0);
  });

  it("rejects source: daemon with a descriptive error", async () => {
    const result = await performWorkflowAction(
      makeRequest({ source: "daemon" as never }),
      DEPS,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /daemon is not a workflow action source/);
  });

  it("rejects scope: daemon with a descriptive error", async () => {
    const result = await performWorkflowAction(
      makeRequest({ scope: "daemon" as never }),
      DEPS,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /daemon scope is operational control/);
  });

  it("rejects bump action with scope other than row", async () => {
    const result = await performWorkflowAction(
      makeRequest({ action: "bump", scope: "group" }),
      DEPS,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /bump is only valid for scope: row/);
  });

  it("rejects an unsupported action string", async () => {
    const result = await performWorkflowAction(
      makeRequest({ action: "teleport" as never }),
      DEPS,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unsupported action/);
  });
});

describe("performWorkflowAction — resolveActionTargets failure", () => {
  it("returns ok:false when resolveActionTargets fails", async () => {
    mockedResolveTargets.mockReturnValueOnce({ ok: false, error: "target resolution failed" });

    const result = await performWorkflowAction(makeRequest({ action: "cancel" }), DEPS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /target resolution failed/);
  });
});

describe("performWorkflowAction — cancel action routing", () => {
  it("routes a queued target to cancelQueuedHandler", async () => {
    mockedResolveTargets.mockReturnValueOnce({
      ok: true,
      targets: [{ workflow: "work-study", id: "item-1", runId: "run-a", date: "2026-06-02", status: "pending" }],
    });

    const result = await performWorkflowAction(makeRequest({ action: "cancel" }), DEPS);

    assert.equal(result.ok, true);
    assert.equal(mockCancelQueuedFn.mock.calls.length, 1);
    assert.equal(mockCancelRunningFn.mock.calls.length, 0);
    const callArg = mockCancelQueuedFn.mock.calls[0]?.[0] as { workflow: string; id: string };
    assert.equal(callArg.workflow, "work-study");
    assert.equal(callArg.id, "item-1");
  });

  it("routes a running target to cancelRunningHandler", async () => {
    mockedResolveTargets.mockReturnValueOnce({
      ok: true,
      targets: [{ workflow: "work-study", id: "item-1", runId: "run-a", date: "2026-06-02", status: "running" }],
    });

    await performWorkflowAction(makeRequest({ action: "cancel" }), DEPS);

    assert.equal(mockCancelRunningFn.mock.calls.length, 1);
    assert.equal(mockCancelQueuedFn.mock.calls.length, 0);
    const callArg = mockCancelRunningFn.mock.calls[0]?.[0] as { workflow: string; id: string; runId: string };
    assert.equal(callArg.runId, "run-a");
  });

  it("fails a running target cancel when runId is missing", async () => {
    mockedResolveTargets.mockReturnValueOnce({
      ok: true,
      targets: [{ workflow: "work-study", id: "item-1", date: "2026-06-02", status: "running" }],
    });

    const result = await performWorkflowAction(makeRequest({ action: "cancel" }), DEPS);

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.error ?? "", /runId is required/);
  });
});

describe("performWorkflowAction — retry action routing", () => {
  it("calls buildEntryReEnqueueHandler for a retry action", async () => {
    const result = await performWorkflowAction(makeRequest({ action: "retry" }), DEPS);

    assert.equal(result.ok, true);
    assert.equal(mockReEnqueueFn.mock.calls.length, 1);
    const callArg = mockReEnqueueFn.mock.calls[0]?.[0] as { workflow: string; id: string };
    assert.equal(callArg.workflow, "work-study");
    assert.equal(callArg.id, "item-1");
  });

  it("passes parentRunId to the retry handler when provided", async () => {
    await performWorkflowAction(
      makeRequest({ action: "retry", parentRunId: "batch-run-xyz" }),
      DEPS,
    );

    const callArg = mockReEnqueueFn.mock.calls[0]?.[0] as { parentRunId?: string };
    assert.equal(callArg.parentRunId, "batch-run-xyz");
  });
});

describe("performWorkflowAction — delete action routing", () => {
  it("calls buildDeleteEntryHandler with workflow/id/date for a delete action", async () => {
    const result = await performWorkflowAction(makeRequest({ action: "delete" }), DEPS);

    assert.equal(result.ok, true);
    assert.equal(mockDeleteFn.mock.calls.length, 1);
    const callArg = mockDeleteFn.mock.calls[0]?.[0] as { workflow: string; id: string; date: string };
    assert.equal(callArg.workflow, "work-study");
    assert.equal(callArg.id, "item-1");
    assert.equal(callArg.date, "2026-06-02");
  });

  it("fails the target when date is missing from the resolved target", async () => {
    mockedResolveTargets.mockReturnValueOnce({
      ok: true,
      targets: [{ workflow: "work-study", id: "item-1", runId: "run-a" }], // no date
    });

    const result = await performWorkflowAction(makeRequest({ action: "delete" }), DEPS);

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.error ?? "", /date is required/);
  });
});

describe("performWorkflowAction — bump action routing", () => {
  it("calls buildQueueBumpHandler for a bump action with scope row", async () => {
    const result = await performWorkflowAction(
      makeRequest({ action: "bump", scope: "row" }),
      DEPS,
    );

    assert.equal(result.ok, true);
    assert.equal(mockBumpFn.mock.calls.length, 1);
    const callArg = mockBumpFn.mock.calls[0]?.[0] as { workflow: string; id: string };
    assert.equal(callArg.workflow, "work-study");
    assert.equal(callArg.id, "item-1");
  });
});

describe("performWorkflowAction — result shape", () => {
  it("returns count of successful targets", async () => {
    mockedResolveTargets.mockReturnValueOnce({
      ok: true,
      targets: [
        { workflow: "work-study", id: "item-1", runId: "run-a", date: "2026-06-02", status: "pending" },
        { workflow: "work-study", id: "item-2", runId: "run-b", date: "2026-06-02", status: "pending" },
      ],
    });

    const result = await performWorkflowAction(makeRequest({ action: "cancel" }), DEPS);
    assert.equal(result.count, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(result.ok, true);
  });

  it("includes action and scope in the result", async () => {
    const result = await performWorkflowAction(
      makeRequest({ action: "retry", scope: "group" }),
      DEPS,
    );
    assert.equal(result.action, "retry");
    assert.equal(result.scope, "group");
  });
});
