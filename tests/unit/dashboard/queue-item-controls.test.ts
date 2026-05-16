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
  it("routes OCR prep proxy rows to discard-prepare with the OCR session body", () => {
    assert.deepEqual(
      buildQueueCancelRequest({
        workflow: "oath-upload",
        id: "oath-parent",
        runId: "parent-run",
        entry: prepEntry(),
      }),
      {
        path: "/api/ocr/discard-prepare",
        body: {
          sessionId: "ocr-session",
          runId: "ocr-run",
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
