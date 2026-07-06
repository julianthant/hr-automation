/**
 * Unit tests for src/control/actions/resolve-targets.ts.
 *
 * `resolveActionTargets` decides the BLAST RADIUS of a cancel/retry/delete
 * action before any low-level handler runs. Per the file's header comment,
 * the safety invariant is: `row` / `group` / `visible-view` never expand
 * beyond the caller-provided targets (pure passthrough — `visible-view` in
 * particular must never reach hidden rows), and `tree` walks the SQLite
 * `runs.parent_run_id` chain to add descendants but DEGRADES TO VERBATIM
 * (never throws, never expands) when the projection DB is unavailable.
 *
 * Strategy: real `openStateDb` + `applyTrackerEntry` to build actual
 * `runs` rows (same pattern as tests/unit/tracker/state-projector.test.ts),
 * so the BFS walk exercises real SQLite rather than a mock.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveActionTargets } from "../../../src/control/actions/resolve-targets.js";
import type { WorkflowActionRequest } from "../../../src/control/actions/types.js";
import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { applyTrackerEntry } from "../../../src/tracker/state/apply.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl-io.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "resolve-targets-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  rmSync(tmp, { recursive: true, force: true });
});

let sourceLine = 0;
function insertRun(opts: {
  workflow: string;
  id: string;
  runId: string;
  parentRunId?: string;
  status: TrackerEntry["status"];
  trackerDate?: string;
}): void {
  const db = openStateDb(tmp);
  const entry: TrackerEntry = {
    workflow: opts.workflow,
    timestamp: "2026-07-01T12:00:00.000Z",
    id: opts.id,
    runId: opts.runId,
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    status: opts.status,
    data: { archetype: "single" },
  };
  applyTrackerEntry(db, entry, {
    sourceKind: "tracker",
    path: `fake-${opts.workflow}.jsonl`,
    line: sourceLine++,
    offset: 0,
    trackerDate: opts.trackerDate ?? "2026-07-01",
  });
}

function baseRequest(overrides: Partial<WorkflowActionRequest> = {}): WorkflowActionRequest {
  return {
    action: "cancel",
    scope: "row",
    source: "queue-panel",
    workflowId: "oath-signature",
    targets: [{ workflowId: "oath-signature", id: "coord-1", runId: "run-root" }],
    ...overrides,
  };
}

describe("resolveActionTargets — request-level guard", () => {
  it("rejects an empty targets array", () => {
    const result = resolveActionTargets(baseRequest({ targets: [] }), tmp);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no targets provided/);
  });
});

describe("resolveActionTargets — verbatim scopes never expand (row/group/visible-view)", () => {
  for (const scope of ["row", "group", "visible-view"] as const) {
    it(`scope=${scope} returns exactly the caller-provided targets, even with live descendants in SQLite`, () => {
      // Seed a real parent→child chain in the projection DB. If any of these
      // scopes accidentally walked it, the result would include "child-1".
      insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
      insertRun({
        workflow: "oath-signature",
        id: "child-1",
        runId: "run-child-1",
        parentRunId: "run-root",
        status: "pending",
      });

      const result = resolveActionTargets(baseRequest({ scope }), tmp);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.targets.length, 1, `scope=${scope} must be a pure passthrough`);
      assert.equal(result.targets[0]?.id, "coord-1");
    });
  }

  it("resolves date/status/runId from the request-level defaults + per-target overrides", () => {
    const req = baseRequest({
      scope: "row",
      date: "2026-07-01",
      targets: [
        { workflowId: "oath-signature", id: "row-a", runId: "run-a", status: "running" },
        { workflowId: "onbase", id: "row-b" }, // no runId/status/date — inherits req.date only
      ],
    });
    const result = resolveActionTargets(req, tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets[0], {
      workflow: "oath-signature",
      id: "row-a",
      runId: "run-a",
      date: "2026-07-01",
      status: "running",
    });
    assert.deepEqual(result.targets[1], {
      workflow: "onbase",
      id: "row-b",
      date: "2026-07-01",
    });
  });

  it("a per-target date overrides the request-level default date", () => {
    const req = baseRequest({
      scope: "row",
      date: "2026-07-01",
      targets: [{ workflowId: "oath-signature", id: "row-a", date: "2026-06-15" }],
    });
    const result = resolveActionTargets(req, tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.targets[0]?.date, "2026-06-15");
  });

  it("falls back to req.workflowId when a target omits workflowId", () => {
    const req = baseRequest({
      scope: "row",
      workflowId: "work-study",
      targets: [{ workflowId: "", id: "row-a" }],
    });
    const result = resolveActionTargets(req, tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.targets[0]?.workflow, "work-study");
  });
});

describe("resolveActionTargets — scope: tree (descendant walk)", () => {
  it("includes the root plus every non-terminal descendant", () => {
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-1",
      runId: "run-child-1",
      parentRunId: "run-root",
      status: "pending",
    });
    insertRun({
      workflow: "oath-signature",
      id: "child-2",
      runId: "run-child-2",
      parentRunId: "run-root",
      status: "running",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.targets.map((t) => t.id).sort();
    assert.deepEqual(ids, ["child-1", "child-2", "coord-1"]);
  });

  it("excludes the root when treeExcludeRoots is set (operation coordinator 'cancel remaining')", () => {
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-1",
      runId: "run-child-1",
      parentRunId: "run-root",
      status: "pending",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree", treeExcludeRoots: true }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets.map((t) => t.id), ["child-1"]);
  });

  it("walks multiple generations (grandchildren)", () => {
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-1",
      runId: "run-child-1",
      parentRunId: "run-root",
      status: "done", // terminal parent — still walked for its own children
    });
    insertRun({
      workflow: "oath-signature",
      id: "grandchild-1",
      runId: "run-grandchild-1",
      parentRunId: "run-child-1",
      status: "pending",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.targets.map((t) => t.id).sort();
    // child-1 is terminal (done) so it is skipped as a target, but the walk
    // still enqueues its children — grandchild-1 must surface.
    assert.deepEqual(ids, ["coord-1", "grandchild-1"]);
  });

  it("skips terminal descendants (done/failed/skipped) but keeps their non-terminal children", () => {
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-done",
      runId: "run-child-done",
      parentRunId: "run-root",
      status: "done",
    });
    insertRun({
      workflow: "oath-signature",
      id: "child-failed",
      runId: "run-child-failed",
      parentRunId: "run-root",
      status: "failed",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets.map((t) => t.id), ["coord-1"], "terminal descendants must not become targets");
  });

  it("never expands beyond descendants of the caller's OWN roots (blast-radius containment)", () => {
    // A sibling coordinator's subtree must never leak into this cancel, even
    // though it shares the same workflow and is present in the same DB.
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-1",
      runId: "run-child-1",
      parentRunId: "run-root",
      status: "pending",
    });
    insertRun({ workflow: "oath-signature", id: "coord-2", runId: "run-root-2", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "unrelated-child",
      runId: "run-unrelated-child",
      parentRunId: "run-root-2",
      status: "pending",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp); // only run-root as caller target
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.targets.map((t) => t.id).sort();
    assert.deepEqual(ids, ["child-1", "coord-1"]);
    assert.ok(!ids.includes("coord-2"), "sibling coordinator must not leak in");
    assert.ok(!ids.includes("unrelated-child"), "sibling's descendant must not leak in");
  });

  it("degrades to the verbatim target set when the projection DB does not exist (never throws, never expands)", () => {
    // No openStateDb / applyTrackerEntry call in this test — the state DB file
    // was never created for this tmp dir, so isStateDbReady(dir) is false.
    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets.map((t) => t.id), ["coord-1"], "must degrade to the caller-provided root only");
  });

  it("dedupes a descendant reachable by more than one BFS path (diamond) without duplicating it", () => {
    // run-root has two children that BOTH claim run-grandchild as their child
    // (e.g. re-parented mid-flight) — collectDescendants keys by
    // workflow/id/runId, so it must appear once.
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-a",
      runId: "run-child-a",
      parentRunId: "run-root",
      status: "pending",
    });
    insertRun({
      workflow: "oath-signature",
      id: "child-b",
      runId: "run-child-b",
      parentRunId: "run-root",
      status: "pending",
    });
    insertRun({
      workflow: "oath-signature",
      id: "grandchild-shared",
      runId: "run-grandchild-shared",
      parentRunId: "run-child-a",
      status: "pending",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.targets.map((t) => t.id);
    assert.equal(
      ids.filter((id) => id === "grandchild-shared").length,
      1,
      "each distinct descendant target must appear exactly once",
    );
  });

  it("treats a running descendant's status as 'running' and a pending one as 'pending'", () => {
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-running",
      runId: "run-child-running",
      parentRunId: "run-root",
      status: "running",
    });
    insertRun({
      workflow: "oath-signature",
      id: "child-pending",
      runId: "run-child-pending",
      parentRunId: "run-root",
      status: "pending",
    });

    const result = resolveActionTargets(baseRequest({ scope: "tree" }), tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byId = new Map(result.targets.map((t) => [t.id, t.status]));
    assert.equal(byId.get("child-running"), "running");
    assert.equal(byId.get("child-pending"), "pending");
  });

  it("returns only the caller's roots (no descendants) when none of the caller's targets carry a runId", () => {
    const req: WorkflowActionRequest = {
      action: "cancel",
      scope: "tree",
      source: "queue-panel",
      workflowId: "oath-signature",
      targets: [{ workflowId: "oath-signature", id: "coord-1" }], // no runId — can't seed the BFS
    };
    insertRun({ workflow: "oath-signature", id: "coord-1", runId: "run-root", status: "running" });
    insertRun({
      workflow: "oath-signature",
      id: "child-1",
      runId: "run-child-1",
      parentRunId: "run-root",
      status: "pending",
    });

    const result = resolveActionTargets(req, tmp);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets.map((t) => t.id), ["coord-1"]);
  });
});
