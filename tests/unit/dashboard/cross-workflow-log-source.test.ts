/**
 * Regression test: cross-workflow log-source resolution.
 *
 * When a selected tracker entry belongs to a child workflow (e.g. an
 * active-check row surfacing inside an oath-upload queue), the dashboard
 * must route log fetches to the CHILD workflow's log file
 * (`active-check-<date>-logs.jsonl`), not the topbar workflow's file.
 *
 * The key invariant is:
 *   logSourceWorkflow = entry?.workflow ?? topbarWorkflow
 *
 * This file tests the pure derivation helpers that participate in that path:
 *  1. deriveTrackerFallbackLog preserves entry.workflow for cross-workflow entries.
 *  2. resolveLogSourceWorkflow (the pure extraction of LogPanel line 105) returns
 *     entry.workflow when the entry carries a different workflow than the topbar.
 *
 * We cannot import LogPanel (React) in Node tests, so we test the pure
 * expression inline and verify the result via the fallback log's workflow
 * field as a proxy.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { deriveTrackerFallbackLog } from "../../../src/dashboard/components/log-panel/log-fallback.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

/**
 * Pure extraction of the LogPanel logSourceWorkflow derivation (LogPanel.tsx line 105):
 *   const logSourceWorkflow = entry?.workflow ?? topbarWorkflow;
 *
 * This helper is trivial but extracting it as a named function makes the test
 * intent clear without needing a React environment.
 */
function resolveLogSourceWorkflow(
  entry: TrackerEntry | null,
  topbarWorkflow: string,
): string {
  return entry?.workflow ?? topbarWorkflow;
}

describe("cross-workflow log-source resolution", () => {
  it("uses the entry's own workflow when it differs from the topbar workflow", () => {
    const entry: TrackerEntry = {
      workflow: "active-check",
      id: "99999999",
      runId: "active-check-child#1",
      status: "done",
      timestamp: "2026-05-06T00:00:00.000Z",
    };

    const logSource = resolveLogSourceWorkflow(entry, "oath-upload");

    // Must use the child entry's workflow, not the topbar's.
    assert.equal(logSource, "active-check");
  });

  it("falls back to topbar workflow when entry is null (skeleton state)", () => {
    const logSource = resolveLogSourceWorkflow(null, "oath-upload");
    assert.equal(logSource, "oath-upload");
  });

  it("returns topbar workflow when entry.workflow is undefined (legacy rows without explicit workflow field)", () => {
    // Some older entries may lack a workflow field; the expression handles that.
    const entry = {
      id: "some-id",
      runId: "some-id#1",
      status: "done",
      timestamp: "2026-05-06T00:00:00.000Z",
    } as TrackerEntry; // cast — workflow omitted intentionally to simulate legacy row

    // Treat missing workflow as falsy → fall back to topbar.
    const logSource = resolveLogSourceWorkflow(entry, "onboarding");
    // entry.workflow is undefined; undefined ?? "onboarding" === "onboarding"
    assert.equal(logSource, "onboarding");
  });

  it("deriveTrackerFallbackLog preserves entry.workflow for cross-workflow child entries", () => {
    // When LogPanel calls deriveTrackerFallbackLog(entry, activeRunId) for a
    // cross-workflow child row, the fallback log must carry the child's
    // workflow so it renders correctly in the log stream.
    const childEntry: TrackerEntry = {
      workflow: "active-check",
      id: "99999999",
      runId: "active-check-child#1",
      status: "failed",
      step: "active-check",
      error: "employee not active",
      timestamp: "2026-05-06T00:00:01.000Z",
    };

    const fallback = deriveTrackerFallbackLog(childEntry, "active-check-child#1");

    assert.ok(fallback, "expected a non-null fallback log");
    assert.equal(
      fallback.workflow,
      "active-check",
      "fallback log must carry the child entry's workflow, not the topbar workflow",
    );
    assert.equal(fallback.itemId, "99999999");
    assert.equal(fallback.level, "error");
    assert.match(fallback.message, /employee not active/);
  });

  it("OCR child row surfacing in oath-upload queue uses correct log source", () => {
    // Concrete OCR scenario: an ocr entry appears in oath-upload queue.
    // The log source should be "ocr", reading from ocr-<date>-logs.jsonl.
    const ocrChildEntry: TrackerEntry = {
      workflow: "ocr",
      id: "prep-a3f1",
      runId: "prep-a3f1#1",
      parentRunId: "oath-upload-main#1",
      status: "done",
      timestamp: "2026-05-06T01:00:00.000Z",
    };

    const topbarWorkflow = "oath-upload";
    const logSource = resolveLogSourceWorkflow(ocrChildEntry, topbarWorkflow);

    assert.equal(
      logSource,
      "ocr",
      "OCR child row's log source must be 'ocr', not 'oath-upload'",
    );
  });
});
