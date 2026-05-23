import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildEditDataInitialValues,
  buildEditDataResetKey,
} from "../../../src/dashboard/components/log-panel/EditDataTab.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

const editableFields = [
  { key: "employeeName" },
  { key: "effectiveDate" },
];

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "separations",
    id: "doc-123",
    runId: "doc-123#1",
    status: "running",
    timestamp: "2026-05-15T12:00:00.000Z",
    data: {
      employeeName: "Original Name",
      effectiveDate: "2026-05-15",
    },
    ...overrides,
  };
}

describe("EditDataTab reset identity", () => {
  it("keeps the same reset key for fresh SSE entry objects with the same row identity", () => {
    const first = entry();
    const sseRefresh = entry({
      data: {
        employeeName: "Updated From SSE",
        effectiveDate: "2026-05-16",
      },
      lastLogTs: "2026-05-15T12:00:10.000Z",
    });

    assert.equal(
      buildEditDataResetKey(first, editableFields),
      buildEditDataResetKey(sseRefresh, editableFields),
    );
  });

  it("builds initial values only from editable fields", () => {
    assert.deepEqual(buildEditDataInitialValues(entry(), editableFields), {
      employeeName: "Original Name",
      effectiveDate: "2026-05-15",
    });
  });
});
