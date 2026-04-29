import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchHandler,
  buildSearchSummary,
  type SearchDeps,
} from "../../../src/tracker/dashboard.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";

/** Build a quick TrackerEntry fixture — defaults cover the common shape. */
function entry(partial: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "onboarding",
    timestamp: "2026-04-15T10:00:00.000Z",
    id: "x@ucsd.edu",
    runId: "x@ucsd.edu#1",
    status: "done",
    data: {},
    ...partial,
  };
}

/**
 * In-memory deps — keyed by workflow → date → entries. The search handler
 * walks workflows × dates via these callbacks, so the fixture doubles as
 * the date-range filter check.
 */
function makeDeps(
  bucket: Record<string, Record<string, TrackerEntry[]>>,
): SearchDeps {
  return {
    listWorkflows: () => Object.keys(bucket),
    listDates: (wf) => Object.keys(bucket[wf] ?? {}).sort().reverse(),
    readEntriesForDate: (wf, date) => bucket[wf]?.[date] ?? [],
  };
}

describe("buildSearchHandler", () => {
  it("returns [] for an empty query", () => {
    const handler = buildSearchHandler(makeDeps({}));
    assert.deepEqual(handler(""), []);
    assert.deepEqual(handler("   "), []);
  });

  it("matches against id, runId, emplId, email, docId, and name fields (case-insensitive)", () => {
    const bucket = {
      onboarding: {
        "2026-04-15": [
          entry({
            id: "jane@ucsd.edu",
            data: { firstName: "Jane", lastName: "Smith", email: "jane@ucsd.edu" },
          }),
        ],
        "2026-04-14": [
          entry({
            id: "bob@ucsd.edu",
            timestamp: "2026-04-14T10:00:00.000Z",
            data: { emplId: "EMP-99887", firstName: "Bob" },
          }),
        ],
      },
      separations: {
        "2026-04-15": [
          entry({
            workflow: "separations",
            id: "DOC-123",
            timestamp: "2026-04-15T11:00:00.000Z",
            data: { docId: "DOC-123", name: "Alice Smith" },
          }),
        ],
      },
    };
    const handler = buildSearchHandler(makeDeps(bucket));

    // Name match across workflows
    const smithResults = handler("smith");
    assert.equal(smithResults.length, 2);
    assert.ok(smithResults.some((r) => r.id === "jane@ucsd.edu"));
    assert.ok(smithResults.some((r) => r.id === "DOC-123"));

    // emplId match
    const empResults = handler("EMP-998");
    assert.equal(empResults.length, 1);
    assert.equal(empResults[0].id, "bob@ucsd.edu");

    // docId match
    const docResults = handler("doc-123");
    assert.equal(docResults.length, 1);
    assert.equal(docResults[0].id, "DOC-123");

    // id (email) match — case-insensitive
    const emailResults = handler("JANE@UCSD");
    assert.equal(emailResults.length, 1);
    assert.equal(emailResults[0].id, "jane@ucsd.edu");
  });

  it("sorts results by lastTs desc", () => {
    const bucket = {
      onboarding: {
        "2026-04-15": [
          entry({ id: "a@ucsd.edu", timestamp: "2026-04-15T09:00:00.000Z", data: { name: "Alice" } }),
          entry({ id: "b@ucsd.edu", timestamp: "2026-04-15T12:00:00.000Z", data: { name: "Alice" } }),
          entry({ id: "c@ucsd.edu", timestamp: "2026-04-15T10:30:00.000Z", data: { name: "Alice" } }),
        ],
      },
    };
    const rows = buildSearchHandler(makeDeps(bucket))("alice");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, "b@ucsd.edu"); // 12:00
    assert.equal(rows[1].id, "c@ucsd.edu"); // 10:30
    assert.equal(rows[2].id, "a@ucsd.edu"); // 09:00
  });

  it("respects the limit parameter", () => {
    const entries = Array.from({ length: 12 }).map((_, i) =>
      entry({
        id: `u${i}@ucsd.edu`,
        timestamp: `2026-04-15T10:00:${String(i).padStart(2, "0")}.000Z`,
        data: { name: "Alice" },
      }),
    );
    const handler = buildSearchHandler(makeDeps({ onboarding: { "2026-04-15": entries } }));
    const rows = handler("alice", { limit: 5 });
    assert.equal(rows.length, 5);
    // Newest-first ordering
    assert.equal(rows[0].id, "u11@ucsd.edu");
  });

  it("filters to a single workflow when workflow= is passed", () => {
    const bucket = {
      onboarding: {
        "2026-04-15": [entry({ id: "a@ucsd.edu", data: { name: "Shared" } })],
      },
      separations: {
        "2026-04-15": [entry({ workflow: "separations", id: "DOC-1", data: { name: "Shared" } })],
      },
    };
    const handler = buildSearchHandler(makeDeps(bucket));
    const rows = handler("shared", { workflow: "separations" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workflow, "separations");
  });

  it("aggregates multiple status rows for the same runId into one (keeps latest)", () => {
    // JSONL is append-only — a single run emits pending, running, done. The
    // search handler should collapse them into a single row with the final
    // status.
    const bucket = {
      onboarding: {
        "2026-04-15": [
          entry({ id: "jane@ucsd.edu", status: "pending", timestamp: "2026-04-15T09:00:00.000Z", data: { name: "Jane" } }),
          entry({ id: "jane@ucsd.edu", status: "running", timestamp: "2026-04-15T09:01:00.000Z", data: { name: "Jane" } }),
          entry({ id: "jane@ucsd.edu", status: "done", timestamp: "2026-04-15T09:02:00.000Z", data: { name: "Jane" } }),
        ],
      },
    };
    const rows = buildSearchHandler(makeDeps(bucket))("jane");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "done");
    assert.equal(rows[0].lastTs, "2026-04-15T09:02:00.000Z");
  });

  it("collapses retries for the same id into one row showing the latest run", () => {
    // Two runs for the same id (a failed #1, then a successful retry #2).
    // The dropdown should show one row per id, reflecting the latest run's
    // runId + status — duplicates per-doc clutter the dropdown otherwise.
    const bucket = {
      onboarding: {
        "2026-04-15": [
          entry({ id: "jane@ucsd.edu", runId: "jane@ucsd.edu#1", status: "failed", timestamp: "2026-04-15T09:00:00.000Z", data: { name: "Jane" } }),
          entry({ id: "jane@ucsd.edu", runId: "jane@ucsd.edu#2", status: "done", timestamp: "2026-04-15T09:30:00.000Z", data: { name: "Jane" } }),
        ],
      },
    };
    const rows = buildSearchHandler(makeDeps(bucket))("jane");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, "jane@ucsd.edu#2");
    assert.equal(rows[0].status, "done");
    assert.equal(rows[0].lastTs, "2026-04-15T09:30:00.000Z");
  });

  it("respects the days window (excludes older dates)", () => {
    // Use a synthetic "today" via real today's date so we can be sure the
    // cutoff math works against today's calendar. We pick a date 40 days ago
    // which should always be excluded under the default 30-day window.
    const today = new Date();
    const older = new Date();
    older.setDate(older.getDate() - 40);
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);

    const toDate = (d: Date) => dateLocal(d);
    const toIso = (d: Date) => d.toISOString();

    const bucket = {
      onboarding: {
        [toDate(today)]: [
          entry({ id: "today@ucsd.edu", timestamp: toIso(today), data: { name: "Shared" } }),
        ],
        [toDate(recent)]: [
          entry({ id: "recent@ucsd.edu", timestamp: toIso(recent), data: { name: "Shared" } }),
        ],
        [toDate(older)]: [
          entry({ id: "old@ucsd.edu", timestamp: toIso(older), data: { name: "Shared" } }),
        ],
      },
    };
    const rows = buildSearchHandler(makeDeps(bucket))("shared", { days: 30 });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("today@ucsd.edu"));
    assert.ok(ids.includes("recent@ucsd.edu"));
    assert.ok(!ids.includes("old@ucsd.edu"));
  });

  it("includes the date field so the UI can deep-link to that day's tracker", () => {
    const bucket = {
      onboarding: {
        "2026-04-15": [entry({ id: "jane@ucsd.edu", data: { name: "Jane" } })],
      },
    };
    const rows = buildSearchHandler(makeDeps(bucket))("jane");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-04-15");
  });
});

describe("buildSearchSummary", () => {
  it("prefers __name then name then first+last then id", () => {
    assert.equal(
      buildSearchSummary({
        workflow: "onboarding",
        timestamp: "",
        id: "jane@ucsd.edu",
        status: "done",
        data: { __name: "Jane Smith", firstName: "Jane" },
      }),
      "Jane Smith",
    );
    assert.equal(
      buildSearchSummary({
        workflow: "onboarding",
        timestamp: "",
        id: "jane@ucsd.edu",
        status: "done",
        data: { name: "Jane Smith" },
      }),
      "Jane Smith",
    );
    assert.equal(
      buildSearchSummary({
        workflow: "onboarding",
        timestamp: "",
        id: "jane@ucsd.edu",
        status: "done",
        data: { firstName: "Jane", lastName: "Smith" },
      }),
      "Jane Smith",
    );
  });

  it("falls back to docId / email / emplId before id", () => {
    assert.equal(
      buildSearchSummary({
        workflow: "separations",
        timestamp: "",
        id: "DOC-1",
        status: "done",
        data: { docId: "DOC-99" },
      }),
      "DOC-99",
    );
    assert.equal(
      buildSearchSummary({
        workflow: "onboarding",
        timestamp: "",
        id: "abc",
        status: "done",
        data: { email: "jane@ucsd.edu" },
      }),
      "jane@ucsd.edu",
    );
    assert.equal(
      buildSearchSummary({
        workflow: "onboarding",
        timestamp: "",
        id: "abc",
        status: "done",
        data: {},
      }),
      "abc",
    );
  });
});
