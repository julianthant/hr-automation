import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildRowCancelRequest } from "../../../src/dashboard/lib/row-cancel-request.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function prepEntry(): TrackerEntry {
  return {
    workflow: "oath-upload",
    id: "oath-parent",
    runId: "parent-run",
    status: "pending",
    timestamp: "2026-05-15T12:00:00.000Z",
    data: {
      mode: "prepare",
      ocrSessionId: "ocr-session",
      ocrRunId: "ocr-run",
      formType: "oath-signature",
    },
  };
}

describe("buildRowCancelRequest", () => {
  it("carries policy-declared cancel scope for ordinary queued rows", () => {
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "oath-upload",
        id: "oath-parent",
        runId: "parent-run",
        actions: [{
          kind: "cancel",
          scope: "tree",
          source: "queue-panel",
          label: "Cancel workflow tree",
          targets: [{ workflowId: "oath-upload", id: "oath-parent", runId: "parent-run", status: "pending" }],
          enabled: true,
        }],
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "oath-upload",
          id: "oath-parent",
          runId: "parent-run",
          scope: "tree",
        },
      },
    );
  });

  it("forces the running handler with status:running for running rows", () => {
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "onboarding",
        id: "10012345",
        runId: "onboarding-run-1",
        actions: [{
          kind: "cancel",
          scope: "row",
          source: "queue-panel",
          label: "Cancel row",
          targets: [{ workflowId: "onboarding", id: "10012345", runId: "onboarding-run-1", status: "running" }],
          enabled: true,
        }],
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "onboarding",
          id: "10012345",
          runId: "onboarding-run-1",
          status: "running",
        },
      },
    );
  });

  it("routes OCR prep proxy rows through central cancel with the OCR session context", () => {
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "oath-upload",
        id: "oath-parent",
        runId: "parent-run",
        entry: prepEntry(),
      }),
      {
        path: "/api/cancel-queued",
        body: {
          runId: "ocr-run",
          workflow: "oath-upload",
          id: "oath-parent",
          ocrSessionId: "ocr-session",
          reason: "Cancelled from oath-upload queue",
          parentWorkflow: "oath-upload",
          parentRunId: "parent-run",
          parentItemId: "oath-parent",
          formType: "oath-signature",
        },
      },
    );
  });

  it("keeps ordinary queued rows on cancel-queued", () => {
    assert.deepEqual(
      buildRowCancelRequest({ workflow: "onboarding", id: "a@b.edu", runId: "a@b.edu#1" }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "onboarding",
          id: "a@b.edu",
          runId: "a@b.edu#1",
        },
      },
    );
  });
});
