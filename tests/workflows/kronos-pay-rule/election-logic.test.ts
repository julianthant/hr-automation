import { describe, it, expect } from "vitest";
import {
  normalizeElection,
  deriveNewPayRule,
  determinePayRuleAction,
} from "../../../src/workflows/kronos-pay-rule/election-logic.js";

describe("Kronos Pay Rule - Election Logic", () => {
  describe("normalizeElection", () => {
    it("normalizes CASH values", () => {
      expect(normalizeElection("CASH")).toBe("CASH");
      expect(normalizeElection("Cash")).toBe("CASH");
      expect(normalizeElection("cash")).toBe("CASH");
      expect(normalizeElection("Switch to Cash")).toBe("CASH");
      expect(normalizeElection("SWITCH TO CASH")).toBe("CASH");
    });

    it("normalizes CT values", () => {
      expect(normalizeElection("CT")).toBe("CT");
      expect(normalizeElection("ct")).toBe("CT");
      expect(normalizeElection("Comp Time")).toBe("CT");
      expect(normalizeElection("comp time")).toBe("CT");
    });

    it("normalizes NONE values", () => {
      expect(normalizeElection("NONE")).toBe("NONE");
      expect(normalizeElection("None")).toBe("NONE");
      expect(normalizeElection("none")).toBe("NONE");
    });

    it("normalizes blank values", () => {
      expect(normalizeElection("")).toBe("BLANK");
      expect(normalizeElection("   ")).toBe("BLANK");
    });

    it("flags unrecognized values as UNKNOWN — never BLANK (BLANK can trigger a union-default pay change)", () => {
      expect(normalizeElection("Something Else")).toBe("UNKNOWN");
      expect(normalizeElection("switch to comp time")).toBe("UNKNOWN");
      expect(normalizeElection("CTT")).toBe("UNKNOWN");
    });
  });

  describe("deriveNewPayRule", () => {
    it("swaps CT to OT", () => {
      expect(deriveNewPayRule("SX-8Hol-8-CT-30", "OT")).toBe("SX-8Hol-8-OT-30");
      expect(deriveNewPayRule("99-8Hol-40-CT-30", "OT")).toBe("99-8Hol-40-OT-30");
      expect(deriveNewPayRule("K6-8Hol-10Alt-CT-30", "OT")).toBe("K6-8Hol-10Alt-OT-30");
    });

    it("swaps OT to CT", () => {
      expect(deriveNewPayRule("SX-8Hol-8-OT-30", "CT")).toBe("SX-8Hol-8-CT-30");
      expect(deriveNewPayRule("99-8Hol-40-OT-30", "CT")).toBe("99-8Hol-40-CT-30");
      expect(deriveNewPayRule("K6-8Hol-10Alt-OT-30", "CT")).toBe("K6-8Hol-10Alt-CT-30");
    });

    it("throws if swapping to OT but pay rule has no CT", () => {
      expect(() => deriveNewPayRule("SX-8Hol-8-OT-30", "OT")).toThrow(/-CT-/);
    });

    it("throws if swapping to CT but pay rule has no OT", () => {
      expect(() => deriveNewPayRule("SX-8Hol-8-CT-30", "CT")).toThrow(/-OT-/);
    });
  });

  describe("determinePayRuleAction", () => {
    const baseEmployee = {
      employeeName: "Test Employee",
      employeeId: "12345678",
      unionCode: "SX",
      payRuleInUKG: "SX-8Hol-8-CT-30",
      currentElection: "Comp Time",
      newElection: "CASH",
      timekeepingSystem: "UKG",
      alreadyUpdated: "",
    };

    it("skips if not in UKG", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        payRuleInUKG: "N/A - Not in UKG",
      });
      expect(action).toEqual({ action: "skip", reason: "Not in UKG" });
    });

    it("skips if already updated", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        alreadyUpdated: "Yes",
      });
      expect(action).toEqual({ action: "skip", reason: "Already updated" });
    });

    it("skips if pay rule format is not recognized", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        payRuleInUKG: "Unknown-Format",
      });
      expect(action).toMatchObject({ action: "skip", reason: expect.stringMatching(/format not recognized/) });
    });

    it("changes to OT when election is CASH", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        payRuleInUKG: "SX-8Hol-8-CT-30",
        newElection: "CASH",
      });
      expect(action).toMatchObject({
        action: "change",
        currentPayRule: "SX-8Hol-8-CT-30",
        newPayRule: "SX-8Hol-8-OT-30",
        oldCode: "CT",
        newCode: "OT",
      });
    });

    it("changes to CT when election is CT", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        payRuleInUKG: "SX-8Hol-8-OT-30",
        newElection: "Comp Time",
      });
      expect(action).toMatchObject({
        action: "change",
        currentPayRule: "SX-8Hol-8-OT-30",
        newPayRule: "SX-8Hol-8-CT-30",
        oldCode: "OT",
        newCode: "CT",
      });
    });

    it("skips (never defaults) on an unrecognized election value", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        unionCode: "SX", // would default to OT if this were treated as BLANK
        payRuleInUKG: "SX-8Hol-8-CT-30",
        newElection: "switch to comp time",
      });
      expect(action).toMatchObject({
        action: "skip",
        reason: expect.stringMatching(/Unrecognized election value "switch to comp time"/),
      });
    });

    it("skips when election is NONE", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        newElection: "NONE",
      });
      expect(action).toMatchObject({ action: "skip", reason: expect.stringMatching(/Employee elected NONE/) });
    });

    it("skips when current pay rule matches target election", () => {
      const action = determinePayRuleAction({
        ...baseEmployee,
        payRuleInUKG: "SX-8Hol-8-OT-30",
        newElection: "CASH",
      });
      expect(action).toMatchObject({ action: "skip", reason: expect.stringMatching(/Already on OT/) });
    });

    describe("blank elections (defaults)", () => {
      it("defaults to OT for SX", () => {
        const action = determinePayRuleAction({
          ...baseEmployee,
          unionCode: "SX",
          payRuleInUKG: "SX-8Hol-8-CT-30",
          newElection: "",
        });
        expect(action).toMatchObject({
          action: "change",
          newPayRule: "SX-8Hol-8-OT-30",
          oldCode: "CT",
          newCode: "OT",
        });
      });

      it("defaults to OT for CX", () => {
        const action = determinePayRuleAction({
          ...baseEmployee,
          unionCode: "CX",
          payRuleInUKG: "99-8Hol-40-CT-30",
          newElection: "",
        });
        expect(action).toMatchObject({
          action: "change",
          newPayRule: "99-8Hol-40-OT-30",
          oldCode: "CT",
          newCode: "OT",
        });
      });

      it("skips for K6 (previous continues)", () => {
        const action = determinePayRuleAction({
          ...baseEmployee,
          unionCode: "K6",
          payRuleInUKG: "K6-8Hol-8-CT-30",
          newElection: "",
        });
        expect(action).toMatchObject({
          action: "skip",
          reason: expect.stringMatching(/K6 previous election continues/),
        });
      });

      it("skips for RX (previous continues)", () => {
        const action = determinePayRuleAction({
          ...baseEmployee,
          unionCode: "RX",
          payRuleInUKG: "K6-8Hol-8-CT-30", // Just for testing the logic branch
          newElection: "",
        });
        expect(action).toMatchObject({
          action: "skip",
          reason: expect.stringMatching(/RX previous election continues/),
        });
      });
    });
  });
});
