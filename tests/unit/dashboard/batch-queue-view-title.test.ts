import { test } from "vitest";
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

test("resolveDaemonBatchQueueTitle surfaces a member's pdfOriginalName for file batches", () => {
  const member: TrackerEntry = {
    workflow: "oath-upload",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { pdfOriginalName: "signed-oath.pdf" },
  } as TrackerEntry;
  assert.equal(
    resolveDaemonBatchQueueTitle("Oath Upload", [member], "abcd1234"),
    "signed-oath.pdf",
  );
});

test("resolveDaemonBatchQueueTitle returns '' for person batches (no override, no pdf, ordinals retired)", () => {
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
    "",
  );
});

test("resolveDaemonBatchQueueTitle treats empty-string override as absent and falls through to ''", () => {
  // A sloppy caller passing `parent.data?.__name` where the field happens to be ""
  // must not pin an empty override; with no pdf member the person-batch fallthrough yields "".
  assert.equal(
    resolveDaemonBatchQueueTitle("Oath Signature", [], "abcd1234", ""),
    "",
  );
});
