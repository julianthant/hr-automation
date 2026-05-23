import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  derivePreviewApprovalGate,
  type PreviewPageStatus,
} from "../../../src/dashboard/components/ocr/preview-gate.js";

describe("derivePreviewApprovalGate", () => {
  it("hides approval until every required source page preview has loaded", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2],
      previewStatusByPage: {
        1: "ok",
        2: "loading",
      },
      selectedCount: 2,
    });

    assert.equal(gate.approveVisible, false);
    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Review source preview/);
    assert.deepEqual(gate.pendingPages, [2]);
  });

  it("blocks approval with an actionable error when a source preview fails", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2],
      previewStatusByPage: {
        1: "ok",
        2: "error",
      },
      selectedCount: 1,
    });

    assert.equal(gate.approveVisible, false);
    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Preview failed for page 2/);
    assert.deepEqual(gate.failedPages, [2]);
  });

  it("shows approval only after preview pages are loaded and at least one record is selected", () => {
    const previewStatusByPage: Record<number, PreviewPageStatus> = {
      1: "ok",
      2: "ok",
    };

    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2],
      previewStatusByPage,
      selectedCount: 1,
    });

    assert.equal(gate.approveVisible, true);
    assert.equal(gate.blocked, false);
    assert.equal(gate.reason, "");
  });

  // Case (a): selectedCount=0 → blocked even when all pages are "ok"
  it("blocks approval when no records are selected (selectedCount=0)", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2],
      previewStatusByPage: { 1: "ok", 2: "ok" },
      selectedCount: 0,
    });

    assert.equal(gate.approveVisible, false);
    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Select at least one/);
  });

  // Case (a): negative selectedCount is also treated as no selection
  it("blocks approval when selectedCount is negative", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1],
      previewStatusByPage: { 1: "ok" },
      selectedCount: -1,
    });

    assert.equal(gate.approveVisible, false);
    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Select at least one/);
  });

  // Case (b): requiredPages=[] with selectedCount>0 → blocked, "Source preview is not available"
  it("blocks approval when requiredPages is empty (source preview not available)", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [],
      previewStatusByPage: {},
      selectedCount: 1,
    });

    assert.equal(gate.approveVisible, false);
    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Source preview is not available/);
    assert.equal(gate.totalCount, 0);
    assert.deepEqual(gate.pendingPages, []);
    assert.deepEqual(gate.failedPages, []);
  });

  // Case (d): multiple pending pages → reason shows loaded/total count
  it("includes loaded/total count in reason when pages are still loading", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2, 3],
      previewStatusByPage: { 1: "ok", 2: "loading", 3: "loading" },
      selectedCount: 1,
    });

    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /1\/3 page/);
    assert.deepEqual(gate.pendingPages, [2, 3]);
    assert.equal(gate.loadedCount, 1);
    assert.equal(gate.totalCount, 3);
  });

  // Case (c): multiple failed pages → reason lists page numbers
  it("lists all failed page numbers in the reason string", () => {
    const gate = derivePreviewApprovalGate({
      requiredPages: [1, 2, 3],
      previewStatusByPage: { 1: "error", 2: "ok", 3: "error" },
      selectedCount: 2,
    });

    assert.equal(gate.blocked, true);
    assert.match(gate.reason, /Preview failed for page/);
    assert.deepEqual(gate.failedPages, [1, 3]);
  });
});
