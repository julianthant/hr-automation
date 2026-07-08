import { test } from "vitest";
import assert from "node:assert/strict";

import { deriveLogPanelFooterRunLabel } from "../../../src/dashboard/components/log-panel/LogPanel.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "emergency-contact",
    timestamp: "2026-06-06T18:00:00.000Z",
    id: "item-1",
    runId: "run-1",
    status: "done",
    data: { archetype: "single", queueRowKind: "person" },
    ...overrides,
  } as TrackerEntry;
}

test("shows trace id even when EID is present", () => {
  const e = entry({
    runOrdinal: 1,
    data: {
      archetype: "single",
      queueRowKind: "person",
      eid: "10884790",
      __traceId: "ec-150044-0d3f",
    },
  });
  assert.equal(deriveLogPanelFooterRunLabel(e), "ec-150044-0d3f-1");
});

test("shows trace id for a person row without EID", () => {
  const e = entry({
    runOrdinal: 2,
    data: { archetype: "single", queueRowKind: "person", __traceId: "ec-143012-a3f1" },
  });
  assert.equal(deriveLogPanelFooterRunLabel(e), "ec-143012-a3f1-2");
});

test("shows trace id for a file row", () => {
  const e = entry({
    runOrdinal: 1,
    workflow: "ocr",
    data: {
      archetype: "preview",
      queueRowKind: "file",
      pdfOriginalName: "packet.pdf",
      __traceId: "oc-091530-b2c4",
    },
  });
  assert.equal(deriveLogPanelFooterRunLabel(e), "oc-091530-b2c4-1");
});

test("returns empty when no trace id is stamped", () => {
  const e = entry({ data: { archetype: "single", eid: "10884790" } });
  assert.equal(deriveLogPanelFooterRunLabel(e), "");
});
