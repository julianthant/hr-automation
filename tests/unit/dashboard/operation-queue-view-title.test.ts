import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveDaemonOperationQueueTitle } from "../../../src/dashboard/components/queue-panel/operation-queue-view.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

test("resolveDaemonOperationQueueTitle ignores a non-PDF titleOverride (random/person name → no title)", () => {
  const member: TrackerEntry = {
    workflow: "eid-lookup",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { __name: "irrelevant", batchDisplayOrdinal: "" },
  } as TrackerEntry;
  // A batch is titled ONLY by a PDF filename. A non-PDF override is dropped.
  assert.equal(
    resolveDaemonOperationQueueTitle("EID Lookup", [member], "1234", "Oath Signature · #1234"),
    "",
  );
});

test("resolveDaemonOperationQueueTitle honors a titleOverride only when it is a PDF filename", () => {
  assert.equal(
    resolveDaemonOperationQueueTitle("Oath Upload", [], "1234", "Inherited_Batch.pdf"),
    "Inherited_Batch.pdf",
  );
});

test("resolveDaemonOperationQueueTitle surfaces a member's pdfOriginalName for file batches", () => {
  const member: TrackerEntry = {
    workflow: "oath-upload",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { pdfOriginalName: "signed-oath.pdf" },
  } as TrackerEntry;
  assert.equal(
    resolveDaemonOperationQueueTitle("Oath Upload", [member], "abcd1234"),
    "signed-oath.pdf",
  );
});

test("resolveDaemonOperationQueueTitle returns '' for person batches (no override, no pdf, ordinals retired)", () => {
  const member: TrackerEntry = {
    workflow: "eid-lookup",
    id: "x",
    runId: "x-1",
    timestamp: "2026-05-14",
    status: "done",
    data: { batchDisplayOrdinal: "3" },
  } as TrackerEntry;
  assert.equal(
    resolveDaemonOperationQueueTitle("Active Check", [member], "00009999"),
    "",
  );
});

test("resolveDaemonOperationQueueTitle treats empty-string override as absent and falls through to ''", () => {
  // A sloppy caller passing `parent.data?.__name` where the field happens to be ""
  // must not pin an empty override; with no pdf member the person-batch fallthrough yields "".
  assert.equal(
    resolveDaemonOperationQueueTitle("Oath Signature", [], "abcd1234", ""),
    "",
  );
});
