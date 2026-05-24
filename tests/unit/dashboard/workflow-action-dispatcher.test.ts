import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildBulkWorkflowActionRequest,
  buildWorkflowActionRequest,
} from "../../../src/dashboard/components/hooks/useWorkflowActionDispatcher.js";
import type { WorkflowActionDescriptor } from "../../../src/domain/workflow-runtime/types.js";

const treeCancelAction: WorkflowActionDescriptor = {
  kind: "cancel",
  scope: "tree",
  source: "queue-panel",
  label: "Cancel workflow tree",
  targets: [{ workflowId: "oath-upload", id: "oath-parent", runId: "parent-run" }],
  enabled: true,
};

describe("buildWorkflowActionRequest", () => {
  it("builds retry row requests from resolved targets and parent batch context", () => {
    assert.deepEqual(
      buildWorkflowActionRequest({
        transport: "retry",
        kind: "retry",
        action: {
          kind: "retry",
          scope: "row",
          source: "queue-panel",
          label: "Retry",
          targets: [{ workflowId: "eid-lookup", id: "employee-id", runId: "run-2", date: "2026-05-21" }],
          enabled: true,
        },
        fallbackTarget: { workflowId: "ignored", id: "ignored", runId: "ignored", date: "ignored" },
        parentRunId: "batch-parent",
      }),
      {
        path: "/api/retry",
        body: {
          workflow: "eid-lookup",
          id: "employee-id",
          runId: "run-2",
          date: "2026-05-21",
          parentRunId: "batch-parent",
        },
      },
    );
  });

  it("builds delete-entry requests from fallback target data when descriptors are absent", () => {
    assert.deepEqual(
      buildWorkflowActionRequest({
        transport: "delete-entry",
        kind: "delete",
        fallbackTarget: {
          workflowId: "onboarding",
          id: "person@example.edu",
          runId: "run-1",
          date: "2026-05-20",
        },
      }),
      {
        path: "/api/delete-entry",
        body: {
          workflow: "onboarding",
          id: "person@example.edu",
          runId: "run-1",
          date: "2026-05-20",
        },
      },
    );
  });

  it("carries descriptor cancel scope on cancel-queued row requests", () => {
    // Contract 5: cancel-queued is the single cancel transport now; the
    // legacy force-stop transport collapsed into it because the kernel's
    // per-run AbortController + Page proxy makes cancel propagate into
    // in-flight Playwright work within ms.
    assert.deepEqual(
      buildWorkflowActionRequest({
        transport: "cancel-queued",
        kind: "cancel",
        action: treeCancelAction,
        fallbackTarget: { workflowId: "oath-upload", id: "oath-parent", runId: "parent-run" },
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

  it("carries OCR discard context on central cancel requests", () => {
    assert.deepEqual(
      buildWorkflowActionRequest({
        transport: "cancel-queued",
        kind: "cancel",
        fallbackTarget: { workflowId: "oath-upload", id: "oath-parent", runId: "ocr-run" },
        parentRunId: "parent-run",
        ocrSessionId: "ocr-session",
        parentWorkflow: "oath-upload",
        parentItemId: "oath-parent",
        formType: "oath-signature",
        reason: "Cancelled from oath-upload queue",
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "oath-upload",
          id: "oath-parent",
          runId: "ocr-run",
          ocrSessionId: "ocr-session",
          parentWorkflow: "oath-upload",
          parentRunId: "parent-run",
          parentItemId: "oath-parent",
          formType: "oath-signature",
          reason: "Cancelled from oath-upload queue",
        },
      },
    );
  });
});

describe("buildBulkWorkflowActionRequest", () => {
  it("builds batch-view visible-view retry requests with per-target workflow ids", () => {
    assert.deepEqual(
      buildBulkWorkflowActionRequest({
        transport: "retry-bulk",
        kind: "retry",
        workflow: "oath-upload",
        date: "2026-05-21",
        parentRunId: "batch-parent",
        action: {
          kind: "retry",
          scope: "group",
          source: "queue-panel",
          label: "Retry",
          targets: [],
          enabled: true,
        },
        source: "batch-view",
        scope: "visible-view",
        items: [
          { workflowId: "eid-lookup", id: "employee-id", runId: "eid-run" },
          { workflowId: "active-check", id: "employee-id", runId: "active-run" },
        ],
      }),
      {
        path: "/api/retry-bulk",
        body: {
          workflow: "oath-upload",
          date: "2026-05-21",
          parentRunId: "batch-parent",
          source: "batch-view",
          scope: "visible-view",
          items: [
            { workflowId: "eid-lookup", id: "employee-id", runId: "eid-run" },
            { workflowId: "active-check", id: "employee-id", runId: "active-run" },
          ],
        },
      },
    );
  });

  it("builds batch-view visible-view delete requests with per-target workflow ids", () => {
    assert.deepEqual(
      buildBulkWorkflowActionRequest({
        transport: "delete-bulk",
        kind: "delete",
        workflow: "oath-upload",
        date: "2026-05-21",
        source: "batch-view",
        scope: "visible-view",
        items: [
          { workflowId: "oath-signature", id: "10000001", runId: "signature-run" },
        ],
      }),
      {
        path: "/api/delete-bulk",
        body: {
          workflow: "oath-upload",
          date: "2026-05-21",
          source: "batch-view",
          scope: "visible-view",
          items: [
            { workflowId: "oath-signature", id: "10000001", runId: "signature-run" },
          ],
        },
      },
    );
  });
});
