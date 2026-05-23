import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  isApprovedPrepRow,
  isDiscardedPrepRow,
  isResolvedPrepRow,
} from "../../../../src/dashboard/components/ocr/types.js";

describe("isApprovedPrepRow", () => {
  it("returns true for prep rows with status=done step=approved", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns true for legacy approved ocr-prep parent rows without carried data", () => {
    assert.equal(
      isApprovedPrepRow({
        id: "ocr-prep-session-1",
        status: "done",
        step: "approved",
        data: { fannedOutCount: "1" },
      }),
      true,
    );
  });

  it("returns false when not a prep row", () => {
    assert.equal(
      isApprovedPrepRow({ status: "done", step: "approved", data: {} }),
      false,
    );
  });

  it("returns true for approved OCR rows so they can render as approval delegations", () => {
    assert.equal(
      isApprovedPrepRow({
        workflow: "ocr",
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns false for in-flight prep rows", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "running",
        step: "ocr",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns false for failed-discarded prep rows", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "failed",
        step: "discarded",
        data: { mode: "prepare" },
      }),
      false,
    );
  });
});

describe("isDiscardedPrepRow", () => {
  it("returns true for prep rows with status=failed step=discarded", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "discarded",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns true for discarded OCR rows without carried data", () => {
    assert.equal(
      isDiscardedPrepRow({
        workflow: "ocr",
        status: "failed",
        step: "discarded",
        data: {},
      }),
      true,
    );
  });

  it("returns false when not a prep row", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "discarded",
        data: {},
      }),
      false,
    );
  });

  it("returns false for approved prep rows", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns false for genuinely-failed (non-discarded) prep rows", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "ocr",
        data: { mode: "prepare" },
      }),
      false,
    );
  });
});

describe("isResolvedPrepRow", () => {
  it("returns true for approved prep rows", () => {
    assert.equal(
      isResolvedPrepRow({
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns false for approved OCR rows so the approval delegation remains visible", () => {
    assert.equal(
      isResolvedPrepRow({
        workflow: "ocr",
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns true for discarded prep rows", () => {
    assert.equal(
      isResolvedPrepRow({
        status: "failed",
        step: "discarded",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns false for in-flight prep rows", () => {
    assert.equal(
      isResolvedPrepRow({
        status: "running",
        step: "ocr",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns false when not a prep row", () => {
    assert.equal(
      isResolvedPrepRow({
        status: "done",
        step: "approved",
        data: {},
      }),
      false,
    );
  });
});
