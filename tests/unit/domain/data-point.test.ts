import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  DATA_POINT_EVENT,
  buildDataPointLog,
  coerceDataValue,
  groupDataPointsByStep,
  isDataPointLog,
  readDataPointFromLog,
  type DataPointLogLike,
} from "../../../src/domain/data-point.js";

describe("coerceDataValue", () => {
  it("stringifies primitives", () => {
    assert.equal(coerceDataValue("hi"), "hi");
    assert.equal(coerceDataValue(42), "42");
    assert.equal(coerceDataValue(false), "false");
  });

  it("uses sentinels for absent / blank values", () => {
    assert.equal(coerceDataValue(null), "<none>");
    assert.equal(coerceDataValue(undefined), "<none>");
    assert.equal(coerceDataValue(""), "<empty>");
    assert.equal(coerceDataValue([]), "<none>");
  });

  it("joins arrays and serializes objects", () => {
    assert.equal(coerceDataValue(["a", "b"]), "a, b");
    assert.equal(coerceDataValue({ a: 1 }), '{"a":1}');
  });
});

describe("buildDataPointLog", () => {
  it("emits the data:point event with structured fields + a readable message", () => {
    const fields = buildDataPointLog(
      { direction: "read", field: "lastDayWorked", label: "Last Day Worked", value: "06/14/2026", system: "Kuali" },
      "kuali-extraction",
    );
    assert.equal(fields.event, DATA_POINT_EVENT);
    assert.equal(fields.occasion, "recorded");
    assert.equal(fields.dataDirection, "read");
    assert.equal(fields.dataField, "lastDayWorked");
    assert.equal(fields.dataLabel, "Last Day Worked");
    assert.equal(fields.dataValue, "06/14/2026");
    assert.equal(fields.system, "Kuali");
    assert.equal(fields.step, "kuali-extraction");
    assert.equal(fields.message, "Read · Last Day Worked = 06/14/2026 (Kuali)");
  });

  it("humanizes a missing label and writes use the Wrote verb + note", () => {
    const fields = buildDataPointLog(
      { direction: "write", field: "transactionNumber", value: "T-9", note: "reused approved duplicate" },
      null,
    );
    assert.equal(fields.dataLabel, "Transaction Number");
    assert.equal(fields.dataNote, "reused approved duplicate");
    assert.equal(fields.message, "Wrote · Transaction Number = T-9 — reused approved duplicate");
    assert.equal(fields.step, undefined);
    assert.equal(fields.system, undefined);
  });
});

describe("isDataPointLog / readDataPointFromLog", () => {
  it("accepts a well-formed line and rejects ordinary log lines", () => {
    const good: DataPointLogLike = {
      event: DATA_POINT_EVENT,
      dataDirection: "write",
      dataField: "department",
      dataLabel: "Department",
      dataValue: "Housing",
      step: "ucpath-job-summary",
      system: "Kuali",
      ts: "2026-06-25T10:00:00Z",
    };
    assert.equal(isDataPointLog(good), true);
    assert.equal(isDataPointLog({ event: "step:start", step: "x" }), false);
    assert.equal(isDataPointLog({ event: DATA_POINT_EVENT, dataDirection: "read" }), false);

    const view = readDataPointFromLog(good);
    assert.ok(view);
    assert.deepEqual(view, {
      direction: "write",
      field: "department",
      label: "Department",
      value: "Housing",
      step: "ucpath-job-summary",
      system: "Kuali",
      ts: "2026-06-25T10:00:00Z",
    });
  });

  it("returns null for non-data lines", () => {
    assert.equal(readDataPointFromLog({ message: "hello" }), null);
  });
});

describe("groupDataPointsByStep", () => {
  it("groups by step in first-seen order, splitting reads and writes, ignoring noise", () => {
    const lines: DataPointLogLike[] = [
      { message: "Phase: kuali-extraction", event: "step:start", step: "kuali-extraction" },
      { event: DATA_POINT_EVENT, dataDirection: "read", dataField: "eid", dataLabel: "EID", dataValue: "123", step: "kuali-extraction", system: "Kuali" },
      { event: DATA_POINT_EVENT, dataDirection: "read", dataField: "name", dataLabel: "Name", dataValue: "Doe", step: "kuali-extraction", system: "Kuali" },
      { event: DATA_POINT_EVENT, dataDirection: "write", dataField: "department", dataLabel: "Department", dataValue: "Housing", step: "ucpath-job-summary", system: "Kuali" },
      { event: DATA_POINT_EVENT, dataDirection: "read", dataField: "dept", dataLabel: "Dept", dataValue: "Housing", step: "ucpath-job-summary", system: "UCPath" },
    ];
    const groups = groupDataPointsByStep(lines);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.step, "kuali-extraction");
    assert.equal(groups[0]!.reads.length, 2);
    assert.equal(groups[0]!.writes.length, 0);
    assert.equal(groups[1]!.step, "ucpath-job-summary");
    assert.equal(groups[1]!.reads.length, 1);
    assert.equal(groups[1]!.writes.length, 1);
  });

  it("returns an empty array when no data points are present", () => {
    assert.deepEqual(groupDataPointsByStep([{ message: "x" }, { event: "step:done" }]), []);
  });

  it("falls back to a placeholder step when none is tagged", () => {
    const groups = groupDataPointsByStep([
      { event: DATA_POINT_EVENT, dataDirection: "read", dataField: "f", dataValue: "v" },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.reads.length, 1);
  });
});
