import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildOcrReviewSnapshotData,
  emitOcrReviewSnapshot,
} from "../../../../src/services/ocr/review-snapshot.js";
import type { TrackerRowEmission } from "../../../../src/tracker/jsonl.js";

// BM-5: the OCR preview-row re-emit envelope (mode:"prepare"/archetype:"preview"/
// __id/__name/parentSubject + records) was hand-rolled in 4 re-fan paths. These
// pin the canonical re-stamp set the shared helper produces.

describe("buildOcrReviewSnapshotData", () => {
  it("applies the canonical re-stamp set over the base data", () => {
    const data = buildOcrReviewSnapshotData({
      base: { formType: "verify", pdfOriginalName: "mixed.pdf", archetype: "single" /* must lose */ },
      sessionId: "sess-1",
      records: [{ name: "Doe, Jane" }],
      parent: { parentSubject: "mixed.pdf", parentRunId: "op-1" },
    });
    assert.equal(data.mode, "prepare");
    assert.equal(data.archetype, "preview", "archetype is forced to preview, not the base value");
    assert.equal(data.__id, "sess-1");
    assert.equal(data.__name, "mixed.pdf");
    assert.equal(data.parentSubject, "mixed.pdf");
    assert.equal(data.formType, "verify", "base fields survive");
    assert.deepEqual(JSON.parse(data.records), [{ name: "Doe, Jane" }]);
  });

  it("falls back to __name=OCR when there is no parent subject", () => {
    const data = buildOcrReviewSnapshotData({
      base: {},
      sessionId: "sess-2",
      records: [],
    });
    assert.equal(data.__name, "OCR");
    assert.ok(!("parentSubject" in data), "no parentSubject key when none provided");
  });
});

describe("emitOcrReviewSnapshot", () => {
  it("emits an OCR row carrying the envelope + parentRunId + step/status", () => {
    const emitted: TrackerRowEmission[] = [];
    emitOcrReviewSnapshot({
      base: { formType: "verify" },
      sessionId: "sess-3",
      runId: "run-3",
      records: [{ a: 1 }],
      parent: { parentSubject: "doc.pdf", parentRunId: "op-3" },
      status: "running",
      step: "person-lookup",
      emit: (e) => emitted.push(e),
    });
    assert.equal(emitted.length, 1);
    const row = emitted[0]!;
    assert.equal(row.workflow, "ocr");
    assert.equal(row.id, "sess-3");
    assert.equal(row.runId, "run-3");
    assert.equal(row.parentRunId, "op-3");
    assert.equal(row.status, "running");
    assert.equal(row.step, "person-lookup");
    assert.equal(row.data.mode, "prepare");
    assert.equal(row.data.archetype, "preview");
  });

  it("threads a terminal error onto a failed row", () => {
    const emitted: TrackerRowEmission[] = [];
    emitOcrReviewSnapshot({
      base: {},
      sessionId: "sess-4",
      runId: "run-4",
      records: [],
      status: "failed",
      step: "person-lookup",
      error: "boom",
      emit: (e) => emitted.push(e),
    });
    assert.equal(emitted[0]!.error, "boom");
    assert.equal(emitted[0]!.status, "failed");
  });
});
