import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isApprovedPrepRow,
  isDiscardedPrepRow,
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

  it("returns false when not a prep row", () => {
    assert.equal(
      isApprovedPrepRow({ status: "done", step: "approved", data: {} }),
      false,
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
