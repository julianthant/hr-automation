import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  summarizeQueueSurfaces,
  recordQueueSurfaceTransitions,
  __resetQueueSurfaceDebugForTests,
  type QueueSurfaceSnapshot,
} from "../../../src/tracker/queue-surfaces-debug.js";
import { dateLocal } from "../../../src/tracker/jsonl-io.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

function prepParent(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "oath-signature",
    timestamp: "2026-05-22T06:00:00.000Z",
    id: "ocr-prep-abc",
    runId: "prep-run-1",
    status: "running",
    step: "ocr",
    data: { archetype: "batch-parent", mode: "prepare", pdfOriginalName: "x.pdf" },
    ...overrides,
  } as TrackerEntry;
}

function child(overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "id" | "runId" | "parentRunId">): TrackerEntry {
  return {
    workflow: "oath-signature",
    timestamp: "2026-05-22T06:01:00.000Z",
    status: "running",
    data: { archetype: "delegate-child" },
    ...overrides,
  } as TrackerEntry;
}

describe("summarizeQueueSurfaces", () => {
  it("classifies an approved prep parent with one signer as an approval-delegation card", () => {
    const snapshots = summarizeQueueSurfaces("oath-signature", [
      prepParent({ status: "done", step: "approved" }),
      child({ id: "10000001", runId: "kernel-1", parentRunId: "prep-run-1" }),
    ]);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.surface, "card:approval-delegation:approved");
    assert.equal(snapshots[0]?.memberCount, 1);
    assert.deepEqual(snapshots[0]?.memberIds, ["10000001"]);
  });

  it("classifies a pre-approval prep parent as an awaiting-approval card", () => {
    const snapshots = summarizeQueueSurfaces("oath-signature", [prepParent()]);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.surface, "card:approval-delegation:awaiting-approval");
  });

  it("classifies an approved prep parent with no visible members as flat:self", () => {
    const snapshots = summarizeQueueSurfaces("oath-signature", [
      prepParent({ status: "done", step: "approved" }),
    ]);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.surface, "flat:self");
  });

  it("keeps every single-signer prep PDF as its own card (multi-PDF upload)", () => {
    // Regression mirror of the reported bug: three independent prep runs,
    // two of them single-signer — all three must stay batch cards.
    const snapshots = summarizeQueueSurfaces("oath-signature", [
      prepParent({ id: "prep-a", runId: "run-a", status: "done", step: "approved" }),
      child({ id: "a1", runId: "k-a1", parentRunId: "run-a" }),
      child({ id: "a2", runId: "k-a2", parentRunId: "run-a" }),
      prepParent({ id: "prep-b", runId: "run-b", status: "done", step: "approved" }),
      child({ id: "b1", runId: "k-b1", parentRunId: "run-b" }),
      prepParent({ id: "prep-c", runId: "run-c", status: "done", step: "approved" }),
      child({ id: "c1", runId: "k-c1", parentRunId: "run-c" }),
    ]);
    assert.equal(snapshots.length, 3);
    assert.ok(
      snapshots.every((s) => s.surface === "card:approval-delegation:approved"),
      "all three prep PDFs should resolve to approval-delegation cards",
    );
  });
});

describe("recordQueueSurfaceTransitions", () => {
  function snap(surface: string): QueueSurfaceSnapshot {
    return {
      workflow: "oath-signature",
      anchorRunId: "prep-run-1",
      anchorId: "ocr-prep-abc",
      archetype: "batch-parent",
      approved: surface.includes("approved"),
      step: "ocr",
      status: "running",
      surface,
      memberCount: 1,
      memberIds: ["10000001"],
    };
  }

  function readDebugLines(dir: string): Array<Record<string, unknown>> {
    const file = join(dir, "debug", `queue-surfaces-${dateLocal()}.jsonl`);
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("logs first-seen anchors, suppresses no-ops, and logs surface changes", () => {
    __resetQueueSurfaceDebugForTests();
    const dir = mkdtempSync(join(tmpdir(), "qs-debug-"));

    // First sighting → one line with from:null.
    recordQueueSurfaceTransitions([snap("card:approval-delegation:awaiting-approval")], dir);
    let lines = readDebugLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.from, null);
    assert.equal(lines[0]?.to, "card:approval-delegation:awaiting-approval");

    // Unchanged surface → no new line.
    recordQueueSurfaceTransitions([snap("card:approval-delegation:awaiting-approval")], dir);
    assert.equal(readDebugLines(dir).length, 1);

    // Surface changed → one transition line with the prior surface.
    recordQueueSurfaceTransitions([snap("card:approval-delegation:approved")], dir);
    lines = readDebugLines(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[1]?.from, "card:approval-delegation:awaiting-approval");
    assert.equal(lines[1]?.to, "card:approval-delegation:approved");
  });

  it("does not write a file when there are no transitions", () => {
    __resetQueueSurfaceDebugForTests();
    const dir = mkdtempSync(join(tmpdir(), "qs-debug-"));
    recordQueueSurfaceTransitions([], dir);
    assert.throws(() => readDebugLines(dir), /ENOENT/);
  });
});
