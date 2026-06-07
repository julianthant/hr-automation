import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildFailuresHandler,
  type FailuresDeps,
} from "../../../src/tracker/dashboard.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

function entry(p: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "separations",
    timestamp: "2026-04-28T10:00:00.000Z",
    id: "DOC-1",
    runId: "DOC-1#1",
    status: "done",
    data: {},
    ...p,
  };
}

function makeDeps(
  bucket: Record<string, Record<string, TrackerEntry[]>>,
): FailuresDeps {
  return {
    listWorkflows: () => Object.keys(bucket),
    readEntriesForDate: (wf, date) => bucket[wf]?.[date] ?? [],
  };
}

describe("buildFailuresHandler", () => {
  it("returns failures for the given date across all workflows, newest first", () => {
    const bucket = {
      separations: {
        "2026-04-28": [
          entry({
            id: "A",
            status: "failed",
            error: "Kuali down",
            timestamp: "2026-04-28T10:00:00Z",
            data: { name: "Smith" },
          }),
        ],
      },
      onboarding: {
        "2026-04-28": [
          entry({
            workflow: "onboarding",
            id: "x@ucsd.edu",
            status: "failed",
            error: "Duo timeout",
            timestamp: "2026-04-28T11:00:00Z",
            data: { firstName: "X", lastName: "Y" },
          }),
        ],
      },
    };
    const rows = buildFailuresHandler(makeDeps(bucket))({ date: "2026-04-28" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].workflow, "onboarding");  // 11:00 newer
    assert.equal(rows[1].workflow, "separations"); // 10:00
    assert.equal(rows[1].error, "Kuali down");
    // Row title resolves from the entry's subject data (legacy fallback path).
    assert.equal(rows[0].title, "X Y");
    assert.equal(rows[1].title, "Smith");
  });

  it("surfaces the kind-based row title + trace code, and omits an id-only title", () => {
    const bucket = {
      ocr: {
        "2026-04-28": [
          entry({
            workflow: "ocr",
            id: "DOC-9",
            runId: "DOC-9#1",
            status: "failed",
            error: "Dashboard restarted",
            timestamp: "2026-04-28T10:00:00Z",
            data: { queueRowKind: "file", pdfOriginalName: "I9_Doe.pdf", __traceId: "oc-100000-doc9" },
          }),
          entry({
            workflow: "ocr",
            id: "DOC-bare",
            runId: "DOC-bare#1",
            status: "failed",
            error: "boom",
            timestamp: "2026-04-28T09:00:00Z",
            data: {},
          }),
        ],
      },
    };
    const rows = buildFailuresHandler(makeDeps(bucket))({ date: "2026-04-28" });
    const doc9 = rows.find((r) => r.id === "DOC-9")!;
    const bare = rows.find((r) => r.id === "DOC-bare")!;
    assert.equal(doc9.title, "I9_Doe.pdf"); // file kind → PDF filename
    assert.equal(doc9.traceId, "oc-100000-doc9");
    assert.equal(bare.title, ""); // only the id is known → empty, never the UUID
    assert.equal(bare.traceId, undefined); // no __traceId stamped
  });

  it("filters retries: latest run for an id wins", () => {
    const bucket = {
      separations: {
        "2026-04-28": [
          entry({
            id: "B",
            runId: "B#1",
            status: "failed",
            error: "first try",
            timestamp: "2026-04-28T09:00:00Z",
          }),
          entry({
            id: "B",
            runId: "B#2",
            status: "done",
            timestamp: "2026-04-28T10:00:00Z",
          }),
        ],
      },
    };
    const rows = buildFailuresHandler(makeDeps(bucket))({ date: "2026-04-28" });
    assert.equal(rows.length, 0); // latest run for B is done
  });

  it("returns empty for a date with no entries", () => {
    const rows = buildFailuresHandler(makeDeps({}))({ date: "2026-04-28" });
    assert.deepEqual(rows, []);
  });

  it("includes the runId in each row", () => {
    const bucket = {
      separations: {
        "2026-04-28": [
          entry({
            id: "C",
            runId: "C#3",
            status: "failed",
            error: "boom",
            timestamp: "2026-04-28T10:00:00Z",
          }),
        ],
      },
    };
    const rows = buildFailuresHandler(makeDeps(bucket))({ date: "2026-04-28" });
    assert.equal(rows[0].runId, "C#3");
  });

  it("respects the limit parameter (cap at 50 by default)", () => {
    const entries = Array.from({ length: 75 }).map((_, i) =>
      entry({
        id: `id-${i}`,
        runId: `id-${i}#1`,
        status: "failed",
        error: "boom",
        timestamp: `2026-04-28T10:00:${String(i).padStart(2, "0")}Z`,
      }),
    );
    const rows = buildFailuresHandler(
      makeDeps({ separations: { "2026-04-28": entries } }),
    )({ date: "2026-04-28" });
    assert.equal(rows.length, 50);
  });
});
