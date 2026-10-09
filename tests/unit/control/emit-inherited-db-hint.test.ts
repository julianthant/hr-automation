/**
 * Finding #13 — SQLite db hint plumbed through emitInheritedRow.
 *
 * Bulk cancel/retry/discard call this helper per row. Without `db`, each
 * call performs a 30-day JSONL lookback scan (O(K*D*L)). With `db`, the
 * lookup goes through the indexed `runs.run_id` projection (O(log N)).
 *
 * The fast path itself is implemented + tested at `tracker/find-latest-entry.ts`;
 * this test pins the contract that callers actually thread `db` through.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { openControlStores } from "../../../src/control/ops/shared.js";
import * as findLatest from "../../../src/tracker/find-latest-entry.js";
import { findLatestEntryForPredicate } from "../../../src/tracker/find-latest-entry.js";
import {
  emitInheritedRow,
  PriorTrackerRowNotFoundError,
} from "../../../src/control/ops/emit-inherited.js";
import { emitDashboardCancelTrackerRow } from "../../../src/control/ops/shared.js";
import { trackEvent, type TrackerEntry } from "../../../src/tracker/jsonl.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "emit-inherited-db-hint-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function priorEntry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "work-study",
    id: "9999",
    runId: "some-run",
    status: "running",
    timestamp: new Date().toISOString(),
    data: { archetype: "single" },
    ...overrides,
  };
}

describe("emitInheritedRow — prior row required", () => {
  it("throws PriorTrackerRowNotFoundError when no prior row exists", () => {
    assert.throws(
      () =>
        emitInheritedRow({
          workflow: "work-study",
          trackerDir: tmp,
          id: "9999",
          runId: "some-run",
          status: "failed",
          step: "cancelled",
        }),
      (err: unknown) => err instanceof PriorTrackerRowNotFoundError,
    );
  });
});

describe("emitInheritedRow — SQLite db hint plumbing (Finding #13)", () => {
  it("forwards `db` to findLatestEntryForPredicate when provided", () => {
    const stores = openControlStores(tmp);
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate").mockReturnValue(priorEntry());

    emitInheritedRow({
      workflow: "work-study",
      trackerDir: tmp,
      id: "9999",
      runId: "some-run",
      status: "failed",
      step: "cancelled",
      db: stores.taskStore.db,
    });

    assert.equal(spy.mock.calls.length, 1, "findLatestEntryForPredicate called once");
    const opts = spy.mock.calls[0][0];
    assert.ok(opts.db, "db handle threaded through");
    assert.equal(opts.runId, "some-run", "runId hint passed for indexed lookup");
  });

  it("omits `db` when caller does not pass it (single-row path)", () => {
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate").mockReturnValue(priorEntry());

    emitInheritedRow({
      workflow: "work-study",
      trackerDir: tmp,
      id: "9999",
      runId: "some-run",
      status: "failed",
      step: "cancelled",
    });

    assert.equal(spy.mock.calls.length, 1);
    const opts = spy.mock.calls[0][0];
    assert.equal(opts.db, undefined, "db omitted when not threaded");
  });

  it("emitDashboardCancelTrackerRow forwards db to emitInheritedRow's prior-row lookup", () => {
    const stores = openControlStores(tmp);
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");
    spy.mockReturnValue(priorEntry({ id: "8888", runId: "run-abc" }));

    emitDashboardCancelTrackerRow("work-study", "8888", "run-abc", tmp, stores.taskStore.db);

    assert.ok(spy.mock.calls.length >= 1, "called at least once");
    const priorRowLookup = spy.mock.calls.find((c) => c[0].lookbackDays === 30);
    assert.ok(priorRowLookup, "emit-inherited prior-row lookup happened");
    assert.ok(priorRowLookup[0].db, "db propagated through emitDashboardCancelTrackerRow into prior-row lookup");
    assert.equal(priorRowLookup[0].runId, "run-abc");
  });

  it("emitDashboardCancelTrackerRow without db leaves the JSONL fallback path open", () => {
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");
    spy.mockReturnValue(priorEntry({ id: "7777", runId: "run-xyz" }));

    emitDashboardCancelTrackerRow("work-study", "7777", "run-xyz", tmp);

    const priorRowLookup = spy.mock.calls.find((c) => c[0].lookbackDays === 30);
    assert.ok(priorRowLookup, "emit-inherited prior-row lookup happened");
    assert.equal(priorRowLookup[0].db, undefined, "no db hint when caller omits it");
  });
});

describe("emitDashboardCancelTrackerRow — preserves batch-member parent linkage (separation cancel-all regression)", () => {
  it("cancel row inherits parentRunId through the db fast path so the operation anchor survives", () => {
    // Repro: a multi-id separation input run stamps batch-member rows under a
    // synthetic operation anchor (shared parentRunId). Bulk cancel passes `db`, so
    // the prior-row lookup hits the SQLite projection. The emitted cancel row
    // MUST keep parentRunId — otherwise every member orphans out of the
    // (synthetic) anchor and surfaces as a standalone row.
    const stores = openControlStores(tmp);
    trackEvent({
      workflow: "separations",
      timestamp: new Date().toISOString(),
      id: "4131",
      runId: "member-run",
      parentRunId: "batch-anchor-1",
      status: "pending",
      data: { archetype: "operation-member" },
    }, tmp);

    emitDashboardCancelTrackerRow("separations", "4131", "member-run", tmp, stores.taskStore.db);

    // Read the actually-written cancel row from JSONL (no db) — the audit row
    // the dashboard's latest-wins queue read consumes.
    const cancelled = findLatestEntryForPredicate({
      workflow: "separations",
      trackerDir: tmp,
      lookbackDays: 1,
      predicate: (e) => e.runId === "member-run" && e.status === "failed",
    });

    assert.equal(cancelled?.parentRunId, "batch-anchor-1", "cancel row keeps parentRunId");
    assert.equal(cancelled?.data?.archetype, "operation-member", "cancel row keeps batch-member archetype");
    assert.equal(cancelled?.step, "cancelled");
  });
});
