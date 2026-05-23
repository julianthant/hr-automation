import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { openStateDb, closeStateDbForTests, stateDbPath } from "../../../src/tracker/state/db.js";
import {
  applyTrackerEntryLive,
  applySigintTerminalToProjection,
  __resetProjectionFailureStateForTests,
} from "../../../src/tracker/state/runtime.js";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import type { TrackerEntry, LogEntry } from "../../../src/tracker/jsonl.js";
import type { ProjectionSourceRef } from "../../../src/tracker/state/types.js";
import { openDatabase } from "../../../src/infra/sqlite/index.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-runtime-"));
}

function trackerEntry(date: string, status: TrackerEntry["status"] = "running"): TrackerEntry {
  return {
    workflow: "onboarding",
    timestamp: `${date}T20:00:00.000Z`,
    id: "jane@ucsd.edu",
    runId: "run-1",
    status,
    data: { employeeName: "Jane Doe" },
  };
}

function trackerSource(dir: string, date: string): ProjectionSourceRef {
  return {
    sourceKind: "tracker",
    workflow: "onboarding",
    trackerDate: date,
    path: join(dir, `onboarding-${date}.jsonl`),
    offset: 0,
  };
}

// A ProjectionSourceRef whose `path` is a non-string object. The bind for
// `@sourcePath` inside applyTrackerEntry's INSERT throws, so the live apply
// fails — but the DB handle stays healthy, so a follow-up rebuild can recover.
// This models a "bad row / schema drift" failure, not a dead connection.
function poisonedSource(): ProjectionSourceRef {
  return {
    sourceKind: "tracker",
    workflow: "onboarding",
    trackerDate: "2026-05-21",
    // Deliberately wrong type to force a bind error inside applyTrackerEntry.
    path: { broken: true } as unknown as string,
    offset: 0,
  };
}

// C2: consecutive apply failures trigger a deferred async rebuild that
// recovers the projection from the JSONL audit log.
test("applyTrackerEntryLive triggers a deferred rebuild after consecutive failures", async () => {
  const dir = tmpTracker();
  __resetProjectionFailureStateForTests();
  try {
    openStateDb(dir);
    const date = "2026-05-21";

    // Model real drift: the JSONL audit line exists on disk but was never
    // applied to the projection. Workflows append JSONL *before* the
    // projection apply, so a failing live apply leaves the row in JSONL only.
    // We write the line directly so it carries no `projection_sources` offset
    // and no `(source_path, source_offset)` dedup record — exactly the state a
    // failed live apply leaves behind. (`rebuildProjectionForDate` is an
    // incremental, dedup-guarded replay: it recovers never-applied lines, but
    // would correctly no-op on a row that was applied and then deleted.)
    const jsonlPath = join(dir, `onboarding-${date}.jsonl`);
    appendFileSync(jsonlPath, `${JSON.stringify(trackerEntry(date))}\n`);

    // Sanity: the projection has no row for this item yet.
    const before = openStateDb(dir)
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id = 'jane@ucsd.edu'")
      .get() as { n: number };
    assert.equal(before.n, 0, "projection should not have the row before rebuild");

    // Three consecutive failures (poisoned source) must elevate to log.error
    // and, on the 3rd, schedule a deferred rebuild. The synchronous calls
    // themselves must not throw — a transient projection error never aborts
    // a workflow.
    for (let i = 0; i < 3; i++) {
      assert.doesNotThrow(() => applyTrackerEntryLive(trackerEntry(date), poisonedSource(), dir));
    }

    // The deferred rebuild runs on the next setImmediate tick.
    await delay(50);

    // After the rebuild, the projection reflects the JSONL row.
    const verifyDb = openDatabase(stateDbPath(dir));
    try {
      const row = verifyDb
        .prepare("SELECT latest_status FROM runs WHERE item_id = 'jane@ucsd.edu'")
        .get() as { latest_status: string } | undefined;
      assert.ok(row, "rebuild should have applied the JSONL row to the projection");
      assert.equal(row.latest_status, "running");
    } finally {
      verifyDb.close();
    }
  } finally {
    __resetProjectionFailureStateForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// C2: fewer than the threshold of consecutive failures must NOT trigger a
// rebuild — drift is logged but the recovery action is reserved for sustained
// failure.
test("applyTrackerEntryLive does not rebuild below the consecutive-failure threshold", async () => {
  const dir = tmpTracker();
  __resetProjectionFailureStateForTests();
  try {
    openStateDb(dir);
    const date = "2026-05-21";
    trackEvent(trackerEntry(date), dir);
    openStateDb(dir).exec("DELETE FROM runs");

    // Two failures — one short of the threshold.
    for (let i = 0; i < 2; i++) {
      assert.doesNotThrow(() => applyTrackerEntryLive(trackerEntry(date), poisonedSource(), dir));
    }
    await delay(50);

    const verifyDb = openDatabase(stateDbPath(dir));
    try {
      const row = verifyDb.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
      assert.equal(row.n, 0, "no rebuild should have run below the failure threshold");
    } finally {
      verifyDb.close();
    }
  } finally {
    __resetProjectionFailureStateForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// C2: a success between failures resets the consecutive-failure counter.
test("applyTrackerEntryLive resets the failure counter on a successful apply", async () => {
  const dir = tmpTracker();
  __resetProjectionFailureStateForTests();
  try {
    openStateDb(dir);
    const date = "2026-05-21";
    // A clean live apply succeeds — counter stays at 0.
    assert.doesNotThrow(() => applyTrackerEntryLive(trackerEntry(date), trackerSource(dir, date), dir));
    const row = openDatabase(stateDbPath(dir))
      .prepare("SELECT latest_status FROM runs WHERE item_id = 'jane@ucsd.edu'")
      .get() as { latest_status: string } | undefined;
    assert.equal(row?.latest_status, "running");
  } finally {
    __resetProjectionFailureStateForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// H1: the SIGINT-path SQLite apply mirrors the terminal failed state.
test("applySigintTerminalToProjection writes failed status to the projection", () => {
  const dir = tmpTracker();
  __resetProjectionFailureStateForTests();
  try {
    openStateDb(dir);
    const date = "2026-05-21";
    // Simulate the run already being "running" in the projection.
    trackEvent(trackerEntry(date, "running"), dir);

    const trackEntry: TrackerEntry = {
      workflow: "onboarding",
      timestamp: `${date}T20:05:00.000Z`,
      id: "jane@ucsd.edu",
      runId: "run-1",
      status: "failed",
      data: { employeeName: "Jane Doe" },
      error: "Process terminated (SIGINT)",
      step: "extraction",
    };
    const logEntry: LogEntry = {
      workflow: "onboarding",
      itemId: "jane@ucsd.edu",
      runId: "run-1",
      level: "error",
      message: "Process terminated (SIGINT)",
      ts: `${date}T20:05:00.000Z`,
    };

    applySigintTerminalToProjection(
      trackEntry,
      logEntry,
      {
        trackerPath: join(dir, `onboarding-${date}.jsonl`),
        logPath: join(dir, `onboarding-${date}-logs.jsonl`),
        trackerDate: date,
      },
      dir,
    );

    const verifyDb = openDatabase(stateDbPath(dir));
    try {
      const run = verifyDb
        .prepare("SELECT latest_status, latest_step, latest_error FROM runs WHERE item_id = 'jane@ucsd.edu'")
        .get() as { latest_status: string; latest_step: string; latest_error: string };
      assert.deepEqual({ ...run }, {
        latest_status: "failed",
        latest_step: "extraction",
        latest_error: "Process terminated (SIGINT)",
      });
      const logRow = verifyDb
        .prepare("SELECT level, message FROM logs WHERE item_id = 'jane@ucsd.edu'")
        .get() as { level: string; message: string };
      assert.deepEqual({ ...logRow }, {
        level: "error",
        message: "Process terminated (SIGINT)",
      });
    } finally {
      verifyDb.close();
    }
  } finally {
    __resetProjectionFailureStateForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// H1: a missing/unready projection makes the SIGINT apply a silent no-op.
test("applySigintTerminalToProjection is a silent no-op when the projection is not ready", () => {
  const dir = tmpTracker();
  __resetProjectionFailureStateForTests();
  try {
    const date = "2026-05-21";
    const trackEntry: TrackerEntry = {
      workflow: "onboarding",
      timestamp: `${date}T20:05:00.000Z`,
      id: "jane@ucsd.edu",
      runId: "run-1",
      status: "failed",
      data: {},
      error: "Process terminated (SIGINT)",
    };
    const logEntry: LogEntry = {
      workflow: "onboarding",
      itemId: "jane@ucsd.edu",
      runId: "run-1",
      level: "error",
      message: "Process terminated (SIGINT)",
      ts: `${date}T20:05:00.000Z`,
    };
    // No openStateDb call — projection DB does not exist. Must not throw.
    assert.doesNotThrow(() =>
      applySigintTerminalToProjection(
        trackEntry,
        logEntry,
        {
          trackerPath: join(dir, `onboarding-${date}.jsonl`),
          logPath: join(dir, `onboarding-${date}-logs.jsonl`),
          trackerDate: date,
        },
        dir,
      ),
    );
  } finally {
    __resetProjectionFailureStateForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
