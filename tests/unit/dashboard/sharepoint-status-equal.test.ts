import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { statusesEqual } from "../../../src/dashboard/components/hooks/useSharePointStatus.js";
import type { SharePointDownloadStatus } from "../../../src/domain/sharepoint-download-status.js";

function status(overrides: Partial<SharePointDownloadStatus> = {}): SharePointDownloadStatus {
  return {
    inFlight: false,
    inFlightId: null,
    current: null,
    queued: [],
    lastCompletion: null,
    ...overrides,
  };
}

describe("statusesEqual — shallow status compare for re-render skip", () => {
  it("treats two structurally-identical snapshots as equal", () => {
    assert.equal(statusesEqual(status(), status()), true);
  });

  it("null vs a value is not equal", () => {
    assert.equal(statusesEqual(null, status()), false);
    assert.equal(statusesEqual(status(), null), false);
    assert.equal(statusesEqual(null, null), true);
  });

  it("a flipped inFlight flag is not equal", () => {
    assert.equal(
      statusesEqual(status({ inFlight: false }), status({ inFlight: true })),
      false,
    );
  });

  it("a different current queueId is not equal", () => {
    const a = status({
      current: { queueId: "spq-1", id: "onboarding", label: "X", state: "running", createdAt: "t" },
    });
    const b = status({
      current: { queueId: "spq-2", id: "onboarding", label: "X", state: "running", createdAt: "t" },
    });
    assert.equal(statusesEqual(a, b), false);
  });

  it("a different queue length is not equal", () => {
    const a = status();
    const b = status({
      queued: [{ queueId: "spq-2", id: "x", label: "x", state: "queued", createdAt: "t" }],
    });
    assert.equal(statusesEqual(a, b), false);
  });

  it("a new completion timestamp is not equal (drives the roster refresh)", () => {
    const a = status({ lastCompletion: { id: "x", ts: "2026-01-01T00:00:00Z", ok: true } });
    const b = status({ lastCompletion: { id: "x", ts: "2026-01-02T00:00:00Z", ok: true } });
    assert.equal(statusesEqual(a, b), false);
  });

  it("ignores fields not material to the picker (same ts, label changes only)", () => {
    const a = status({
      current: { queueId: "spq-1", id: "onboarding", label: "Old", state: "running", createdAt: "t1" },
    });
    const b = status({
      current: { queueId: "spq-1", id: "onboarding", label: "New", state: "running", createdAt: "t2" },
    });
    // queueId + state match → equal (label/createdAt aren't compared).
    assert.equal(statusesEqual(a, b), true);
  });
});
