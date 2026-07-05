import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { resolve, join } from "path";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { lookupEmployee, clearCache } from "../../../src/workflows/kronos-pay-rule/csv-lookup.js";
import { determinePayRuleAction } from "../../../src/workflows/kronos-pay-rule/election-logic.js";

const FIXTURE_CSV = resolve(
  import.meta.dirname,
  "../../fixtures/kronos-pay-rule/elections-tracker.csv",
);

describe("Kronos Pay Rule - CSV lookup", () => {
  beforeAll(() => {
    process.env.HRAUTO_ELECTIONS_CSV = FIXTURE_CSV;
  });

  afterEach(() => {
    clearCache();
  });

  it("finds an SX employee with blank new election and requires CT→OT change", () => {
    const employee = lookupEmployee("10403587");
    expect(employee).not.toBeNull();
    expect(employee!.unionCode).toBe("SX");
    expect(employee!.payRuleInUKG).toBe("SX-8Hol-8-CT-30");
    expect(employee!.newElection).toBe("");

    const action = determinePayRuleAction(employee!);
    expect(action).toMatchObject({
      action: "change",
      currentPayRule: "SX-8Hol-8-CT-30",
      newPayRule: "SX-8Hol-8-OT-30",
      oldCode: "CT",
      newCode: "OT",
    });
  });

  it("returns null for unknown EID", () => {
    expect(lookupEmployee("99999999")).toBeNull();
  });

  it("fails loud at load when a required exact-key column is missing (renamed header)", () => {
    // A renamed "Pay Rule In UKG if applicable" header would otherwise read ""
    // for every row and silently skip the whole roster as "Not in UKG".
    const dir = mkdtempSync(join(tmpdir(), "kp-csv-"));
    const badCsv = join(dir, "renamed-header.csv");
    writeFileSync(
      badCsv,
      [
        // "Pay Rule In UKG if applicable" renamed; "Currect Election" typo "fixed".
        'Employee Name,Employee ID,Union Code,UKG Pay Rule,Correct Election,"Election eff. 7/1/2026","Timekeeping System updated eff. 7/1/26"',
        "Test Person,10000001,SX,SX-8Hol-8-CT-30,Comp Time,,",
      ].join("\n"),
    );
    const prior = process.env.HRAUTO_ELECTIONS_CSV;
    process.env.HRAUTO_ELECTIONS_CSV = badCsv;
    clearCache();
    try {
      expect(() => lookupEmployee("10000001")).toThrow(/missing required column/);
      expect(() => lookupEmployee("10000001")).toThrow(/Pay Rule In UKG if applicable/);
    } finally {
      process.env.HRAUTO_ELECTIONS_CSV = prior;
      clearCache();
    }
  });
});
