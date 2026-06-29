import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildEditDataInitialValues,
  buildEditDataResetKey,
  mmddyyyyToYmd,
  ymdToMmddyyyy,
  validateEditField,
  groupEditableFields,
} from "../../../src/dashboard/components/log-panel/EditDataTab.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

const editableFields = [
  { key: "employeeName" },
  { key: "effectiveDate" },
];

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "separations",
    id: "doc-123",
    runId: "doc-123#1",
    status: "running",
    timestamp: "2026-05-15T12:00:00.000Z",
    data: {
      employeeName: "Original Name",
      effectiveDate: "2026-05-15",
    },
    ...overrides,
  };
}

describe("EditDataTab reset identity", () => {
  it("keeps the same reset key for fresh SSE entry objects with the same row identity", () => {
    const first = entry();
    const sseRefresh = entry({
      data: {
        employeeName: "Updated From SSE",
        effectiveDate: "2026-05-16",
      },
      lastLogTs: "2026-05-15T12:00:10.000Z",
    });

    assert.equal(
      buildEditDataResetKey(first, editableFields),
      buildEditDataResetKey(sseRefresh, editableFields),
    );
  });

  it("builds initial values only from editable fields", () => {
    assert.deepEqual(buildEditDataInitialValues(entry(), editableFields), {
      employeeName: "Original Name",
      effectiveDate: "2026-05-15",
    });
  });
});

describe("mmddyyyyToYmd", () => {
  it("converts a real MM/DD/YYYY date to YYYY-MM-DD", () => {
    assert.equal(mmddyyyyToYmd("06/14/2026"), "2026-06-14");
  });

  it("accepts single-digit month/day and zero-pads the output", () => {
    assert.equal(mmddyyyyToYmd("6/4/2026"), "2026-06-04");
  });

  it("returns undefined for an impossible day", () => {
    assert.equal(mmddyyyyToYmd("02/31/2026"), undefined);
  });

  it("returns undefined for a malformed or empty value", () => {
    assert.equal(mmddyyyyToYmd("2026-06-14"), undefined);
    assert.equal(mmddyyyyToYmd("nope"), undefined);
    assert.equal(mmddyyyyToYmd(""), undefined);
  });
});

describe("ymdToMmddyyyy", () => {
  it("converts the calendar's YYYY-MM-DD back to MM/DD/YYYY", () => {
    assert.equal(ymdToMmddyyyy("2026-06-14"), "06/14/2026");
  });

  it("round-trips with mmddyyyyToYmd", () => {
    assert.equal(ymdToMmddyyyy(mmddyyyyToYmd("12/01/2026")!), "12/01/2026");
  });

  it("passes through an unexpected shape unchanged", () => {
    assert.equal(ymdToMmddyyyy("garbage"), "garbage");
  });
});

describe("validateEditField", () => {
  it("allows an empty value for any field (clearing is valid)", () => {
    assert.equal(validateEditField({ key: "eid", label: "EID", inputKind: "id" }, ""), null);
    assert.equal(validateEditField({ key: "d", label: "Date", inputKind: "date" }, "   "), null);
  });

  it("rejects a malformed date but accepts a real one", () => {
    const f = { key: "lastDayWorked", label: "Last Day Worked", inputKind: "date" as const };
    assert.equal(validateEditField(f, "06/14/2026"), null);
    assert.equal(validateEditField(f, "13/40/2026"), "Use MM/DD/YYYY.");
  });

  it("rejects whitespace inside an id but accepts a clean id", () => {
    const f = { key: "eid", label: "EID", inputKind: "id" as const };
    assert.equal(validateEditField(f, "10829139"), null);
    assert.equal(validateEditField(f, "108 29139"), "IDs can't contain spaces.");
  });

  it("does not validate plain text fields", () => {
    assert.equal(validateEditField({ key: "name", label: "Employee" }, "Jackson, Violet"), null);
  });
});

describe("groupEditableFields", () => {
  it("groups consecutive fields sharing a group label, preserving order", () => {
    const sections = groupEditableFields([
      { key: "name", label: "Employee", group: "Identity" },
      { key: "eid", label: "EID", group: "Identity", inputKind: "id" },
      { key: "lastDayWorked", label: "Last Day Worked", group: "Dates", inputKind: "date" },
      { key: "separationDate", label: "Separation Date", group: "Dates", inputKind: "date" },
      { key: "comments", label: "Comments", group: "Notes", multiline: true },
    ]);
    assert.deepEqual(
      sections.map((s) => ({ group: s.group, keys: s.fields.map((f) => f.key) })),
      [
        { group: "Identity", keys: ["name", "eid"] },
        { group: "Dates", keys: ["lastDayWorked", "separationDate"] },
        { group: "Notes", keys: ["comments"] },
      ],
    );
  });

  it("places ungrouped fields in a single unlabeled section", () => {
    const sections = groupEditableFields([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].group, undefined);
    assert.deepEqual(sections[0].fields.map((f) => f.key), ["a", "b"]);
  });
});
