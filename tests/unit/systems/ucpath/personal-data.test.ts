import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isEmergencyContactPrimaryConflictMessage, saveEmergencyContactWithPrimaryRecovery } from "../../../../src/systems/ucpath/personal-data.js";

describe("isEmergencyContactPrimaryConflictMessage", () => {
  it("detects the PeopleSoft primary-contact validation message", () => {
    assert.equal(
      isEmergencyContactPrimaryConflictMessage(
        "Only one emergency contact can be indicated as the primary contact. (1000,110)",
      ),
      true,
    );
  });

  it("detects the error code alone", () => {
    assert.equal(isEmergencyContactPrimaryConflictMessage("Save failed (1000,110)"), true);
  });

  it("does not match unrelated save errors", () => {
    assert.equal(
      isEmergencyContactPrimaryConflictMessage("Session timeout — please sign in again"),
      false,
    );
  });
});


describe("saveEmergencyContactWithPrimaryRecovery", () => {
  it("reads the outer nested Message dialog and demotes row zero when the new contact is row one", async () => {
    let saves = 0;
    let dialogVisible = false;
    const primaries = [true, true];
    const names = ["Sabita Ghimire", "Person 1778"];
    const ok = { isVisible: async () => dialogVisible, click: async () => { dialogVisible = false; } };
    const outer = {
      isVisible: async () => dialogVisible,
      innerText: async () => "Only one emergency contact can be indicated as the primary contact. (1000,110)",
      getByRole: () => ok,
    };
    const duplicateDialogs = {
      first: () => outer,
      isVisible: async () => { throw Error("strict mode: two nested Message dialogs"); },
      getByRole: () => ok,
    };
    const page = {
      locator: (selector: string) => selector === "#ptModTable_0" ? outer : { first: () => ({ isVisible: async () => false }) },
      getByRole: (role: string, options: { name: string }) => {
        if (role === "alertdialog") return duplicateDialogs;
        if (options.name === "Contact Name") return { count: async () => names.length, allInnerTexts: async () => [], nth: (i: number) => ({ inputValue: async () => names[i] }), all: async () => names.map(name => ({ inputValue: async () => name })) };
        if (options.name === "Primary Contact") return { nth: (i: number) => ({ isChecked: async () => primaries[i], uncheck: async () => { primaries[i] = false; } }) };
        if (options.name === "Save") return { first: () => ({ click: async () => { saves++; dialogVisible = primaries.filter(Boolean).length > 1; } }) };
        return { isVisible: async () => false, count: async () => 0 };
      },
      evaluate: async () => undefined,
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
    } as unknown as import("playwright").Page;
    await saveEmergencyContactWithPrimaryRecovery(page, names[1]);
    assert.deepEqual(primaries, [false, true]);
    assert.equal(saves, 2);
  });
});
