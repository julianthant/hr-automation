import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRowLifecycles,
  resolveRowSurfaces,
  buildTransitionTrail,
  runRowLifecycleDebugSweep,
  type RowLifecycle,
} from "../../../src/tracker/row-lifecycle-debug.js";
import { dateLocal } from "../../../src/tracker/jsonl-io.js";
import { __resetParseCacheForTests } from "../../../src/tracker/jsonl.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

function ts(sec: number): string {
  return new Date(Date.UTC(2026, 4, 22, 6, 0, sec)).toISOString();
}

function entry(o: Partial<TrackerEntry> & Pick<TrackerEntry, "id" | "status" | "timestamp">): TrackerEntry {
  return { workflow: "work-study", runId: "run-1", ...o } as TrackerEntry;
}

describe("buildRowLifecycles", () => {
  it("tracks a single row from pending to done", () => {
    const [row] = buildRowLifecycles("work-study", [
      entry({ id: "ws-1", status: "pending", timestamp: ts(0), input: { emplId: "x" } }),
      entry({ id: "ws-1", status: "running", step: "authenticating", timestamp: ts(1) }),
      entry({ id: "ws-1", status: "running", step: "updating", timestamp: ts(2), data: { name: "Jo" } }),
      entry({ id: "ws-1", status: "done", step: "updating", timestamp: ts(3) }),
    ]);
    assert.ok(row);
    assert.equal(row.id, "ws-1");
    assert.equal(row.history.length, 4);
    assert.equal(row.history[0]?.cause, "create");
    assert.equal(row.history[0]?.surface, "flat");
    assert.equal(row.currentStatus, "done");
    assert.equal(row.terminal, true);
    assert.equal(row.terminalAt, ts(3));
    assert.equal(row.endState.status, "done");
    assert.deepEqual(row.runIds, ["run-1"]);
    assert.equal(row.attemptCount, 1);
    // accumulated data carries forward across snapshots
    assert.deepEqual(row.history[3]?.data, { name: "Jo" });
    assert.deepEqual(row.history[2]?.dataChanged, ["name"]);
    assert.ok(row.events.some((e) => e.type === "reach-terminal"));
  });

  it("records a cancel with its cause and event", () => {
    const [row] = buildRowLifecycles("work-study", [
      entry({ id: "ws-2", status: "pending", timestamp: ts(0) }),
      entry({ id: "ws-2", status: "running", step: "updating", timestamp: ts(1) }),
      entry({ id: "ws-2", status: "failed", step: "cancelled", timestamp: ts(2), error: "cancelled by user" }),
    ]);
    assert.ok(row);
    const last = row.history.at(-1);
    assert.equal(last?.cause, "cancel");
    assert.equal(last?.status, "failed");
    assert.equal(row.endState.step, "cancelled");
    assert.ok(row.events.some((e) => e.type === "cancel"));
  });

  it("stitches a retry into the same row lifecycle under a new runId", () => {
    const rows = buildRowLifecycles("work-study", [
      entry({ id: "ws-3", runId: "run-A", status: "pending", timestamp: ts(0) }),
      entry({ id: "ws-3", runId: "run-A", status: "running", step: "updating", timestamp: ts(1) }),
      entry({ id: "ws-3", runId: "run-A", status: "failed", step: "cancelled", timestamp: ts(2) }),
      entry({ id: "ws-3", runId: "run-B", status: "pending", timestamp: ts(3) }),
      entry({ id: "ws-3", runId: "run-B", status: "running", step: "updating", timestamp: ts(4) }),
      entry({ id: "ws-3", runId: "run-B", status: "done", step: "updating", timestamp: ts(5) }),
    ]);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(row.runIds, ["run-A", "run-B"]);
    assert.equal(row.attemptCount, 2);
    assert.equal(row.reopenedAfterTerminal, true);
    assert.equal(row.endState.status, "done");
    const retry = row.events.find((e) => e.type === "retry");
    assert.equal(retry?.fromRunId, "run-A");
    assert.equal(retry?.toRunId, "run-B");
    assert.ok(row.history.some((s) => s.cause === "retry" && s.runId === "run-B"));
  });

  it("does not flag a post-terminal surface flip for stable batch anchors", () => {
    // Oath-signature PDF rows are real batch anchors now. Adding the signer
    // member changes member count, but the parent stays card:batch.
    const rows = buildRowLifecycles("oath-signature", [
      entry({ workflow: "oath-signature", id: "prep-1", runId: "prep-run", status: "pending", timestamp: ts(0), data: { archetype: "batch", mode: "prepare" } }),
      entry({ workflow: "oath-signature", id: "prep-1", runId: "prep-run", status: "running", step: "ocr", timestamp: ts(1), data: { archetype: "batch", mode: "prepare" } }),
      entry({ workflow: "oath-signature", id: "prep-1", runId: "prep-run", status: "done", step: "approved", timestamp: ts(2), data: { archetype: "batch", mode: "prepare" } }),
      entry({ workflow: "oath-signature", id: "signer-1", runId: "k-1", parentRunId: "prep-run", status: "pending", timestamp: ts(3), data: { archetype: "batch-member" } }),
    ]);
    const parent = rows.find((r) => r.id === "prep-1")!;
    assert.ok(parent);
    assert.equal(parent.postTerminalSurfaceChanges, 0);
    const flip = parent.events.find((e) => e.type === "post-terminal-surface-change");
    assert.equal(flip, undefined);
  });
});

describe("resolveRowSurfaces", () => {
  it("classifies a batch with members as a card and members as member rows", () => {
    const surfaces = resolveRowSurfaces([
      entry({ workflow: "oath-signature", id: "prep", runId: "prep-run", status: "running", step: "ocr", timestamp: ts(0), data: { archetype: "batch", mode: "prepare" } }),
      entry({ workflow: "oath-signature", id: "m1", runId: "k1", parentRunId: "prep-run", status: "running", timestamp: ts(1), data: { archetype: "batch-member" } }),
      entry({ workflow: "oath-signature", id: "m2", runId: "k2", parentRunId: "prep-run", status: "running", timestamp: ts(1), data: { archetype: "batch-member" } }),
    ]);
    assert.equal(surfaces.get("prep")?.surface, "card:batch");
    assert.deepEqual(surfaces.get("prep")?.memberIds, ["m1", "m2"]);
    assert.equal(surfaces.get("m1")?.surface, "member:batch");
    assert.equal(surfaces.get("m2")?.surface, "member:batch");
  });

  it("classifies an unparented single row as flat", () => {
    const surfaces = resolveRowSurfaces([
      entry({ id: "solo", status: "running", step: "updating", timestamp: ts(0) }),
    ]);
    assert.equal(surfaces.get("solo")?.surface, "flat");
  });

  it("tags a discarded prep row as discarded", () => {
    const surfaces = resolveRowSurfaces([
      entry({ workflow: "ocr", id: "prep-x", runId: "r", status: "failed", step: "discarded", timestamp: ts(0), data: { archetype: "preview", mode: "prepare" } }),
    ]);
    assert.equal(surfaces.get("prep-x")?.surface, "discarded");
  });
});

describe("buildTransitionTrail", () => {
  it("emits one chronological line per snapshot with from/to and cause", () => {
    const lifecycles: Record<string, RowLifecycle[]> = {
      "work-study": buildRowLifecycles("work-study", [
        entry({ id: "ws-1", status: "pending", timestamp: ts(0) }),
        entry({ id: "ws-1", status: "running", step: "updating", timestamp: ts(1) }),
        entry({ id: "ws-1", status: "done", step: "updating", timestamp: ts(2) }),
      ]),
    };
    const trail = buildTransitionTrail(lifecycles);
    assert.equal(trail.length, 3);
    assert.equal(trail[0]?.from, null);
    assert.equal(trail[0]?.cause, "create");
    assert.equal(trail[1]?.from?.status, "pending");
    assert.equal(trail[1]?.to.status, "running");
    assert.ok(trail[0]!.ts <= trail[1]!.ts && trail[1]!.ts <= trail[2]!.ts);
  });
});

describe("runRowLifecycleDebugSweep", () => {
  it("writes the per-row detail json and the transition trail jsonl", () => {
    __resetParseCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "row-lifecycle-"));
    const date = dateLocal();
    const lines = [
      entry({ id: "ws-1", status: "pending", timestamp: ts(0) }),
      entry({ id: "ws-1", status: "running", step: "updating", timestamp: ts(1) }),
      entry({ id: "ws-1", status: "done", step: "updating", timestamp: ts(2) }),
    ];
    writeFileSync(
      join(dir, `work-study-${date}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    runRowLifecycleDebugSweep(dir);

    const detail = JSON.parse(
      readFileSync(join(dir, "debug", `row-lifecycle-${date}.json`), "utf8"),
    ) as { workflows: Record<string, RowLifecycle[]> };
    assert.equal(detail.workflows["work-study"]?.length, 1);
    assert.equal(detail.workflows["work-study"]?.[0]?.history.length, 3);

    const trail = readFileSync(join(dir, "debug", `row-lifecycle-${date}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(trail.length, 3);
    assert.equal(trail[0]?.cause, "create");
  });
});
