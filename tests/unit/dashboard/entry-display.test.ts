import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDisplayNameMap,
  collectEntriesForMergedScope,
  resolveEntryName,
} from "../../../src/dashboard/components/shared/entry-display.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function entry(id: string, data: Record<string, string>, timestamp = "2026-05-05T12:00:00.000Z"): TrackerEntry {
  return {
    workflow: "eid-lookup",
    id,
    runId: `${id}#1`,
    status: "done",
    timestamp,
    data,
  };
}

test("buildDisplayNameMap keeps person names literal instead of appending ordinals", () => {
  const row = entry("Zaw, Hein Thant", {
    searchName: "Zaw, Hein Thant",
    __name: "Zaw, Hein Thant",
    __id: "Zaw, Hein Thant",
    __subject: "Zaw, Hein Thant",
  });

  const displayNames = buildDisplayNameMap([row], "EID Lookup");

  assert.equal(resolveEntryName(row, displayNames), "Zaw, Hein Thant");
});

test("buildDisplayNameMap prefers the employee name over a prefixed workflow subject", () => {
  const row = entry("separation-doc-1", {
    docId: "separation-doc-1",
    name: "Zaw, Hein Thant",
    __name: "Zaw, Hein Thant",
    __id: "separation-doc-1",
    __subject: "Separation separation-doc-1",
    __subjectKind: "document",
  });

  const displayNames = buildDisplayNameMap([row], "Separation");

  assert.equal(resolveEntryName(row, displayNames), "Zaw, Hein Thant");
});

test("resolveEntryName prefers the computed employee name over the operator subject", () => {
  const row = entry("Zaw, Hein Thant", {
    searchName: "Zaw, Hein Thant",
    __name: "Zaw, Hein Thant",
    __id: "Zaw, Hein Thant",
    __subject: "EID Lookup Zaw, Hein Thant",
    __subjectKind: "person",
  });

  assert.equal(resolveEntryName(row), "Zaw, Hein Thant");
});

test("buildDisplayNameMap falls back to the workflow label when no employee name is known", () => {
  const row = entry("separation-doc-1", {
    docId: "separation-doc-1",
    __id: "separation-doc-1",
    __subject: "Separation separation-doc-1",
    __subjectKind: "document",
  });

  const displayNames = buildDisplayNameMap([row], "Separation");

  // Single workflow-level entry — buildDisplayNameMap suppresses the ordinal
  // (to avoid "Active Check 1" noise), so resolveEntryName falls through to __subject.
  assert.equal(resolveEntryName(row, displayNames), "Separation separation-doc-1");
});

test("buildDisplayNameMap still ordinals workflow-level rows such as OCR batches", () => {
  const first = entry("ocr-session-1", { __name: "OCR", __id: "ocr-session-1" }, "2026-05-05T12:00:00.000Z");
  const second = entry("ocr-session-2", { __name: "OCR", __id: "ocr-session-2" }, "2026-05-05T12:01:00.000Z");

  const displayNames = buildDisplayNameMap([second, first], "OCR");

  assert.equal(resolveEntryName(first, displayNames), "OCR 1");
  assert.equal(resolveEntryName(second, displayNames), "OCR 2");
});

test("delegated rows inherit the parent display name", () => {
  const firstParent = entry("ocr-session-1", { __name: "OCR", __id: "ocr-session-1" }, "2026-05-05T12:00:00.000Z");
  firstParent.runId = "ocr-run-1";
  const secondParent = entry("ocr-session-2", { __name: "OCR", __id: "ocr-session-2" }, "2026-05-05T12:01:00.000Z");
  secondParent.runId = "ocr-run-2";
  const child = entry("ocr-oath-run-1-r0-n0", {
    name: "Barahona Martell, Carlos D",
    __name: "Barahona Martell, Carlos D",
  }, "2026-05-05T12:02:00.000Z");
  child.workflow = "eid-lookup";
  child.parentRunId = "ocr-run-1";

  const displayNames = buildDisplayNameMap([child, secondParent, firstParent], "OCR");

  assert.equal(resolveEntryName(firstParent, displayNames), "OCR 1");
  assert.equal(resolveEntryName(secondParent, displayNames), "OCR 2");
  assert.equal(resolveEntryName(child, displayNames), "OCR 1");
});

test("collectEntriesForMergedScope includes hidden merged siblings for bulk controls", () => {
  const primary = entry("name-search", { emplId: "10706431", searchName: "Zaw, Hein" });
  primary.status = "running";
  primary.runId = "run-primary";
  const sibling = entry("10706431", { emplId: "10706431" });
  sibling.status = "pending";
  sibling.runId = "run-sibling";
  const unrelated = entry("other", { searchName: "Other Person" });
  unrelated.status = "pending";
  unrelated.runId = "run-other";

  const groups = [
    { primary, siblings: [sibling] },
    { primary: unrelated, siblings: [] },
  ];

  assert.deepEqual(collectEntriesForMergedScope(groups, [primary]), [primary, sibling]);
});
