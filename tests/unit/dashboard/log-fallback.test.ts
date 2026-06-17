import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  deriveTrackerFallbackLog,
  describeTrackerPhase,
} from "../../../src/dashboard/components/log-panel/log-fallback.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

describe("describeTrackerPhase", () => {
  it("maps internal status/step codes to readable lifecycle phrases", () => {
    assert.equal(describeTrackerPhase("pending", undefined), "Queued");
    assert.equal(describeTrackerPhase("running", undefined), "Running…");
    assert.equal(describeTrackerPhase("running", "ocr-prep"), "Preparing OCR…");
    assert.equal(describeTrackerPhase("running", "awaiting-approval"), "Awaiting review");
    assert.equal(describeTrackerPhase("running", "loading-roster"), "Running: Loading roster");
    assert.equal(describeTrackerPhase("done", "approved"), "Done");
    assert.equal(describeTrackerPhase("skipped", "x"), "Skipped");
  });

  it("treats cancelled / discarded sentinels as operator actions, not failures", () => {
    assert.equal(describeTrackerPhase("failed", "cancelled"), "Cancelled");
    assert.equal(describeTrackerPhase("failed", "discarded"), "Discarded");
  });

  it("a genuine failure names the step it failed at", () => {
    assert.equal(describeTrackerPhase("failed", "person-lookup"), "Failed at Looking up person");
    assert.equal(describeTrackerPhase("failed", undefined), "Failed");
  });

  it("humanizes an unmapped kebab-case step instead of leaking the raw code", () => {
    assert.equal(describeTrackerPhase("running", "some-new-step"), "Running: Some new step");
  });
});

describe("deriveTrackerFallbackLog", () => {
  it("renders a readable phase (not a raw 'Tracker state' code) for a cancelled row", () => {
    const entry: TrackerEntry = {
      workflow: "active-check",
      timestamp: "2026-05-06T00:38:40.446Z",
      id: "99999999",
      runId: "run-cancelled",
      status: "failed",
      step: "cancelled",
      error: "cancelled by user from dashboard",
    };

    const fallback = deriveTrackerFallbackLog(entry, "run-cancelled");

    assert.ok(fallback);
    assert.equal(fallback.workflow, "active-check");
    assert.equal(fallback.itemId, "99999999");
    assert.equal(fallback.runId, "run-cancelled");
    assert.equal(fallback.level, "error");
    assert.equal(fallback.count, 1);
    assert.doesNotMatch(fallback.message, /Tracker state/);
    assert.match(fallback.message, /^Cancelled/);
    assert.match(fallback.message, /cancelled by user from dashboard/);
  });

  it("maps a running OCR-prep row to 'Preparing OCR…'", () => {
    const fallback = deriveTrackerFallbackLog(
      {
        workflow: "ocr",
        timestamp: "2026-06-17T10:00:00.000Z",
        id: "sess-1",
        runId: "r1",
        status: "running",
        step: "ocr-prep",
      },
      "r1",
    );
    assert.ok(fallback);
    assert.equal(fallback.message, "Preparing OCR…");
    assert.equal(fallback.level, "step");
  });

  it("uses the coordinator's denormalized ocrStatus/ocrStep over the row's own running/ocr-prep", () => {
    const entry: TrackerEntry = {
      workflow: "oath-signature",
      timestamp: "2026-06-17T10:00:00.000Z",
      id: "ocr-prep-sess-1",
      runId: "op-1",
      status: "running",
      step: "ocr-prep",
      data: { archetype: "operation", ocrStatus: "awaiting-review", ocrStep: "awaiting-approval" },
    };
    const fallback = deriveTrackerFallbackLog(entry, "op-1");
    assert.ok(fallback);
    assert.equal(fallback.message, "Awaiting review");
  });

  it("maps each coordinator ocrStatus to its readable phrase", () => {
    const phaseFor = (ocrStatus: string): string | undefined =>
      deriveTrackerFallbackLog(
        {
          workflow: "emergency-contact",
          timestamp: "2026-06-17T10:00:00.000Z",
          id: "ocr-prep-s",
          runId: "op",
          status: "running",
          step: "ocr-prep",
          data: { archetype: "operation", ocrStatus, ocrStep: ocrStatus },
        },
        "op",
      )?.message;

    assert.equal(phaseFor("preparing"), "Preparing OCR…");
    assert.equal(phaseFor("awaiting-review"), "Awaiting review");
    assert.equal(phaseFor("approved"), "Approved — fanning out");
    assert.equal(phaseFor("discarded"), "Discarded");
    assert.equal(phaseFor("cancelled"), "Cancelled");
    assert.equal(phaseFor("failed"), "OCR failed");
  });

  it("returns null when there is no selected tracker entry", () => {
    assert.equal(deriveTrackerFallbackLog(null, null), null);
  });
});
