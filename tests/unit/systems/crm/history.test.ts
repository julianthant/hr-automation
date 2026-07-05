import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  parseCrmHistoryTimestamp,
  findOathSignedTransition,
  WITNESS_OATH_NEW_HIRE_SIGNED,
} from "../../../../src/systems/crm/history.js";

/**
 * Pure-logic tests for the ACT CRM onboarding-history reader. The live scrape
 * (`readOnboardingOathHistory`) needs a real page, but the two functions that
 * decide the outcome — timestamp parsing and the transition scan — are pure and
 * pinned here against the live-observed grid shapes (EID 10883906 / 10883915,
 * 2026-07-02).
 */

describe("parseCrmHistoryTimestamp", () => {
  it("splits a CRM `M/D/YYYY H:MM AM/PM` cell into padded date + time", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("7/1/2026 1:27 PM"), {
      date: "07/01/2026",
      time: "1:27 PM",
    });
  });

  it("pads single-digit month and day", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("6/4/2026 7:40 PM"), {
      date: "06/04/2026",
      time: "7:40 PM",
    });
  });

  it("handles a two-digit month/day already padded", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("12/25/2026 11:05 AM"), {
      date: "12/25/2026",
      time: "11:05 AM",
    });
  });

  it("returns a date with null time when the time-of-day is absent", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("7/1/2026"), {
      date: "07/01/2026",
      time: null,
    });
  });

  it("tolerates surrounding whitespace", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("  7/1/2026 1:20 PM  "), {
      date: "07/01/2026",
      time: "1:20 PM",
    });
  });

  it("returns nulls for an unparseable value (fail-soft, no throw)", () => {
    assert.deepEqual(parseCrmHistoryTimestamp("not a date"), {
      date: null,
      time: null,
    });
    assert.deepEqual(parseCrmHistoryTimestamp(""), { date: null, time: null });
  });
});

describe("findOathSignedTransition", () => {
  // The live grid (Aliana Villalobos, EID 10883915): the row transitioning TO
  // "New Hire Signed" is the sign event; the SAME string appears as the OLD value
  // of the next (Counter-Signed) row.
  const liveRows: string[][] = [
    ["Date", "Created By", "Field", "Old Value", "New Value"], // header (5 cells too)
    ["7/1/2026 1:20 PM", "Juan Ramirez", "ProcessStageText", "Start Date Verified", "Witness Ceremony Oath Created"],
    ["7/1/2026 1:20 PM", "Juan Ramirez", "ProcessStageText", "Witness Ceremony Oath Created", WITNESS_OATH_NEW_HIRE_SIGNED],
    ["7/1/2026 1:28 PM", "Juan Ramirez", "ProcessStageText", WITNESS_OATH_NEW_HIRE_SIGNED, "Witness Ceremony Oath HR Counter-Signed"],
    ["7/1/2026 1:28 PM", "UCSD Administrator", "ProcessStageText", "Witness Ceremony Oath HR Counter-Signed", "Completed"],
  ];

  it("finds the New-Value transition (not the Old-Value occurrence on the next row) and reads its date", () => {
    assert.deepEqual(findOathSignedTransition(liveRows), {
      oathSigned: true,
      signedDate: "07/01/2026",
      signedTime: "1:20 PM",
    });
  });

  it("returns not-signed when no row transitions to the signed stage", () => {
    const rows = liveRows.filter((c) => c[4] !== WITNESS_OATH_NEW_HIRE_SIGNED);
    assert.deepEqual(findOathSignedTransition(rows), {
      oathSigned: false,
      signedDate: null,
      signedTime: null,
    });
  });

  it("ignores non-5-cell (header/wrapper) rows", () => {
    const rows: string[][] = [
      ["one giant wrapper cell"],
      ["7/1/2026 1:27 PM", "Julian Zaw", "ProcessStageText", "Witness Ceremony Oath Created", WITNESS_OATH_NEW_HIRE_SIGNED],
    ];
    assert.equal(findOathSignedTransition(rows).oathSigned, true);
    assert.equal(findOathSignedTransition(rows).signedDate, "07/01/2026");
  });

  it("takes the FIRST signed transition when several exist", () => {
    const rows: string[][] = [
      ["7/1/2026 1:00 PM", "A", "ProcessStageText", "x", WITNESS_OATH_NEW_HIRE_SIGNED],
      ["7/2/2026 2:00 PM", "B", "ProcessStageText", "x", WITNESS_OATH_NEW_HIRE_SIGNED],
    ];
    assert.deepEqual(findOathSignedTransition(rows), {
      oathSigned: true,
      signedDate: "07/01/2026",
      signedTime: "1:00 PM",
    });
  });

  it("returns not-signed for an empty grid", () => {
    assert.deepEqual(findOathSignedTransition([]), {
      oathSigned: false,
      signedDate: null,
      signedTime: null,
    });
  });
});
