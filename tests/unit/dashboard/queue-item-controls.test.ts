import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQueueCancelRequest } from "../../../src/dashboard/components/queue-panel/QueueItemControls.js";
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

describe("buildQueueCancelRequest", () => {
  it("carries policy-declared cancel scope for ordinary queued rows", () => {
    assert.deepEqual(
      buildQueueCancelRequest({
        workflow: "oath-upload",
        id: "oath-parent",
        runId: "parent-run",
        actions: [{
          kind: "cancel",
          scope: "tree",
          source: "queue-panel",
          label: "Cancel workflow tree",
          targets: [{ workflowId: "oath-upload", id: "oath-parent", runId: "parent-run" }],
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

  it("routes OCR prep proxy rows through central cancel with the OCR session context", () => {
    assert.deepEqual(
      buildQueueCancelRequest({
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
      buildQueueCancelRequest({ workflow: "onboarding", id: "a@b.edu", runId: "a@b.edu#1" }),
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
