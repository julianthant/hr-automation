import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../_utils/render-with-providers";
import { DaemonBatchRow } from "@/components/queue-panel/DaemonBatchRow";
import type { TrackerEntry } from "@/components/shared/types";

/**
 * DaemonBatchRow regression contract (src/dashboard/CLAUDE.md, 2026-06-01):
 * a `batch` anchor that has NOT fanned out yet (0 members) must still render a
 * usable footer — its time / elapsed / retry+delete derive from the
 * `anchorEntry`, while the count badge + progress bar stay 0/0 (driven by the
 * empty `memberEntries`). Once members exist, the footer derives from members.
 */

function member(overrides: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "emergency-contact",
    id: "10874100",
    runId: "kernel-1",
    parentRunId: "batch-run-1",
    timestamp: "2026-05-19T12:55:00.000Z",
    firstLogTs: "2026-05-19T12:55:00.000Z",
    lastLogTs: "2026-05-19T12:56:00.000Z",
    status: "failed",
    data: { archetype: "batch-member", emplId: "10874100", name: "Correa Dinora" },
    ...overrides,
  } as TrackerEntry;
}

function anchor(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "oath-signature",
    id: "batch-anchor-1",
    runId: "batch-run-1",
    timestamp: "2026-05-19T12:54:08.000Z",
    firstLogTs: "2026-05-19T12:53:20.000Z",
    lastLogTs: "2026-05-19T12:54:08.000Z",
    status: "running",
    data: { archetype: "batch" },
    ...overrides,
  } as TrackerEntry;
}

function renderBatch(props: Partial<Parameters<typeof DaemonBatchRow>[0]> = {}) {
  return renderWithProviders(
    <DaemonBatchRow
      workflow="oath-signature"
      date="2026-05-19"
      batchParentRunId="batch-run-1"
      workflowLabel="Oath Signature"
      memberEntries={[]}
      isBatchQueueFocused={false}
      onEnterBatchQueue={() => {}}
      {...props}
    />,
  );
}

function queryRetryAll() {
  return screen.queryByRole("button", { name: /retry all .* in this batch/i });
}
function queryDeleteAll() {
  return screen.queryByRole("button", { name: /delete all entries in this batch/i });
}

describe("DaemonBatchRow 0-member anchor fallback", () => {
  it("shows a 0/0 count badge when there are no members", () => {
    renderBatch({ memberEntries: [], anchorEntry: anchor() });
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("derives retry/delete footer actions from the anchor when there are no members", () => {
    renderBatch({ memberEntries: [], anchorEntry: anchor() });
    // footerEntries falls back to [anchor], so the bulk footer renders retry-all
    // (1 item = the anchor) + delete-all (date is present).
    const retry = queryRetryAll();
    expect(retry).toBeInTheDocument();
    expect(retry).toHaveAccessibleName(/retry all 1 item in this batch/i);
    expect(queryDeleteAll()).toBeInTheDocument();
  });

  it("renders no footer actions when there is neither a member nor an anchor", () => {
    // footerEntries is the empty member list → BatchFooterActions has no
    // targets → both bulk buttons self-hide.
    renderBatch({ memberEntries: [], anchorEntry: undefined });
    expect(queryRetryAll()).not.toBeInTheDocument();
    expect(queryDeleteAll()).not.toBeInTheDocument();
  });

  it("omits the delete-all button when no tracker date is available", () => {
    renderBatch({ memberEntries: [], anchorEntry: anchor(), date: undefined });
    // Retry can still target the anchor, but bulk delete needs a date.
    expect(queryRetryAll()).toBeInTheDocument();
    expect(queryDeleteAll()).not.toBeInTheDocument();
  });
});

describe("DaemonBatchRow with members present", () => {
  it("derives the count badge and footer actions from members, not the anchor", () => {
    renderBatch({
      memberEntries: [
        member({ id: "10874100", runId: "kernel-1", status: "failed" }),
        member({ id: "10874200", runId: "kernel-2", status: "done", data: { name: "Jordan Vale" } }),
      ],
      anchorEntry: anchor(),
    });
    // 2 members: 1 done, 1 failed → badge 1/2.
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    // Footer retry-all reflects the 2 member targets (not the single anchor).
    expect(queryRetryAll()).toHaveAccessibleName(/retry all 2 items in this batch/i);
    expect(queryDeleteAll()).toBeInTheDocument();
  });

  it("renders member names in the preview area", () => {
    renderBatch({
      memberEntries: [
        member({ id: "10874100", runId: "kernel-1", data: { name: "Correa Dinora" } }),
        member({ id: "10874200", runId: "kernel-2", data: { name: "Jordan Vale" } }),
      ],
      anchorEntry: anchor(),
    });
    expect(screen.getByText("Correa Dinora")).toBeInTheDocument();
    expect(screen.getByText("Jordan Vale")).toBeInTheDocument();
  });
});
