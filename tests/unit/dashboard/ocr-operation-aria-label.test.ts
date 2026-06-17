/**
 * ISS-001: OCR operation/review row aria-label must use the DERIVED status
 * label, not the raw `entry.status`.
 *
 * The operation coordinator row's header-button `aria-label` is composed as
 * `"<name> — <statusLabel>"`. When an operation coordinator is in the
 * awaiting-review state (OCR has finished but not yet been approved:
 * `data.ocrStatus === "awaiting-review"`, coordinator's own
 * `entry.status === "running"`), the status label must be the DERIVED label
 * ("awaiting review" from the `needsReview` config) — NOT the raw tracker
 * status ("running"). A screen-reader user would otherwise hear a different
 * state than sighted users see on the chip.
 *
 * The pure helper `resolveOperationStatusLabel` is extracted so it can be
 * tested without mounting the React component.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  resolveOperationStatusLabel,
} from "../../../src/dashboard/components/queue-panel/operation-row-variants.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";
import type { OperationOcrLink } from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";

const TS = "2026-06-17T10:00:00.000Z";

function coordinatorEntry(
  status: TrackerEntry["status"],
  step?: string,
): TrackerEntry {
  return {
    workflow: "oath-signature",
    id: "op-coord-1",
    runId: "op-run-1",
    status,
    step,
    timestamp: TS,
    data: {
      archetype: "operation",
      queueRowKind: "file",
      pdfOriginalName: "multiple-oath.pdf",
    },
  } as TrackerEntry;
}

function ocrLink(status: string, step?: string): OperationOcrLink {
  return { runId: "ocr-run-1", sessionId: "sess-1", status, step };
}

// ---------------------------------------------------------------------------
// ISS-001: awaiting-review state must NOT say "running"
// ---------------------------------------------------------------------------

describe("ISS-001: resolveOperationStatusLabel — awaiting-review state", () => {
  test("returns 'awaiting review' (not 'running') when ocr.status is awaiting-review", () => {
    const entry = coordinatorEntry("running", "ocr-prep");
    const ocr = ocrLink("awaiting-review", "awaiting-approval");

    const label = resolveOperationStatusLabel(entry, ocr);

    assert.notEqual(
      label,
      "running",
      "aria-label must NOT say 'running' when OCR is in awaiting-review — that mirrors the raw tracker status, not the derived chip",
    );
    assert.equal(
      label,
      "awaiting review",
      "aria-label must say 'awaiting review' to match the visible chip",
    );
  });

  test("falls back to raw status label when ocr is absent", () => {
    const entry = coordinatorEntry("running");
    const label = resolveOperationStatusLabel(entry, undefined);
    // No OCR gate — coordinator is actively running, chip says "Running"
    assert.equal(label, "Running");
  });

  test("falls back to raw status label when ocr.status is 'running' (OCR still preparing)", () => {
    const entry = coordinatorEntry("running");
    const ocr = ocrLink("running");
    const label = resolveOperationStatusLabel(entry, ocr);
    // OCR not yet in review — coordinator chip says "Running"
    assert.equal(label, "Running");
  });

  test("returns 'Done' when coordinator is done (post-approval complete)", () => {
    const entry = coordinatorEntry("done", "done");
    const ocr = ocrLink("approved", "approved");
    const label = resolveOperationStatusLabel(entry, ocr);
    assert.equal(label, "Done");
  });

  test("returns 'Failed' when coordinator is failed", () => {
    const entry = coordinatorEntry("failed");
    const ocr = ocrLink("discarded");
    const label = resolveOperationStatusLabel(entry, ocr);
    assert.equal(label, "Failed");
  });

  test("returns 'Cancelled' when coordinator is failed+step=cancelled", () => {
    const entry = coordinatorEntry("failed", "cancelled");
    const label = resolveOperationStatusLabel(entry, undefined);
    assert.equal(label, "Cancelled");
  });
});
