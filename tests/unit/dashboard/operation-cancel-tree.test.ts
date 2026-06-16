/**
 * Pin: operation coordinator "Cancel remaining" fires a tree-scoped cancel at
 * /api/cancel-queued with the coordinator's own runId as the root. The
 * backend's `scope: "tree"` BFS (resolve-targets.ts `collectDescendants`)
 * then cancels every non-terminal child WITHOUT touching sibling operations.
 *
 * E2E-102
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildOperationTreeCancelRequest } from "../../../src/dashboard/lib/row-cancel-request.js";

describe("buildOperationTreeCancelRequest (E2E-102)", () => {
  it("builds a tree-scoped cancel targeting the coordinator runId", () => {
    assert.deepEqual(
      buildOperationTreeCancelRequest({
        workflow: "oath-signature",
        id: "ocr-session-1",
        runId: "coordinator-run-1",
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "oath-signature",
          id: "ocr-session-1",
          runId: "coordinator-run-1",
          scope: "tree",
        },
      },
    );
  });

  it("builds a tree-scoped cancel for emergency-contact coordinators", () => {
    assert.deepEqual(
      buildOperationTreeCancelRequest({
        workflow: "emergency-contact",
        id: "ec-session-2",
        runId: "ec-coord-run-2",
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "emergency-contact",
          id: "ec-session-2",
          runId: "ec-coord-run-2",
          scope: "tree",
        },
      },
    );
  });

  it("omits runId from the body when not provided", () => {
    assert.deepEqual(
      buildOperationTreeCancelRequest({
        workflow: "oath-signature",
        id: "ocr-session-3",
      }),
      {
        path: "/api/cancel-queued",
        body: {
          workflow: "oath-signature",
          id: "ocr-session-3",
          scope: "tree",
        },
      },
    );
  });
});
