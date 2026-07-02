import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";

const mocks = vi.hoisted(() => ({
  safeClick: vi.fn(async (_loc: unknown, _opts?: { label?: string; timeout?: number }) => undefined),
  safeFill: vi.fn(async (_loc: unknown, _value?: string, _opts?: { label?: string }) => undefined),
  mainMenuButton: vi.fn(),
  importDocumentMenuItem: vi.fn(),
  ucpathIdInput: vi.fn(),
  frame: vi.fn(),
  queueFrame: vi.fn(),
  queueRemoveButtons: vi.fn(),
}));

const NAV_PANEL = "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx";
const VIEWSTATE_BODY = "<html><body>Validation of viewstate MAC failed.</body></html>";
const CLOSED_BODY =
  "<html><body>It is safe to close this window if it does not close automatically.</body></html>";

interface FakePage extends Page {
  menuVisible: boolean;
  body: string;
  gotoCalls: number;
  queuedDocs: number;
}

/** Fake page whose Main-Menu visibility + body text can flip across a goto. */
function fakePage(opts: {
  menuVisible?: boolean;
  body?: string;
  queuedDocs?: number;
  onGoto?: (p: FakePage) => void;
}): FakePage {
  const page = {
    menuVisible: opts.menuVisible ?? false,
    body: opts.body ?? "<html><body>ok</body></html>",
    gotoCalls: 0,
    queuedDocs: opts.queuedDocs ?? 0,
    url: () => NAV_PANEL,
    title: async () => "OnBase",
    content: async function content(this: FakePage) {
      return this.body;
    },
    frames: function frames(this: FakePage) {
      return [{ content: async () => this.body }];
    },
    on: vi.fn(),
    goto: vi.fn(async function goto(this: FakePage) {
      this.gotoCalls += 1;
      opts.onGoto?.(this);
      return undefined;
    }),
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as FakePage;
  return page;
}

/**
 * Load `openImportDocument` with the `common` helpers + selector registry
 * mocked. Uses resetModules + doMock + dynamic import (the codebase pattern for
 * onbase-login.test.ts) because the vitest single-fork run shares the module
 * registry across files — a top-level `vi.mock` would lose to whichever file
 * imported the real `selectors.js` first.
 */
async function loadOpenImportDocument() {
  vi.resetModules();
  vi.doMock("../../../../src/systems/common/index.js", () => ({
    safeClick: mocks.safeClick,
    safeFill: mocks.safeFill,
  }));
  vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
    onbaseSelectors: {
      nav: {
        mainMenuButton: mocks.mainMenuButton,
        importDocumentMenuItem: mocks.importDocumentMenuItem,
      },
      importForm: {
        frame: mocks.frame,
        ucpathIdInput: mocks.ucpathIdInput,
      },
      documentQueue: {
        frame: mocks.queueFrame,
        removeButtons: mocks.queueRemoveButtons,
      },
    },
  }));
  const { openImportDocument } = await import("../../../../src/systems/onbase/navigate.js");
  return openImportDocument;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Main Menu locator: isVisible reflects the page flag; waitFor is a no-op.
  mocks.mainMenuButton.mockImplementation((page: FakePage) => ({
    isVisible: vi.fn(async () => page.menuVisible),
    waitFor: vi.fn(async () => undefined),
  }));
  // Not visible until the Main Menu is opened (openImportDocument only clicks
  // the launcher when the item isn't already on screen).
  mocks.importDocumentMenuItem.mockImplementation(() => ({
    isVisible: vi.fn(async () => false),
  }));
  // The import iframe + the UCPath ID field the flow waits on after opening.
  mocks.frame.mockImplementation(() => ({}));
  mocks.ucpathIdInput.mockImplementation(() => ({
    waitFor: vi.fn(async () => undefined),
  }));
  // Document Queue: frame passes the page through so removeButtons can read +
  // mutate the page's queuedDocs counter (each Remove click drops one row).
  mocks.queueFrame.mockImplementation((page: FakePage) => page);
  mocks.queueRemoveButtons.mockImplementation((page: FakePage) => ({
    count: async () => page.queuedDocs,
    first: () => ({
      click: async () => {
        page.queuedDocs = Math.max(0, page.queuedDocs - 1);
      },
    }),
  }));
});

describe("openImportDocument recovery", () => {
  it("opens directly when NavPanel already shows the Main Menu", async () => {
    const openImportDocument = await loadOpenImportDocument();
    const page = fakePage({ menuVisible: true });
    await openImportDocument(page);
    expect(page.goto).not.toHaveBeenCalled();
    // Clicked Main Menu then Import Document.
    expect(mocks.safeClick).toHaveBeenCalledTimes(2);
  });

  it("re-navigates NavPanel on a ViewState-MAC error, then opens once recovered", async () => {
    const openImportDocument = await loadOpenImportDocument();
    // Start on the ViewState error page; a fresh goto rebuilds the app.
    const page = fakePage({
      menuVisible: false,
      body: VIEWSTATE_BODY,
      onGoto: (p) => {
        p.menuVisible = true;
        p.body = "<html><body>ok</body></html>";
      },
    });
    await openImportDocument(page);
    expect(page.gotoCalls).toBe(1);
    expect(mocks.safeClick).toHaveBeenCalledTimes(2);
  });

  it("throws (no blind timeout) when the session is closed — kernel retry re-auths", async () => {
    const openImportDocument = await loadOpenImportDocument();
    const page = fakePage({ menuVisible: false, body: CLOSED_BODY });
    await expect(openImportDocument(page)).rejects.toMatchObject({
      name: "OnbasePageStateError",
      state: "session-closed",
    });
    // Session death is unrecoverable here — never burned a re-nav attempt.
    expect(page.goto).not.toHaveBeenCalled();
    expect(mocks.safeClick).not.toHaveBeenCalled();
  });

  it("throws with the real landing state after exhausting fresh-nav attempts", async () => {
    const openImportDocument = await loadOpenImportDocument();
    // ViewState error that never clears across re-navs.
    const page = fakePage({ menuVisible: false, body: VIEWSTATE_BODY });
    await expect(openImportDocument(page)).rejects.toMatchObject({
      name: "OnbasePageStateError",
      state: "viewstate-error",
    });
    expect(page.gotoCalls).toBe(3);
  });

  it("removes document(s) left queued by a failed prior attempt (duplicate-import defense)", async () => {
    const openImportDocument = await loadOpenImportDocument();
    const page = fakePage({ menuVisible: true, queuedDocs: 2 });
    await openImportDocument(page);
    expect(page.queuedDocs).toBe(0);
    expect(mocks.safeClick).toHaveBeenCalledTimes(2); // Main Menu + Import Document only
  });

  it("installs the beforeunload dialog guard on the page", async () => {
    const openImportDocument = await loadOpenImportDocument();
    const page = fakePage({ menuVisible: true });
    await openImportDocument(page);
    const dialogListeners = (page.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === "dialog",
    );
    expect(dialogListeners).toHaveLength(1);
  });

  it("re-clicks an inert Import Document menu item until the form renders (live 2026-07-02 race)", async () => {
    const openImportDocument = await loadOpenImportDocument();
    // First click lands on a visible-but-inert item (handlers not attached yet):
    // the form never renders. The menu stays open, so attempt 2 clicks the item
    // directly (no launcher re-toggle) and the form appears.
    const formWaitFor = vi
      .fn()
      .mockRejectedValueOnce(new Error("Timeout 7000ms exceeded"))
      .mockResolvedValue(undefined);
    mocks.ucpathIdInput.mockImplementation(() => ({ waitFor: formWaitFor }));
    let menuOpened = false;
    mocks.importDocumentMenuItem.mockImplementation(() => ({
      isVisible: vi.fn(async () => menuOpened),
    }));
    mocks.safeClick.mockImplementation(async (_loc: unknown, opts?: { label?: string }) => {
      if (opts?.label === "onbase.nav.mainMenuButton") menuOpened = true;
    });

    const page = fakePage({ menuVisible: true });
    await openImportDocument(page);
    // menu launcher once + the item twice (inert first click, real second).
    expect(mocks.safeClick).toHaveBeenCalledTimes(3);
    expect(formWaitFor).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting menu-click attempts when the form never renders", async () => {
    const openImportDocument = await loadOpenImportDocument();
    mocks.ucpathIdInput.mockImplementation(() => ({
      waitFor: vi.fn(async () => {
        throw new Error("Timeout exceeded");
      }),
    }));
    const page = fakePage({ menuVisible: true });
    await expect(openImportDocument(page)).rejects.toThrow(
      /Import Document form did not render after repeated Main Menu clicks/,
    );
  });
});
