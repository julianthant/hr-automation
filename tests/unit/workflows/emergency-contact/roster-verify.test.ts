/**
 * Unit tests for src/workflows/emergency-contact/roster-verify.ts
 *
 * This is the OCR digit-drift catcher: it cross-checks a batch's employee EID +
 * name against a downloaded SharePoint roster BEFORE any UCPath transaction runs
 * (documented in emergency-contact/CLAUDE.md — "caught real OCR digit drift, e.g.
 * 10090297 vs 10090296"). Covers the quoted-CSV parser, header-column resolution
 * (including the ~3 decorative rows the SharePoint export prepends), EID
 * matching, and the namesMatch word-intersection heuristic.
 *
 * Strategy: write real temp CSV files (the parser + header resolution are pure
 * over file text) and drive the public entry points (`verifyBatchAgainstRoster`,
 * `loadRosterIndex`) plus the two exported pure helpers (`namesMatch`,
 * `normalizeName`). No mocking of fs — small real files are simpler and exercise
 * the real `readFileSync` path.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyBatchAgainstRoster,
  loadRosterIndex,
  namesMatch,
  normalizeName,
} from "../../../../src/workflows/emergency-contact/roster-verify.js";
import type { EmergencyContactBatch, EmergencyContactRecord } from "../../../../src/workflows/emergency-contact/schema.js";
import { log } from "../../../../src/utils/log.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-verify-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCsv(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

function makeRecord(overrides: Partial<EmergencyContactRecord["employee"]> = {}, sourcePage = 1): EmergencyContactRecord {
  return {
    sourcePage,
    employee: {
      name: "Person 905",
      employeeId: "10090296",
      pid: null,
      jobTitle: null,
      workLocation: null,
      supervisor: null,
      workEmail: null,
      personalEmail: null,
      homeAddress: null,
      homePhone: null,
      cellPhone: null,
      ...overrides,
    },
    emergencyContact: {
      name: "John Doe",
      relationship: "Spouse",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
      cellPhone: "555-123-4567",
      homePhone: null,
      workPhone: null,
    },
    notes: [],
  };
}

function makeBatch(records: EmergencyContactRecord[]): EmergencyContactBatch {
  return { pdfPath: "/tmp/fake.pdf", batchName: "Test Batch", records };
}

// ── namesMatch / normalizeName (pure word-intersection heuristic) ──────────

describe("namesMatch", () => {
  it("matches identical names", () => {
    assert.equal(namesMatch("Person 905", "Person 905"), true);
  });

  it("matches regardless of word order (\"Person 905\" vs \"Person 905\")", () => {
    assert.equal(namesMatch("Person 905", "Person 905"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(namesMatch("Person 905", "Person 905"), true);
  });

  it("matches when a middle name is present on only one side", () => {
    assert.equal(namesMatch("Jane Marie Doe", "Person 905"), true);
  });

  it("does not match unrelated names", () => {
    assert.equal(namesMatch("Person 905", "Bob Smith"), false);
  });

  it("ignores words shorter than 3 letters — two short-word-only names never match", () => {
    // "Jo Yo" vs "Yo Jo": both words are length 2 and get filtered out by the
    // `w.length >= 3` guard, so the intersection is empty even though a human
    // would call these the same name reversed. Pinning current behavior.
    assert.equal(namesMatch("Jo Yo", "Yo Jo"), false);
  });

  it("matches on a single shared long word even if other words differ", () => {
    assert.equal(namesMatch("Macod Gozobu-Locik", "Macod Smith"), true);
  });

  it("strips punctuation via lettersOnly normalization (comma, hyphen)", () => {
    assert.equal(namesMatch("Gozobu-Locik, Macod", "Macod Gozobu Locik"), true);
  });

  it("treats empty strings as never matching", () => {
    assert.equal(namesMatch("", "Person 905"), false);
    assert.equal(namesMatch("", ""), false);
  });
});

describe("normalizeName", () => {
  it("lowercases, strips non-letters, and collapses whitespace", () => {
    assert.equal(normalizeName("  Doe,   Jane-Marie  "), "doe janemarie");
  });

  it("returns an empty string for falsy input", () => {
    assert.equal(normalizeName(""), "");
  });
});

// ── CSV parsing + header resolution (via verifyBatchAgainstRoster) ─────────

describe("verifyBatchAgainstRoster — CSV parsing", () => {
  it("parses a simple CSV and matches an exact EID + name", async () => {
    const csv = ["Employee ID,Name", "10090296,Person 905"].join("\n");
    const rosterPath = writeCsv("simple.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1);
    assert.equal(result.mismatched.length, 0);
    assert.equal(result.missing.length, 0);
    assert.equal(result.rosterRows, 1);
  });

  it("handles quoted fields with embedded commas", async () => {
    const csv = [
      "Employee ID,Name",
      '10090296,"Person 905"', // quoted field containing a comma
    ].join("\n");
    const rosterPath = writeCsv("quoted-comma.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1, "quoted comma must not split the Name field");
  });

  it("handles escaped double-quotes inside a quoted field", async () => {
    const csv = [
      "Employee ID,Name",
      '10090296,"Jane ""JD"" Doe"', // "" escapes to a literal "
    ].join("\n");
    const rosterPath = writeCsv("escaped-quote.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index[0]?.name, 'Jane "JD" Doe');
  });

  it("tolerates an unterminated quote at EOF without throwing (malformed row)", async () => {
    const csv = ["Employee ID,Name", '10090296,"Person 905'].join("\n"); // no closing quote
    const rosterPath = writeCsv("unterminated.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index.length, 1);
    assert.equal(index[0]?.emplId, "10090296");
  });

  it("strips a leading UTF-8 BOM", async () => {
    const csv = String.fromCharCode(0xfeff) + ["Employee ID,Name", "10090296,Person 905"].join("\n");
    const rosterPath = writeCsv("bom.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1);
  });

  it("handles CRLF line endings", async () => {
    const csv = ["Employee ID,Name", "10090296,Person 905"].join("\r\n");
    const rosterPath = writeCsv("crlf.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1);
  });

  it("skips blank rows", async () => {
    const csv = ["Employee ID,Name", "", "10090296,Person 905", ",,,"].join("\n");
    const rosterPath = writeCsv("blank-rows.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.rosterRows, 1, "fully-blank rows must not count as roster rows");
  });

  it("skips over decorative rows before the real header (SharePoint export shape)", async () => {
    const csv = [
      "Emergency Contact Roster",
      "Exported 2026-07-01",
      "",
      "Employee ID,Name",
      "10090296,Person 905",
    ].join("\n");
    const rosterPath = writeCsv("decorative.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1);
    assert.equal(result.rosterRows, 1);
  });

  it("throws a legible error when no header row within the first 10 rows has an ID column", async () => {
    const csv = Array.from({ length: 11 }, (_, i) => `junk${i},row${i}`).join("\n");
    const rosterPath = writeCsv("no-header.csv", csv);
    await assert.rejects(
      () => verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath),
      /Could not find a header row with UCPath\/Empl ID/,
    );
  });
});

describe("verifyBatchAgainstRoster — header column resolution (variant spellings)", () => {
  const headerVariants = ["UCPath ID", "Employee ID", "EmplID", "Empl ID", "eid"];
  for (const header of headerVariants) {
    it(`recognizes "${header}" as the EID column`, async () => {
      const csv = [`${header},Name`, "10090296,Person 905"].join("\n");
      const rosterPath = writeCsv(`hdr-${header.replace(/\s+/g, "_")}.csv`, csv);
      const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
      assert.equal(result.matched, 1, `header "${header}" should resolve to the EID column`);
    });
  }

  const nameVariants = ["Legal Name", "Name", "Lived Name", "Employee Name"];
  for (const header of nameVariants) {
    it(`recognizes "${header}" as the Name column`, async () => {
      const csv = [`Employee ID,${header}`, "10090296,Person 905"].join("\n");
      const rosterPath = writeCsv(`name-${header.replace(/\s+/g, "_")}.csv`, csv);
      const index = await loadRosterIndex(rosterPath);
      assert.equal(index[0]?.name, "Person 905");
    });
  }

  it("falls back to First Name + Last Name split columns when no combined Name column exists", async () => {
    const csv = ["Employee ID,First Name,Last Name", "10090296,Jane,Doe"].join("\n");
    const rosterPath = writeCsv("split-name.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index[0]?.name, "Person 905");
  });

  it("recognizes First/Last Name headers without an internal space (FirstName/LastName)", async () => {
    const csv = ["Employee ID,FirstName,LastName", "10090296,Jane,Doe"].join("\n");
    const rosterPath = writeCsv("nospace-split-name.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index[0]?.name, "Person 905");
  });

  it("logs a step (no throw) and matches on EID only when there is no Name column at all", async () => {
    const step = vi.spyOn(log, "step").mockImplementation(() => {});
    try {
      const csv = ["Employee ID", "10090296"].join("\n");
      const rosterPath = writeCsv("eid-only.csv", csv);
      const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
      assert.equal(result.matched, 1, "EID-only roster still matches on EID alone");
      assert.ok(
        step.mock.calls.some((c) => String(c[0]).includes("no Name column")),
        "must log that name verification is skipped",
      );
    } finally {
      step.mockRestore();
    }
  });

  it("does not mistake a partial header for an exact Name-column match", async () => {
    // "Name (Legal)" is not one of the exact literals the resolver checks for,
    // so it must NOT resolve as the Name column — pins the strict-equality
    // (not substring) matching for the Name column specifically.
    const csv = ["Employee ID,Name (Legal)", "10090296,Person 905"].join("\n");
    const rosterPath = writeCsv("partial-name-header.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index[0]?.name, "", "an unrecognized Name header must not be read as the name");
  });

  it("prefers the leftmost matching EID header when multiple EID-like columns exist", async () => {
    const csv = ["UCPath ID,Employee ID,Name", "10090296,99999999,Person 905"].join("\n");
    const rosterPath = writeCsv("dupe-eid-cols.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index[0]?.emplId, "10090296", "the first (leftmost) EID-like column wins");
  });
});

describe("verifyBatchAgainstRoster — EID matching", () => {
  it("reports a batch record missing from the roster", async () => {
    const csv = ["Employee ID,Name", "99999999,Someone Else"].join("\n");
    const rosterPath = writeCsv("missing.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 0);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]?.emplId, "10090296");
    assert.equal(result.missing[0]?.batchName, "Person 905");
    assert.equal(result.missing[0]?.sourcePage, 1);
  });

  it("reports a mismatched name for a matching EID (the OCR digit-drift-adjacent case)", async () => {
    const csv = ["Employee ID,Name", "10090296,Ravuti Smith"].join("\n");
    const rosterPath = writeCsv("mismatch.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 0);
    assert.equal(result.mismatched.length, 1);
    assert.deepEqual(result.mismatched[0], {
      emplId: "10090296",
      sourcePage: 1,
      batchName: "Person 905",
      rosterName: "Ravuti Smith",
    });
  });

  it("normalizes EIDs by stripping non-digit characters before comparing", async () => {
    // Roster export sometimes carries a leading apostrophe or dashes.
    const csv = ["Employee ID,Name", "'100-90296,Person 905"].join("\n");
    const rosterPath = writeCsv("dirty-eid.csv", csv);
    const result = await verifyBatchAgainstRoster(makeBatch([makeRecord()]), rosterPath);
    assert.equal(result.matched, 1);
  });

  it("processes multiple records independently (matched + mismatched + missing together)", async () => {
    const csv = [
      "Employee ID,Name",
      "10090296,Person 905", // matches record 1
      "10090219,Someone Wrong", // mismatches record 2
    ].join("\n");
    const rosterPath = writeCsv("multi.csv", csv);
    const batch = makeBatch([
      makeRecord({}, 1),
      makeRecord({ name: "Alice Wrongname", employeeId: "10090219" }, 2),
      makeRecord({ name: "Bob Nowhere", employeeId: "10999999" }, 3),
    ]);
    const result = await verifyBatchAgainstRoster(batch, rosterPath);
    assert.equal(result.matched, 1);
    assert.equal(result.mismatched.length, 1);
    assert.equal(result.mismatched[0]?.sourcePage, 2);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]?.sourcePage, 3);
  });
});

describe("loadRosterIndex — CSV", () => {
  it("builds a flat EID → name index, skipping rows with no usable EID", async () => {
    const csv = ["Employee ID,Name", "10090296,Person 905", ",No EID Here", "10090219,Bob Smith"].join("\n");
    const rosterPath = writeCsv("index.csv", csv);
    const index = await loadRosterIndex(rosterPath);
    assert.equal(index.length, 2);
    assert.deepEqual(
      index.map((r) => r.emplId).sort(),
      ["10090219", "10090296"],
    );
  });
});
