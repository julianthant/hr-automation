import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreviewInboxHandler,
  type PreviewInboxDeps,
} from "../../../src/tracker/dashboard.js";
import { type TrackerEntry } from "../../../src/tracker/jsonl.js";

// Use today's local date so entries fall within the handler's 7-day window.
const TODAY = new Date();
const TODAY_DATE = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, "0")}-${String(TODAY.getDate()).padStart(2, "0")}`;
const todayAt = (hour: number, minute = 0): string =>
  new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), hour, minute, 0, 0).toISOString();

function entry(partial: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "emergency-contact",
    timestamp: todayAt(10),
    id: "ec-prep-abc-1",
    runId: "ec-prep-abc-1#1",
    status: "running",
    data: { mode: "prepare", pdfOriginalName: "batch.pdf" },
    ...partial,
  };
}

function makeDeps(
  bucket: Record<string, Record<string, TrackerEntry[]>>,
): PreviewInboxDeps {
  return {
    listWorkflows: () => Object.keys(bucket),
    listDates: (wf) => Object.keys(bucket[wf] ?? {}).sort().reverse(),
    readEntriesForDate: (wf, date) => bucket[wf]?.[date] ?? [],
  };
}

describe("buildPreviewInboxHandler", () => {
  it("returns rows for prep entries whose latest entry is done and not approved/discarded", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "p01-A",
            runId: "p01-A#1",
            status: "running",
            step: "ocr",
            timestamp: todayAt(10),
          }),
          entry({
            id: "p01-A",
            runId: "p01-A#1",
            status: "done",
            timestamp: todayAt(10, 5),
            data: { mode: "prepare", pdfOriginalName: "batch.pdf" },
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workflow, "emergency-contact");
    assert.equal(rows[0].id, "p01-A");
    assert.equal(rows[0].summary, "batch.pdf");
    assert.equal(rows[0].ts, todayAt(10, 5));
  });

  it("excludes rows whose latest entry is in-progress (running / pending)", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "p01-B",
            runId: "p01-B#1",
            status: "running",
            step: "matching",
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 0);
  });

  it("excludes rows whose latest entry is approved or discarded", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "p01-C",
            runId: "p01-C#1",
            status: "done",
            timestamp: todayAt(10),
          }),
          entry({
            id: "p01-C",
            runId: "p01-C#1",
            status: "done",
            step: "approved",
            timestamp: todayAt(10, 10),
          }),
          entry({
            id: "p01-D",
            runId: "p01-D#1",
            status: "done",
            timestamp: todayAt(10),
          }),
          entry({
            id: "p01-D",
            runId: "p01-D#1",
            status: "failed",
            step: "discarded",
            timestamp: todayAt(10, 15),
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 0);
  });

  it("excludes failed prep rows", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "p01-E",
            runId: "p01-E#1",
            status: "failed",
            error: "OCR failed",
            timestamp: todayAt(10, 5),
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 0);
  });

  it("ignores entries that are not preview rows (no data.mode === prepare)", () => {
    const bucket = {
      separations: {
        TODAY_DATE: [
          {
            workflow: "separations",
            timestamp: todayAt(10),
            id: "DOC-1",
            runId: "DOC-1#1",
            status: "done",
            data: { name: "Smith" },
          } as TrackerEntry,
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 0);
  });

  it("collects prep rows from any workflow", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "ec-1",
            runId: "ec-1#1",
            status: "done",
            timestamp: todayAt(10),
          }),
        ],
      },
      "oath-signature": {
        TODAY_DATE: [
          entry({
            workflow: "oath-signature",
            id: "oath-1",
            runId: "oath-1#1",
            status: "done",
            timestamp: todayAt(11),
            data: { mode: "prepare", pdfOriginalName: "oath.pdf" },
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 2);
    // Newest first
    assert.equal(rows[0].workflow, "oath-signature");
    assert.equal(rows[1].workflow, "emergency-contact");
  });

  it("scans the last 7 days only", () => {
    // Create dates relative to today so the window check works regardless of run date.
    const today = new Date();
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const toDate = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const bucket = {
      "emergency-contact": {
        [toDate(today)]: [
          entry({
            id: "today",
            runId: "today#1",
            status: "done",
            timestamp: today.toISOString(),
          }),
        ],
        [toDate(threeDaysAgo)]: [
          entry({
            id: "recent",
            runId: "recent#1",
            status: "done",
            timestamp: threeDaysAgo.toISOString(),
          }),
        ],
        [toDate(tenDaysAgo)]: [
          entry({
            id: "old",
            runId: "old#1",
            status: "done",
            timestamp: tenDaysAgo.toISOString(),
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("today"));
    assert.ok(ids.includes("recent"));
    assert.ok(!ids.includes("old"));
  });

  it("includes recordCount when data.records is present", () => {
    const bucket = {
      "emergency-contact": {
        TODAY_DATE: [
          entry({
            id: "with-count",
            runId: "with-count#1",
            status: "done",
            timestamp: todayAt(10),
            data: {
              mode: "prepare",
              pdfOriginalName: "batch.pdf",
              records: JSON.stringify([{ x: 1 }, { x: 2 }, { x: 3 }]),
            },
          }),
        ],
      },
    };
    const rows = buildPreviewInboxHandler(makeDeps(bucket))();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recordCount, 3);
  });
});
