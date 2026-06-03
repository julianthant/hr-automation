import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../_utils/render-with-providers";
import { RowFooter } from "@/components/queue-panel/RowFooter";
import { buildWorkflowRunProjection } from "../../src/domain/workflow-runtime/projection.js";
import type { TrackerEntry } from "@/components/shared/types";
import type { WorkflowActionDescriptor } from "../../src/domain/workflow-runtime/types.js";

/**
 * The unified footer (`RowFooter`) renders ONE ordered button schema —
 * bump · retry · cancel · delete — and each button self-hides on its kernel
 * descriptor's `enabled` flag. The projection (`buildWorkflowRunProjection`,
 * via `rowActionEnabledForStatus`) is the single source of truth for which
 * descriptors are enabled per status, so these tests drive RowFooter with the
 * REAL projection output to pin the status-gating matrix end to end:
 *
 *   running  → cancel (×)
 *   queued   → bump (▲) + cancel (×)
 *   done     → retry (↻) + delete (🗑)
 *   failed   → retry (↻) + delete (🗑)
 *   cancelled (failed + step:"cancelled") → retry (↻) + delete (🗑)
 */

function entry(overrides: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "onboarding",
    id: "10012345",
    runId: "run-1",
    timestamp: "2026-05-19T12:54:08.000Z",
    status: "running",
    ...overrides,
  } as TrackerEntry;
}

/** Real status-gated descriptors for a row at `status`/`step`. */
function actionsForStatus(
  status: TrackerEntry["status"],
  step?: string,
): WorkflowActionDescriptor[] {
  return buildWorkflowRunProjection(entry({ status, step }), {}).actions;
}

function renderFooter(
  rowAction: Parameters<typeof RowFooter>[0]["rowAction"],
  extra: Partial<Parameters<typeof RowFooter>[0]> = {},
) {
  return renderWithProviders(
    <RowFooter
      time="12:54 PM"
      runNumber={1}
      elapsed="0m 48s"
      rowAction={rowAction}
      {...extra}
    />,
  );
}

const baseRowAction = {
  workflow: "onboarding",
  id: "10012345",
  runId: "run-1",
  date: "2026-05-19",
  onDelete: () => {},
};

function queryRetry() {
  return screen.queryByRole("button", { name: /retry this run/i });
}
function queryDelete() {
  return screen.queryByRole("button", { name: /delete this (entry|run) permanently/i });
}
function queryCancel() {
  return screen.queryByRole("button", { name: /stop running item|cancel queued item|discard ocr prep/i });
}
function queryBump() {
  return screen.queryByRole("button", { name: /move up in queue/i });
}

describe("RowFooter status-gated action matrix", () => {
  it("renders ONLY the cancel button for a running row", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("running") });
    expect(queryCancel()).toBeInTheDocument();
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryRetry()).not.toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });

  it("renders bump and cancel (no retry, no delete) for a queued row", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("pending") });
    expect(queryBump()).toBeInTheDocument();
    expect(queryCancel()).toBeInTheDocument();
    expect(queryRetry()).not.toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });

  it("renders retry and delete (no bump, no cancel) for a done row", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("done") });
    expect(queryRetry()).toBeInTheDocument();
    expect(queryDelete()).toBeInTheDocument();
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryCancel()).not.toBeInTheDocument();
  });

  it("renders retry and delete (no bump, no cancel) for a failed row", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("failed") });
    expect(queryRetry()).toBeInTheDocument();
    expect(queryDelete()).toBeInTheDocument();
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryCancel()).not.toBeInTheDocument();
  });

  it("treats a cancelled row (failed + step:cancelled) as terminal: retry and delete", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("failed", "cancelled") });
    expect(queryRetry()).toBeInTheDocument();
    expect(queryDelete()).toBeInTheDocument();
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryCancel()).not.toBeInTheDocument();
  });
});

describe("RowFooter button self-hiding on disabled descriptors", () => {
  it("renders no action buttons when every descriptor is disabled", () => {
    const allDisabled: WorkflowActionDescriptor[] = (["bump", "retry", "cancel", "delete"] as const).map(
      (kind) => ({
        kind,
        scope: "row",
        source: "queue-panel",
        label: kind,
        enabled: false,
        targets: [{ workflowId: "onboarding", id: "10012345", runId: "run-1" }],
      }),
    );
    renderFooter({ ...baseRowAction, actions: allDisabled });
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryRetry()).not.toBeInTheDocument();
    expect(queryCancel()).not.toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });

  it("renders no action cluster at all when rowAction is omitted", () => {
    renderWithProviders(<RowFooter time="12:54 PM" runNumber={1} elapsed="0m 48s" />);
    expect(queryBump()).not.toBeInTheDocument();
    expect(queryRetry()).not.toBeInTheDocument();
    expect(queryCancel()).not.toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });

  it("omits delete even on a terminal row when onDelete/date are absent", () => {
    // DeleteButton only renders when both onDelete and date are supplied by the
    // footer (the delete transport needs the tracker date).
    renderFooter({
      workflow: "onboarding",
      id: "10012345",
      runId: "run-1",
      actions: actionsForStatus("done"),
    });
    expect(queryRetry()).toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });
});

describe("RowFooter secondary id dedup + meta", () => {
  it("shows the secondary id when it differs from the title", () => {
    renderFooter(
      { ...baseRowAction, actions: actionsForStatus("done") },
      { secondaryId: "ou-143012-a3f1", suppressIdWhenEquals: "Maria Gonzalez" },
    );
    expect(screen.getByText("ou-143012-a3f1")).toBeInTheDocument();
  });

  it("suppresses the secondary id when it equals the row title", () => {
    renderFooter(
      { ...baseRowAction, actions: actionsForStatus("done") },
      { secondaryId: "Maria Gonzalez", suppressIdWhenEquals: "Maria Gonzalez" },
    );
    expect(screen.queryByText("Maria Gonzalez")).not.toBeInTheDocument();
  });

  it("renders the time and #run meta", () => {
    renderFooter({ ...baseRowAction, actions: actionsForStatus("done") });
    expect(screen.getByText("12:54 PM")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  it("prefers a custom actions cluster over the rowAction buttons", () => {
    renderFooter(
      { ...baseRowAction, actions: actionsForStatus("done") },
      { actions: <button type="button">custom-bulk-action</button> },
    );
    expect(screen.getByText("custom-bulk-action")).toBeInTheDocument();
    // rowAction's retry/delete are NOT rendered when a custom cluster is given.
    expect(queryRetry()).not.toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
  });
});
