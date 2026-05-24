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
import { emitInheritedRow } from "../../../src/control/ops/emit-inherited.js";
import { emitDashboardCancelTrackerRow } from "../../../src/control/ops/shared.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "emit-inherited-db-hint-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("emitInheritedRow — SQLite db hint plumbing (Finding #13)", () => {
  it("forwards `db` to findLatestEntryForPredicate when provided", () => {
    const stores = openControlStores(tmp);
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");

    emitInheritedRow({
      workflow: "work-study",
      trackerDir: tmp,
      id: "9999",
      runId: "some-run",
      status: "failed",
      step: "cancelled",
      fallbackArchetype: "single",
      db: stores.taskStore.db,
    });

    assert.equal(spy.mock.calls.length, 1, "findLatestEntryForPredicate called once");
    const opts = spy.mock.calls[0][0];
    assert.ok(opts.db, "db handle threaded through");
    assert.equal(opts.runId, "some-run", "runId hint passed for indexed lookup");
  });

  it("omits `db` when caller does not pass it (single-row path)", () => {
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");

    emitInheritedRow({
      workflow: "work-study",
      trackerDir: tmp,
      id: "9999",
      runId: "some-run",
      status: "failed",
      step: "cancelled",
      fallbackArchetype: "single",
    });

    assert.equal(spy.mock.calls.length, 1);
    const opts = spy.mock.calls[0][0];
    assert.equal(opts.db, undefined, "db omitted when not threaded");
  });

  it("emitDashboardCancelTrackerRow forwards db to emitInheritedRow's prior-row lookup", () => {
    const stores = openControlStores(tmp);
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");

    emitDashboardCancelTrackerRow("work-study", "8888", "run-abc", tmp, stores.taskStore.db);

    // emitDashboardCancelTrackerRow internally calls findLatestEntryForPredicate
    // TWICE: once via emitInheritedRow (which gets the db hint), and once via
    // resolveInstanceForRunId (a separate workflowInstance lookup, no db). The
    // first invocation is the one we care about — it's the prior-row lookup
    // that bulk cancel would hit O(K*D*L) times.
    assert.ok(spy.mock.calls.length >= 1, "called at least once");
    const inheritedLookup = spy.mock.calls.find((c) => c[0].runId === "run-abc" && c[0].itemId === undefined && c[0].lookbackDays === 30);
    // Find the prior-row lookup by its lookbackDays === 30 (emit-inherited.ts)
    // vs lookbackDays === 2 (resolveInstanceForRunId).
    const priorRowLookup = spy.mock.calls.find((c) => c[0].lookbackDays === 30);
    assert.ok(priorRowLookup, "emit-inherited prior-row lookup happened");
    assert.ok(priorRowLookup[0].db, "db propagated through emitDashboardCancelTrackerRow into prior-row lookup");
    assert.equal(priorRowLookup[0].runId, "run-abc");
    // Silence unused warning for the unused alias above.
    void inheritedLookup;
  });

  it("emitDashboardCancelTrackerRow without db leaves the JSONL fallback path open", () => {
    const spy = vi.spyOn(findLatest, "findLatestEntryForPredicate");

    emitDashboardCancelTrackerRow("work-study", "7777", "run-xyz", tmp);

    const priorRowLookup = spy.mock.calls.find((c) => c[0].lookbackDays === 30);
    assert.ok(priorRowLookup, "emit-inherited prior-row lookup happened");
    assert.equal(priorRowLookup[0].db, undefined, "no db hint when caller omits it");
  });
});
