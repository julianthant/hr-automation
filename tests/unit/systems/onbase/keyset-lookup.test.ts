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
  selectClicks: number;
  /** The Employee Lookup dialog is open; a TAKEN Select Employee click closes it. */
  dialogOpen: boolean;
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
    selectClicks: 0,
    dialogOpen: true,
  };
  // safeClick keys behavior off the label so the fake advances state.
  mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
    if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
      state.selectClicks += 1;
      state.dialogOpen = false; // the click TAKES: dialog closes…
      state.lastName = "Smith"; // …and Select Employee populates the form
    }
  });
  mocks.safeFill.mockResolvedValue(undefined);
  mocks.keywordInput.mockImplementation((_frame: unknown, label: string) => ({
    inputValue: async () => (label === "Last Name" ? state.lastName : ""),
  }));
  // waitFor visible resolves while the dialog is open; waitFor hidden resolves
  // once a taken Select Employee click has closed it (rejects like Playwright's
  // timeout when the click was swallowed and the dialog stayed open).
  mocks.ksDialog.mockReturnValue({
    waitFor: async (opts?: { state?: string }) => {
      if (opts?.state === "hidden" && state.dialogOpen) {
        throw new Error("locator.waitFor: timeout exceeded (dialog still visible)");
      }
    },
  });
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
    expect(state.selectClicks).toBe(1);
    expect(state.lastName).toBe("Smith");
  });

  it("returns 'no-match' and dismisses the dialog when no employee matches", async () => {
    state.noMatch = true; // "No matching records were found"
    const lookup = await loadLookup();
    const result = await lookup(fakePage(), "10883906", 2_000);
    expect(result).toBe("no-match");
    expect(state.selectClicks).toBe(0);
    expect(state.okClicked).toBe(true); // dismissed the no-match alert
    expect(state.closeClicked).toBe(true); // closed the Employee Lookup dialog
  });

  it("throws (kernel-retryable) when the lookup postback stalls — never a false 'no match'", async () => {
    // Neither a match nor a no-match ever appears. A slow cluster must NOT be
    // mislabeled "person not found" (a terminal data error) — it throws so the
    // kernel retries the item on a fresh form.
    const lookup = await loadLookup();
    await expect(lookup(fakePage(), "10408871", 150)).rejects.toThrow(/keyset postback stalled/);
    expect(state.selectClicks).toBe(0);
    expect(state.closeClicked).toBe(true); // dialog still closed before throwing
  });

  it("throws (kernel-retryable) when an employee is selected but keywords never populate", async () => {
    state.selectEnabled = true;
    // Select Employee clicks and the dialog closes, but the import form never
    // receives the keywords.
    mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
      if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
        state.selectClicks += 1;
        state.dialogOpen = false; // lastName stays empty
      }
    });
    const lookup = await loadLookup();
    await expect(lookup(fakePage(), "10408871", 2_000)).rejects.toThrow(
      /keywords did not populate/,
    );
    expect(state.selectClicks).toBe(1);
  });

  it("re-clicks Select Employee when the click is swallowed mid-postback (dialog stays open)", async () => {
    // Live 2026-07-17: the Select Employee click can land while the results
    // grid's async postback is still re-rendering — OnBase swallows it, the
    // dialog stays open with the row still highlighted, and no keyword ever
    // populates. The dialog CLOSING is the proof the selection postback fired,
    // so a still-open dialog gets the same click again.
    state.selectEnabled = true;
    mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
      if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
        state.selectClicks += 1;
        if (state.selectClicks >= 2) {
          state.dialogOpen = false; // the second click takes
          state.lastName = "Smith";
        }
      }
    });
    const lookup = await loadLookup();
    const result = await lookup(fakePage(), "10848084", 2_000);
    expect(result).toBe("selected");
    expect(state.selectClicks).toBe(2);
    expect(state.lastName).toBe("Smith");
  });

  it("throws (kernel-retryable) and closes the dialog when Select Employee never takes", async () => {
    // Every click is swallowed — the dialog never closes. Fail loud (the
    // selection postback never fired) and leave a clean page for the retry.
    state.selectEnabled = true;
    mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
      if (opts?.label === "onbase.keysetLookup.selectEmployeeButton") {
        state.selectClicks += 1; // dialogOpen stays true
      }
    });
    const lookup = await loadLookup();
    await expect(lookup(fakePage(), "10848084", 2_000)).rejects.toThrow(
      /never closed the Employee Lookup dialog/,
    );
    expect(state.selectClicks).toBeGreaterThan(1); // it did re-click before giving up
    expect(state.closeClicked).toBe(true); // clean page for the retry replay
  });
});
