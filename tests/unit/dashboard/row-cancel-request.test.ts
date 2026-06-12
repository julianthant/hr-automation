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

  it("routes OCR prep proxy rows through central cancel with the OCR run identity", () => {
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
          // The discard handler resolves the prior tracker row by the OCR
          // run's identity — never the clicked (parent) row's.
          workflow: "ocr",
          id: "ocr-session",
          runId: "ocr-run",
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

  it("operation-row discard overrides the descriptor target with the OCR run identity (E2E-013)", () => {
    const operationEntry: TrackerEntry = {
      workflow: "oath-signature",
      id: "ocr-prep-sess-1",
      runId: "operation-run",
      status: "running",
      step: "ocr-prep",
      timestamp: "2026-06-11T12:00:00.000Z",
      data: {
        archetype: "operation",
        mode: "prepare",
        ocrSessionId: "sess-1",
        ocrRunId: "ocr-run-1",
        ocrStatus: "awaiting-review",
        formType: "oath",
      },
    };
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "oath-signature",
        id: "ocr-prep-sess-1",
        runId: "operation-run",
        entry: operationEntry,
        actions: [{
          kind: "cancel",
          scope: "tree",
          source: "queue-panel",
          label: "Cancel workflow tree",
          // The descriptor targets the OPERATION row — the proxy must not let
          // this identity reach the discard handler.
          targets: [{ workflowId: "oath-signature", id: "ocr-prep-sess-1", runId: "operation-run", status: "running" }],
          enabled: true,
        }],
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "ocr",
          id: "sess-1",
          runId: "ocr-run-1",
          scope: "tree",
          ocrSessionId: "sess-1",
          reason: "Cancelled from oath-signature queue",
          parentWorkflow: "oath-signature",
          parentRunId: "operation-run",
          parentItemId: "ocr-prep-sess-1",
          formType: "oath",
        },
      },
    );
  });

  it("an approved operation row no longer routes through the discard proxy", () => {
    const approvedEntry: TrackerEntry = {
      workflow: "emergency-contact",
      id: "ocr-prep-sess-2",
      runId: "operation-run-2",
      status: "running",
      step: "approved",
      timestamp: "2026-06-11T12:00:00.000Z",
      data: {
        archetype: "operation",
        mode: "prepare",
        ocrSessionId: "sess-2",
        ocrRunId: "ocr-run-2",
        ocrStatus: "approved",
        formType: "emergency-contact",
      },
    };
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "emergency-contact",
        id: "ocr-prep-sess-2",
        runId: "operation-run-2",
        entry: approvedEntry,
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "emergency-contact",
          id: "ocr-prep-sess-2",
          runId: "operation-run-2",
          status: "running",
        },
      },
    );
  });

  it("OCR-panel proxy rows omit parent context so the server derives the real parent (E2E-012)", () => {
    const ocrEntry: TrackerEntry = {
      workflow: "ocr",
      id: "sess-3",
      runId: "ocr-run-3",
      status: "running",
      step: "awaiting-approval",
      timestamp: "2026-06-11T12:00:00.000Z",
      data: {
        mode: "prepare",
        ocrSessionId: "sess-3",
        ocrRunId: "ocr-run-3",
        formType: "oath",
      },
    };
    assert.deepEqual(
      buildRowCancelRequest({
        workflow: "ocr",
        id: "sess-3",
        runId: "ocr-run-3",
        entry: ocrEntry,
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "ocr",
          id: "sess-3",
          runId: "ocr-run-3",
          ocrSessionId: "sess-3",
          reason: "Cancelled from ocr queue",
          formType: "oath",
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
