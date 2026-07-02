import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";

/**
 * Pins `lookupEmployeeViaKeyset` — the modal-driven Employee Lookup keyset. The
 * live modal flow (open dialog → fill UCPath ID → Find → Select Employee →
 * import-form keywords populate; or "No matching records") was mapped live
 * 2026-07-02; these tests pin the orchestration/return-value logic
 * deterministically. Uses resetModules + doMock + dynamic import (the codebase
 * pattern) because the vitest single-fork run shares the module registry.
 */

const mocks = vi.hoisted(() => ({
  safeClick: vi.fn(),
  safeFill: vi.fn(),
  // selectors
  importFrame: vi.fn(() => ({})),
  ucpathIdInput: vi.fn(() => ({})),
  keysetApplyButton: vi.fn(() => ({})),
  keywordInput: vi.fn(),
  ksFrame: vi.fn(() => ({})),
  ksDialog: vi.fn(),
  ksUcpathId: vi.fn(() => ({})),
  ksFind: vi.fn(() => ({})),
  ksSelectBtn: vi.fn(),
  ksNoMatch: vi.fn(),
  ksNoMatchOk: vi.fn(),
  ksClose: vi.fn(),
}));

interface KeysetState {
  noMatch: boolean;
  selectEnabled: boolean;
  lastName: string;
  okClicked: boolean;
  closeClicked: boolean;
  selectClicked: boolean;
}

let state: KeysetState;

function fakePage(): Page {
  return { waitForTimeout: async () => undefined } as unknown as Page;
}

async function loadLookup() {
  vi.resetModules();
  vi.doMock("../../../../src/systems/common/index.js", () => ({
    safeClick: mocks.safeClick,
    safeFill: mocks.safeFill,
  }));
  vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
    onbaseSelectors: {
      importForm: {
        frame: mocks.importFrame,
        ucpathIdInput: mocks.ucpathIdInput,
        keysetApplyButton: mocks.keysetApplyButton,
        keywordInput: mocks.keywordInput,
      },
      keysetLookup: {
        frame: mocks.ksFrame,
        dialog: mocks.ksDialog,
        ucpathIdInput: mocks.ksUcpathId,
        findButton: mocks.ksFind,
        selectEmployeeButton: mocks.ksSelectBtn,
        noMatchMessage: mocks.ksNoMatch,
        noMatchOkButton: mocks.ksNoMatchOk,
        closeButton: mocks.ksClose,
      },
    },
  }));
  const { lookupEmployeeViaKeyset } = await import(
    "../../../../src/systems/onbase/navigate.js"
  );
  return lookupEmployeeViaKeyset;
}

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    noMatch: false,
    selectEnabled: false,
    lastName: "",
    okClicked: false,
    closeClicked: false,
    selectClicked: false,
  };
  // safeClick keys behavior off the label so the fake advances state.
  mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
    if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
      state.selectClicked = true;
      state.lastName = "Smith"; // Select Employee populates the form
    }
  });
  mocks.safeFill.mockResolvedValue(undefined);
  mocks.keywordInput.mockImplementation((_frame: unknown, label: string) => ({
    inputValue: async () => (label === "Last Name" ? state.lastName : ""),
  }));
  mocks.ksDialog.mockReturnValue({ waitFor: async () => undefined });
  mocks.ksSelectBtn.mockReturnValue({ isEnabled: async () => state.selectEnabled });
  mocks.ksNoMatch.mockReturnValue({ isVisible: async () => state.noMatch });
  mocks.ksNoMatchOk.mockReturnValue({ click: async () => { state.okClicked = true; } });
  mocks.ksClose.mockReturnValue({ click: async () => { state.closeClicked = true; } });
});

describe("lookupEmployeeViaKeyset", () => {
  it("returns 'selected' and populates keywords when Employee Lookup matches", async () => {
    state.selectEnabled = true; // a match auto-selects a row → Select Employee enables
    const lookup = await loadLookup();
    const result = await lookup(fakePage(), "10408871", 2_000);
    expect(result).toBe("selected");
    expect(state.selectClicked).toBe(true);
    expect(state.lastName).toBe("Smith");
  });

  it("returns 'no-match' and dismisses the dialog when no employee matches", async () => {
    state.noMatch = true; // "No matching records were found"
    const lookup = await loadLookup();
    const result = await lookup(fakePage(), "10883906", 2_000);
    expect(result).toBe("no-match");
    expect(state.selectClicked).toBe(false);
    expect(state.okClicked).toBe(true); // dismissed the no-match alert
    expect(state.closeClicked).toBe(true); // closed the Employee Lookup dialog
  });

  it("throws (kernel-retryable) when the lookup postback stalls — never a false 'no match'", async () => {
    // Neither a match nor a no-match ever appears. A slow cluster must NOT be
    // mislabeled "person not found" (a terminal data error) — it throws so the
    // kernel retries the item on a fresh form.
    const lookup = await loadLookup();
    await expect(lookup(fakePage(), "10408871", 150)).rejects.toThrow(/keyset postback stalled/);
    expect(state.selectClicked).toBe(false);
    expect(state.closeClicked).toBe(true); // dialog still closed before throwing
  });

  it("throws (kernel-retryable) when an employee is selected but keywords never populate", async () => {
    state.selectEnabled = true;
    // Select Employee clicks, but the import form never receives the keywords.
    mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
      if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
        state.selectClicked = true; // lastName stays empty
      }
    });
    const lookup = await loadLookup();
    await expect(lookup(fakePage(), "10408871", 2_000)).rejects.toThrow(
      /keywords did not populate/,
    );
    expect(state.selectClicked).toBe(true);
  });
});
