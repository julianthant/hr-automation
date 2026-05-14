import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDisplayNameMap,
  buildDisplayNameEntries,
  collectEntriesForMergedScope,
  mergedGroupPeersForLogPanel,
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

test("buildDisplayNameMap ordinals OCR prep rows using OATH / EMPL prefixes from formType", () => {
  const first = entry("ocr-session-1", { __id: "ocr-session-1", formType: "oath" }, "2026-05-05T12:00:00.000Z");
  first.workflow = "ocr";
  const second = entry("ocr-session-2", { __id: "ocr-session-2", formType: "emergency-contact" }, "2026-05-05T12:01:00.000Z");
  second.workflow = "ocr";

  const displayNames = buildDisplayNameMap([second, first], "OCR");

  assert.equal(resolveEntryName(first, displayNames), "OATH 1");
  assert.equal(resolveEntryName(second, displayNames), "EMPL 1");
});

test("OCR rows with parentSubject use the batch label instead of OATH/EMPL", () => {
  const ocrRow = entry(
    "ocr-session-1",
    {
      __id: "ocr-session-1",
      formType: "oath",
      parentSubject: "Oath Signature · #1234",
    },
    "2026-05-05T12:00:00.000Z",
  );
  ocrRow.workflow = "ocr";
  ocrRow.runId = "ocr-run-1";

  const child = entry(
    "ocr-oath-run-1-r0-n0",
    {
      name: "Barahona Martell, Carlos D",
      __name: "Oath Signature · #1234",
      parentSubject: "Oath Signature · #1234",
    },
    "2026-05-05T12:02:00.000Z",
  );
  child.workflow = "eid-lookup";
  child.parentRunId = "ocr-run-1";

  const displayNames = buildDisplayNameMap([child, ocrRow], "OCR");

  assert.equal(resolveEntryName(ocrRow, displayNames), "Oath Signature · #1234");
  assert.equal(resolveEntryName(child, displayNames), "Oath Signature · #1234");
});

test("batch rows display the global queue title", () => {
  const row = entry("ocr-session-1", {
    __queueTitle: "Oath · #90ab",
    __queueTitleKind: "batch",
    __queueRootTitle: "Oath · #90ab",
    __name: "Legacy Name",
  });
  row.workflow = "ocr";

  const displayNames = buildDisplayNameMap([row], "OCR");

  assert.equal(resolveEntryName(row, displayNames), "Oath · #90ab");
});

test("delegated rows inherit root queue title even with employee name", () => {
  const parent = entry("ocr-session-1", {
    __queueTitle: "Emergency Contact · #3456",
    __queueTitleKind: "batch",
    __queueRootTitle: "Emergency Contact · #3456",
  });
  parent.workflow = "ocr";
  parent.runId = "parent-run-1";

  const child = entry("10000001", {
    name: "Doe, Jane",
    __queueTitle: "Doe, Jane",
    __queueTitleKind: "delegation",
    __queueRootTitle: "Emergency Contact · #3456",
  });
  child.workflow = "active-check";
  child.parentRunId = "parent-run-1";

  const displayNames = buildDisplayNameMap([child, parent], "OCR");

  assert.equal(resolveEntryName(parent, displayNames), "Emergency Contact · #3456");
  assert.equal(resolveEntryName(child, displayNames), "Emergency Contact · #3456");
});

test("delegated rows inherit the parent display name", () => {
  const firstParent = entry("ocr-session-1", { __id: "ocr-session-1", formType: "oath" }, "2026-05-05T12:00:00.000Z");
  firstParent.workflow = "ocr";
  firstParent.runId = "ocr-run-1";
  const secondParent = entry("ocr-session-2", { __id: "ocr-session-2", formType: "emergency-contact" }, "2026-05-05T12:01:00.000Z");
  secondParent.workflow = "ocr";
  secondParent.runId = "ocr-run-2";
  const child = entry("ocr-oath-run-1-r0-n0", {
    name: "Barahona Martell, Carlos D",
    __name: "Barahona Martell, Carlos D",
  }, "2026-05-05T12:02:00.000Z");
  child.workflow = "eid-lookup";
  child.parentRunId = "ocr-run-1";

  const displayNames = buildDisplayNameMap([child, secondParent, firstParent], "OCR");

  assert.equal(resolveEntryName(firstParent, displayNames), "OATH 1");
  assert.equal(resolveEntryName(secondParent, displayNames), "EMPL 1");
  assert.equal(resolveEntryName(child, displayNames), "OATH 1");
});

test("delegated rows inherit a single visible parent label even when the child has its own employee name", () => {
  const parent = entry(
    "ocr-session-single",
    { __id: "ocr-session-single", formType: "oath" },
    "2026-05-05T12:00:00.000Z",
  );
  parent.workflow = "ocr";
  parent.runId = "ocr-run-single";
  const child = entry(
    "10000001",
    {
      emplId: "10000001",
      name: "Barahona Martell, Carlos D",
      __name: "Barahona Martell, Carlos D",
    },
    "2026-05-05T12:02:00.000Z",
  );
  child.workflow = "oath-signature";
  child.parentRunId = "ocr-run-single";

  const displayNames = buildDisplayNameMap([child, parent], "OCR");

  assert.equal(resolveEntryName(parent, displayNames), "OATH 1");
  assert.equal(resolveEntryName(child, displayNames), "OATH 1");
});

test("nested delegated rows inherit the root parent display name (prepare-mode parent gets no ordinal suffix)", () => {
  const parent = entry(
    "ocr-prep-session-nested",
    {
      __name: "Oath Signature · #sted",
      __id: "ocr-prep-session-nested",
      mode: "prepare",
      pdfOriginalName: "oath-packet.pdf",
    },
    "2026-05-05T12:00:00.000Z",
  );
  parent.workflow = "oath-signature";
  parent.runId = "origin-run-nested";

  const ocrChild = entry(
    "session-nested",
    { __id: "session-nested", formType: "oath" },
    "2026-05-05T12:01:00.000Z",
  );
  ocrChild.workflow = "ocr";
  ocrChild.runId = "ocr-run-nested";
  ocrChild.parentRunId = "origin-run-nested";

  const eidGrandchild = entry(
    "ocr-oath-ocr-run-nested-r0",
    {
      searchName: "Barahona Martell, Carlos D",
      __name: "Barahona Martell, Carlos D",
    },
    "2026-05-05T12:02:00.000Z",
  );
  eidGrandchild.workflow = "eid-lookup";
  eidGrandchild.runId = "eid-run-nested";
  eidGrandchild.parentRunId = "ocr-run-nested";

  const displayNames = buildDisplayNameMap([eidGrandchild, ocrChild, parent], "Oath Signature");

  assert.equal(resolveEntryName(parent, displayNames), "Oath Signature · #sted");
  assert.equal(resolveEntryName(ocrChild, displayNames), "Oath Signature · #sted");
  assert.equal(resolveEntryName(eidGrandchild, displayNames), "Oath Signature · #sted");
});

test("buildDisplayNameEntries includes delegated parents for visible single child rows", () => {
  const parent = entry(
    "ocr-session-single",
    { __id: "ocr-session-single", formType: "oath" },
    "2026-05-05T12:00:00.000Z",
  );
  parent.workflow = "ocr";
  parent.runId = "ocr-run-single";
  const child = entry(
    "10000001",
    {
      emplId: "10000001",
      name: "Barahona Martell, Carlos D",
      __name: "Barahona Martell, Carlos D",
    },
    "2026-05-05T12:02:00.000Z",
  );
  child.workflow = "oath-signature";
  child.parentRunId = "ocr-run-single";
  const unrelatedSibling = entry(
    "alternate-search",
    { emplId: "10000001", searchName: "Alternate, Search" },
    "2026-05-05T12:03:00.000Z",
  );
  unrelatedSibling.workflow = "oath-signature";

  const entriesForNames = buildDisplayNameEntries({
    visibleEntries: [child],
    sourceEntries: [child, parent, unrelatedSibling],
  });
  const displayNames = buildDisplayNameMap(entriesForNames, "OCR");

  assert.deepEqual(
    new Set(entriesForNames.map((row) => row.runId)),
    new Set(["ocr-run-single", "10000001#1"]),
  );
  assert.equal(resolveEntryName(child, displayNames), "OATH 1");
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

test("mergedGroupPeersForLogPanel returns siblings when primary selected", () => {
  const primary = entry("name-search", { emplId: "10874100" });
  const sibling = entry("10874100", { emplId: "10874100" });
  const groups = [{ primary, siblings: [sibling] }];

  assert.deepEqual(mergedGroupPeersForLogPanel(primary.id, groups), [sibling]);
});

test("mergedGroupPeersForLogPanel returns primary plus other siblings when a sibling selected", () => {
  const primary = entry("name-search", { emplId: "10874100" });
  const siblingA = entry("Alt spelling", { emplId: "10874100" });
  const siblingB = entry("10874100", { emplId: "10874100" });
  const groups = [{ primary, siblings: [siblingA, siblingB] }];

  assert.deepEqual(
    mergedGroupPeersForLogPanel(siblingA.id, groups),
    [primary, siblingB],
  );
});
