/**
 * Unit tests for `buildReadonlyChecks` and `toReadonlyVerifyRecord` in
 * `src/dashboard/components/ocr/readonly-record.ts`.
 *
 * Specifically covers the 2026-06-06 fix: oath-shaped records re-classified as
 * "emergency-contact" or "unknown" by the model inside a standalone oath run must
 * - show the correct doc-kind (NOT "oath")
 * - NOT show oath signature checks / banner
 * - show checks derivable from the oath shape (name, EID, active status)
 * - include the honest hint line in warnings
 *
 * PII-free synthetic data only.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildReadonlyChecks,
  isOathShapedRecord,
  toReadonlyVerifyRecord,
} from "../../../../src/dashboard/components/ocr/readonly-record.js";
import type { OathPreviewRecord, PreviewRecord } from "../../../../src/dashboard/components/ocr/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeOathRecord(overrides: Partial<OathPreviewRecord> = {}): OathPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Doe, Jane",
    employeeId: "10000001",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "04/23/2026",
    notes: [],
    matchState: "matched",
    selected: true,
    warnings: [],
    ...overrides,
  };
}

function makeEcRecord(overrides: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    formKind: "emergency-contact",
    sourcePage: 1,
    employee: { name: "Lee, Jordan", employeeId: "10000002" },
    emergencyContact: {
      name: "Lee, Robin",
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
    matchState: "matched",
    selected: true,
    warnings: [],
    ...overrides,
  };
}

// ─── buildReadonlyChecks — oath record ────────────────────────────────────────

describe("buildReadonlyChecks — oath-formKind record (normal case)", () => {
  it("returns 6 checks including signature booleans and active status", () => {
    const record = makeOathRecord();
    const checks = buildReadonlyChecks(record);
    const keys = checks.map((c) => c.key);
    assert.ok(keys.includes("employeeSigned"), "must include employeeSigned");
    assert.ok(keys.includes("officerSigned"), "must include officerSigned");
    assert.ok(keys.includes("activeStatus"), "must include activeStatus");
    assert.equal(checks.length, 6);
  });
});

// ─── buildReadonlyChecks — EC-classified oath-shaped record ──────────────────

describe("buildReadonlyChecks — oath-shaped record re-classified as 'emergency-contact'", () => {
  it("returns name + eid + activeStatus checks (no signature checks)", () => {
    const record = makeOathRecord({ formKind: "emergency-contact" });
    const checks = buildReadonlyChecks(record);
    const keys = checks.map((c) => c.key);
    assert.ok(keys.includes("name"), "must include name");
    assert.ok(keys.includes("eid"), "must include eid");
    assert.ok(keys.includes("activeStatus"), "must include activeStatus");
    assert.ok(!keys.includes("employeeSigned"), "must NOT include employeeSigned — no signature checks for non-oath");
    assert.ok(!keys.includes("officerSigned"), "must NOT include officerSigned");
    assert.ok(!keys.includes("dateSigned"), "must NOT include dateSigned");
  });

  it("name check reads from printedName (oath shape, not employee.name)", () => {
    const record = makeOathRecord({ formKind: "emergency-contact", printedName: "Rivera, Sam" });
    const checks = buildReadonlyChecks(record);
    const nameCheck = checks.find((c) => c.key === "name");
    assert.ok(nameCheck, "name check must exist");
    assert.equal(nameCheck?.paperValue, "Rivera, Sam");
  });

  it("eid check reads from employeeId (oath shape)", () => {
    const record = makeOathRecord({ formKind: "emergency-contact", employeeId: "10987654" });
    const checks = buildReadonlyChecks(record);
    const eidCheck = checks.find((c) => c.key === "eid");
    assert.ok(eidCheck, "eid check must exist");
    assert.equal(eidCheck?.paperValue, "10987654");
  });
});

describe("buildReadonlyChecks — oath-shaped record re-classified as 'unknown'", () => {
  it("returns name + eid + activeStatus checks (no signature checks)", () => {
    const record = makeOathRecord({ formKind: "unknown" });
    const checks = buildReadonlyChecks(record);
    const keys = checks.map((c) => c.key);
    assert.ok(keys.includes("name"), "must include name");
    assert.ok(keys.includes("eid"), "must include eid");
    assert.ok(keys.includes("activeStatus"), "must include activeStatus");
    assert.ok(!keys.includes("employeeSigned"), "must NOT include employeeSigned");
    assert.ok(!keys.includes("officerSigned"), "must NOT include officerSigned");
  });
});

// ─── toReadonlyVerifyRecord — honest hint + correct formKind ─────────────────

describe("toReadonlyVerifyRecord — oath-shaped record re-classified as 'emergency-contact'", () => {
  it("projects formKind as 'emergency-contact' (not 'oath')", () => {
    const record = makeOathRecord({ formKind: "emergency-contact" });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "emergency-contact");
  });

  it("includes the honest hint in warnings", () => {
    const record = makeOathRecord({ formKind: "emergency-contact" });
    const vr = toReadonlyVerifyRecord(record);
    const hasHint = vr.warnings.some((w) =>
      w.includes("Emergency Contact") && w.includes("re-run"),
    );
    assert.ok(hasHint, `warnings must include the EC re-run hint — got: ${JSON.stringify(vr.warnings)}`);
  });

  it("does not duplicate the hint when called twice", () => {
    const record = makeOathRecord({ formKind: "emergency-contact" });
    // Simulate two projections of the same record (idempotent)
    const vr1 = toReadonlyVerifyRecord(record);
    // Project again using vr1's warnings as the record's warnings
    const record2 = { ...record, warnings: vr1.warnings };
    const vr2 = toReadonlyVerifyRecord(record2);
    const hintCount = vr2.warnings.filter((w) =>
      w.includes("Emergency Contact") && w.includes("re-run"),
    ).length;
    assert.equal(hintCount, 1, "hint must appear exactly once even after re-projection");
  });

  it("reads name and employeeId from the oath-shape fields", () => {
    const record = makeOathRecord({
      formKind: "emergency-contact",
      printedName: "Kim, Casey",
      employeeId: "10112233",
    });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.name, "Kim, Casey");
    assert.equal(vr.employeeId, "10112233");
  });

  it("checks contain no oath signature entries", () => {
    const record = makeOathRecord({ formKind: "emergency-contact" });
    const vr = toReadonlyVerifyRecord(record);
    const sigKeys = vr.checks.map((c) => c.key).filter((k) =>
      k === "employeeSigned" || k === "officerSigned" || k === "dateSigned",
    );
    assert.deepEqual(sigKeys, [], `no signature checks expected — got: ${JSON.stringify(sigKeys)}`);
  });
});

describe("toReadonlyVerifyRecord — oath-shaped record re-classified as 'unknown'", () => {
  it("projects formKind as 'unknown'", () => {
    const record = makeOathRecord({ formKind: "unknown" });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "unknown");
  });

  it("includes a re-run hint for unknown pages", () => {
    const record = makeOathRecord({ formKind: "unknown" });
    const vr = toReadonlyVerifyRecord(record);
    const hasHint = vr.warnings.some((w) => w.includes("re-run"));
    assert.ok(hasHint, `warnings must include a re-run hint — got: ${JSON.stringify(vr.warnings)}`);
  });

  it("has no signature checks", () => {
    const record = makeOathRecord({ formKind: "unknown" });
    const vr = toReadonlyVerifyRecord(record);
    const sigKeys = vr.checks.map((c) => c.key).filter((k) =>
      k === "employeeSigned" || k === "officerSigned",
    );
    assert.deepEqual(sigKeys, []);
  });
});

// ─── toReadonlyVerifyRecord — genuine oath record unchanged ─────────────────

describe("toReadonlyVerifyRecord — genuine oath record (no regression)", () => {
  it("still produces 6 checks including signatures", () => {
    const record = makeOathRecord();
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "oath");
    assert.equal(vr.checks.length, 6);
    const keys = vr.checks.map((c) => c.key);
    assert.ok(keys.includes("employeeSigned"));
    assert.ok(keys.includes("officerSigned"));
  });

  it("does not add the hint for a genuine oath record", () => {
    const record = makeOathRecord();
    const vr = toReadonlyVerifyRecord(record);
    const hasHint = vr.warnings.some((w) => w.includes("re-run"));
    assert.ok(!hasHint, "no re-run hint for a genuine oath record");
  });
});

// ─── isOathShapedRecord — shape (not classification) test ────────────────────

describe("isOathShapedRecord", () => {
  it("is true for an oath-shaped record regardless of formKind", () => {
    assert.ok(isOathShapedRecord(makeOathRecord()));
    assert.ok(isOathShapedRecord(makeOathRecord({ formKind: "emergency-contact" })));
    assert.ok(isOathShapedRecord(makeOathRecord({ formKind: "unknown" })));
  });

  it("is false for an EC-shaped record regardless of formKind", () => {
    assert.ok(!isOathShapedRecord(makeEcRecord()));
    assert.ok(!isOathShapedRecord(makeEcRecord({ formKind: "oath" })));
    assert.ok(!isOathShapedRecord(makeEcRecord({ formKind: "unknown" })));
  });
});

// ─── F6: EC-RUN mis-classification (the previously-unhandled direction) ──────
// An EC-shaped record (real EC run) re-classified by the model as "oath" or
// "unknown" must now ALSO render an honest wrong-form hint — previously it fell
// through to a plain EC card with no warning (or, for "oath", was never reached
// here because the old code branched on shape-key presence).

describe("buildReadonlyChecks — EC-shaped record re-classified as 'oath'", () => {
  it("returns EC-shape checks (name/eid/ecName/ecRelationship/activeStatus), no oath signatures", () => {
    const record = makeEcRecord({ formKind: "oath" });
    const checks = buildReadonlyChecks(record);
    const keys = checks.map((c) => c.key);
    assert.deepEqual(keys, ["name", "eid", "ecName", "ecRelationship", "activeStatus"]);
    assert.ok(!keys.includes("employeeSigned"), "must NOT show oath signature checks");
  });
});

describe("toReadonlyVerifyRecord — EC-shaped record re-classified as 'oath'", () => {
  it("projects formKind 'oath' and adds the wrong-form hint", () => {
    const record = makeEcRecord({ formKind: "oath" });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "oath");
    const hasHint = vr.warnings.some((w) => w.includes("oath form") && w.includes("re-run"));
    assert.ok(hasHint, `EC-run oath mis-classification must include the hint — got: ${JSON.stringify(vr.warnings)}`);
  });

  it("still reads name/eid from the EC employee shape", () => {
    const record = makeEcRecord({
      formKind: "oath",
      employee: { name: "Nguyen, Taylor", employeeId: "10567890" },
    });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.name, "Nguyen, Taylor");
    assert.equal(vr.employeeId, "10567890");
  });
});

describe("toReadonlyVerifyRecord — EC-shaped record re-classified as 'unknown'", () => {
  it("projects formKind 'unknown' and adds a re-run hint (previously no warning)", () => {
    const record = makeEcRecord({ formKind: "unknown" });
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "unknown");
    const hasHint = vr.warnings.some((w) => w.includes("re-run"));
    assert.ok(hasHint, `EC-run unknown mis-classification must include a re-run hint — got: ${JSON.stringify(vr.warnings)}`);
  });
});

describe("toReadonlyVerifyRecord — genuine EC record (no regression)", () => {
  it("projects formKind 'emergency-contact' and adds NO hint", () => {
    const record = makeEcRecord();
    const vr = toReadonlyVerifyRecord(record);
    assert.equal(vr.formKind, "emergency-contact");
    const hasHint = vr.warnings.some((w) => w.includes("re-run"));
    assert.ok(!hasHint, "no re-run hint for a genuine EC record");
  });
});
