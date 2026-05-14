import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDaemonBatchQueueTitle } from "../../../src/dashboard/components/queue-panel/batch-queue-view.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

test("resolveDaemonBatchQueueTitle returns titleOverride when non-empty", () => {
  const member: TrackerEntry = {
    workflow: "eid-lookup",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { __name: "irrelevant", batchDisplayOrdinal: "" },
  } as TrackerEntry;
  assert.equal(
    resolveDaemonBatchQueueTitle("EID Lookup", [member], "1234", "Oath Signature · #1234"),
    "Oath Signature · #1234",
  );
});

test("resolveDaemonBatchQueueTitle falls back to '<workflowLabel> · #<id>' when no override + no ordinal", () => {
  assert.equal(
    resolveDaemonBatchQueueTitle("Oath Signature", [], "abcd1234"),
    "Oath Signature · #1234",
  );
});

test("resolveDaemonBatchQueueTitle uses batchDisplayOrdinal when present and no override", () => {
  const member: TrackerEntry = {
    workflow: "eid-lookup",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { batchDisplayOrdinal: "3" },
  } as TrackerEntry;
  assert.equal(
    resolveDaemonBatchQueueTitle("Active Check", [member], "00009999"),
    "Active Check 3",
  );
});

test("resolveDaemonBatchQueueTitle treats empty-string override as absent", () => {
  // Defensive: a sloppy caller passing `parent.data?.__name` where the field happens to be ""
  // should not get an empty title. Make sure the fallback fires.
  assert.equal(
    resolveDaemonBatchQueueTitle("Oath Signature", [], "abcd1234", ""),
    "Oath Signature · #1234",
  );
});
