import { test } from "vitest";
import assert from "node:assert/strict";

import { deriveQueueRowTypeLabel } from "../../../src/dashboard/components/log-panel/LogPanel.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function ocrPrep(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "ocr",
    timestamp: "2026-05-19T18:00:00.000Z",
    id: "ocr-session-1",
    runId: "ocr-run-1",
    // New approval contract (2026-05-25): awaiting-approval is status="running".
    status: "running",
    step: "awaiting-approval",
    data: {
      archetype: "batch-parent",
      mode: "prepare",
      formType: "oath",
      recordCount: "2",
      pdfOriginalName: "single.pdf",
    },
    ...overrides,
  } as TrackerEntry;
}

function eidChild(id: string, parentRunId: string): TrackerEntry {
  return {
    workflow: "eid-lookup",
    timestamp: "2026-05-19T18:01:00.000Z",
    id,
    runId: `${id}#1`,
    parentRunId,
    status: "done",
    data: {
      archetype: "passive-child",
      emplId: id,
    },
  } as TrackerEntry;
}

test("OCR prep row type uses file count, not record/EID child count", () => {
  const prep = ocrPrep();
  const children = [eidChild("10424984", "ocr-run-1"), eidChild("10423301", "ocr-run-1")];

  assert.equal(
    deriveQueueRowTypeLabel(prep, children, [prep, ...children], true),
    "Single delegation · Preview",
  );
});

test("OCR prep row type becomes batch only when multiple OCR file prep rows share a parent batch", () => {
  const first = ocrPrep({
    id: "ocr-session-1",
    runId: "ocr-run-1",
    parentRunId: "oath-batch-run",
  });
  const second = ocrPrep({
    id: "ocr-session-2",
    runId: "ocr-run-2",
    parentRunId: "oath-batch-run",
  });

  assert.equal(
    deriveQueueRowTypeLabel(first, [], [first, second], true),
    "Batch delegation · Preview",
  );
});

test("OCR EID lookup child remains a delegation member projection", () => {
  const child = {
    workflow: "eid-lookup",
    timestamp: "2026-05-19T18:01:00.000Z",
    id: "ocr-oath-run-r0",
    runId: "eid-run-1",
    parentRunId: "ocr-run-1",
    status: "done",
    data: {
      archetype: "delegate-child",
      originWorkflow: "ocr",
      searchName: "Doe, Jane",
      emplId: "10000001",
    },
  } as TrackerEntry;

  assert.equal(
    deriveQueueRowTypeLabel(child, [], [child], false),
    "Delegation member",
  );
});
