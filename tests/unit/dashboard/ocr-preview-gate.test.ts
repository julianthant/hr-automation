import { describe, it } from "node:test";
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
});
