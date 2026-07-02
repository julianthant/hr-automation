import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";

const mocks = vi.hoisted(() => ({
  clickSsoSubmit: vi.fn(),
  fillSsoCredentials: vi.fn(),
  isSsoFormReady: vi.fn(),
  mainMenuButton: vi.fn(),
  pollDuoApproval: vi.fn(),
  requestDuoApproval: vi.fn(),
  waitForSsoForm: vi.fn(),
}));

vi.mock("../../../../src/systems/onbase/selectors.js", () => ({
  onbaseSelectors: {
    nav: {
      mainMenuButton: mocks.mainMenuButton,
    },
  },
}));

vi.mock("../../../../src/infra/auth/sso-fields.js", () => ({
  clickSsoSubmit: mocks.clickSsoSubmit,
  fillSsoCredentials: mocks.fillSsoCredentials,
  isSsoFormReady: mocks.isSsoFormReady,
  waitForSsoForm: mocks.waitForSsoForm,
}));

vi.mock("../../../../src/infra/auth/duo-poll.js", () => ({
  pollDuoApproval: mocks.pollDuoApproval,
}));

vi.mock("../../../../src/tracker/sessions/duo-queue.js", () => ({
  requestDuoApproval: mocks.requestDuoApproval,
}));

import { onbaseSelectors } from "../../../../src/systems/onbase/selectors.js";

interface FakeOnbasePage extends Page {
  forbiddenTitle: boolean;
  viewstateBody: boolean;
  menuVisible: boolean;
  reloadCalls: number;
  /** True while the single-session contention dialog is showing (nested frame). */
  contentionFrame: boolean;
  /** Set once Logout.aspx has been visited (clears the stale app session). */
  loggedOut: boolean;
  gotoUrls: string[];
}

const VIEWSTATE_BODY =
  "<html><body>Validation of viewstate MAC failed.</body></html>";
const CONTENTION_FRAME_BODY =
  "<html><body>Another session is currently active.</body></html>";

function fakeOnbasePage(): FakeOnbasePage {
  const page = {
    forbiddenTitle: false,
    viewstateBody: false,
    menuVisible: false,
    reloadCalls: 0,
    contentionFrame: false,
    loggedOut: false,
    gotoUrls: [] as string[],
    url: vi.fn(() => "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx"),
    getByRole: vi.fn(function getByRole(this: FakeOnbasePage) {
      return {
        isVisible: vi.fn(async () => this.menuVisible),
      };
    }),
    // Logout.aspx terminates the stale app session (contention clears);
    // Login.aspx after a logout rides the still-valid IdP session straight
    // back to an authenticated NavPanel — mirrors the live behavior captured
    // 2026-07-02.
    goto: vi.fn(async function goto(this: FakeOnbasePage, url: string) {
      this.gotoUrls.push(url);
      if (url.includes("Logout.aspx")) {
        this.contentionFrame = false;
        this.loggedOut = true;
      } else if (url.includes("Login.aspx") && this.loggedOut) {
        this.menuVisible = true;
      }
      return undefined;
    }),
    reload: vi.fn(async function reload(this: FakeOnbasePage) {
      this.reloadCalls += 1;
      this.forbiddenTitle = false;
      this.viewstateBody = false;
      this.menuVisible = true;
      return undefined;
    }),
    title: vi.fn(async function title(this: FakeOnbasePage) {
      return this.forbiddenTitle ? "403 - Forbidden: Access is denied." : "OnBase";
    }),
    content: vi.fn(async function content(this: FakeOnbasePage) {
      return this.viewstateBody ? VIEWSTATE_BODY : "<html><body>ok</body></html>";
    }),
    frames: function frames(this: FakeOnbasePage) {
      const main = { content: async () => "<html><body>ok</body></html>" };
      return this.contentionFrame
        ? [main, { content: async () => CONTENTION_FRAME_BODY }]
        : [main];
    },
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as FakeOnbasePage;

  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSsoFormReady.mockResolvedValue(true);
  mocks.waitForSsoForm.mockResolvedValue(true);
  mocks.fillSsoCredentials.mockResolvedValue(undefined);
  mocks.clickSsoSubmit.mockResolvedValue(undefined);
  mocks.mainMenuButton.mockImplementation((page: FakeOnbasePage) => ({
    isVisible: vi.fn(async () => page.menuVisible),
  }));
});

/** Mirrors the authenticated probe in login.ts — kept in sync via behavior pins. */
async function probeOnbaseAuthenticated(page: Page): Promise<boolean> {
  if (page.url().includes("Login.aspx")) return false;
  return onbaseSelectors.nav
    .mainMenuButton(page)
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
}

describe("OnBase authenticated probe", () => {
  it("treats Login.aspx as unauthenticated even on hylandcloud.com", async () => {
    const page = {
      url: () => "https://ucsd.hylandcloud.com/251ids/Login.aspx",
    } as Page;

    await expect(probeOnbaseAuthenticated(page)).resolves.toBe(false);
    expect(onbaseSelectors.nav.mainMenuButton).not.toHaveBeenCalled();
  });

  it("requires Main Menu visibility on NavPanel, not hostname alone", async () => {
    const isVisible = vi.fn().mockResolvedValue(true);
    vi.mocked(onbaseSelectors.nav.mainMenuButton).mockReturnValue({
      isVisible,
    } as never);

    const page = {
      url: () => "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx",
    } as Page;

    await expect(probeOnbaseAuthenticated(page)).resolves.toBe(true);
    expect(isVisible).toHaveBeenCalledWith({ timeout: 5_000 });
  });

  it("returns false when NavPanel loads without Main Menu (expired session hop)", async () => {
    const isVisible = vi.fn().mockRejectedValue(new Error("not visible"));
    vi.mocked(onbaseSelectors.nav.mainMenuButton).mockReturnValue({
      isVisible,
    } as never);

    const page = {
      url: () => "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx",
    } as Page;

    await expect(probeOnbaseAuthenticated(page)).resolves.toBe(false);
  });
});

describe("loginToOnBase", () => {
  it("reloads a post-Duo NavPanel 403 before accepting OnBase auth", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
      onbaseSelectors: {
        nav: {
          mainMenuButton: mocks.mainMenuButton,
        },
      },
    }));
    vi.doMock("../../../../src/infra/auth/sso-fields.js", () => ({
      clickSsoSubmit: mocks.clickSsoSubmit,
      fillSsoCredentials: mocks.fillSsoCredentials,
      isSsoFormReady: mocks.isSsoFormReady,
      waitForSsoForm: mocks.waitForSsoForm,
    }));
    vi.doMock("../../../../src/infra/auth/duo-poll.js", () => ({
      pollDuoApproval: mocks.pollDuoApproval,
    }));
    vi.doMock("../../../../src/tracker/sessions/duo-queue.js", () => ({
      requestDuoApproval: mocks.requestDuoApproval,
    }));
    const page = fakeOnbasePage();
    mocks.pollDuoApproval.mockImplementation(async (p: FakeOnbasePage, options) => {
      p.forbiddenTitle = true;
      return options.successCheck(p);
    });
    const { loginToOnBase } = await import("../../../../src/infra/auth/login.js");

    await expect(loginToOnBase(page)).resolves.toBe(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.reloadCalls).toBe(1);
  });

  it("reloads a post-Duo NavPanel ViewState-MAC error before accepting OnBase auth", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
      onbaseSelectors: {
        nav: {
          mainMenuButton: mocks.mainMenuButton,
        },
      },
    }));
    vi.doMock("../../../../src/infra/auth/sso-fields.js", () => ({
      clickSsoSubmit: mocks.clickSsoSubmit,
      fillSsoCredentials: mocks.fillSsoCredentials,
      isSsoFormReady: mocks.isSsoFormReady,
      waitForSsoForm: mocks.waitForSsoForm,
    }));
    vi.doMock("../../../../src/infra/auth/duo-poll.js", () => ({
      pollDuoApproval: mocks.pollDuoApproval,
    }));
    vi.doMock("../../../../src/tracker/sessions/duo-queue.js", () => ({
      requestDuoApproval: mocks.requestDuoApproval,
    }));
    const page = fakeOnbasePage();
    mocks.pollDuoApproval.mockImplementation(async (p: FakeOnbasePage, options) => {
      p.viewstateBody = true;
      return options.successCheck(p);
    });
    const { loginToOnBase } = await import("../../../../src/infra/auth/login.js");

    await expect(loginToOnBase(page)).resolves.toBe(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.reloadCalls).toBe(1);
  });

  it("clears a pre-SSO session contention via Logout.aspx and rides the IdP session in (no SSO)", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
      onbaseSelectors: {
        nav: {
          mainMenuButton: mocks.mainMenuButton,
        },
      },
    }));
    vi.doMock("../../../../src/infra/auth/sso-fields.js", () => ({
      clickSsoSubmit: mocks.clickSsoSubmit,
      fillSsoCredentials: mocks.fillSsoCredentials,
      isSsoFormReady: mocks.isSsoFormReady,
      waitForSsoForm: mocks.waitForSsoForm,
    }));
    vi.doMock("../../../../src/infra/auth/duo-poll.js", () => ({
      pollDuoApproval: mocks.pollDuoApproval,
    }));
    vi.doMock("../../../../src/tracker/sessions/duo-queue.js", () => ({
      requestDuoApproval: mocks.requestDuoApproval,
    }));
    const page = fakeOnbasePage();
    // Another (stale) session holds the single app-session slot: the landing
    // shows the abort-only contention dialog instead of the SSO form.
    page.contentionFrame = true;
    mocks.isSsoFormReady.mockResolvedValue(false);
    const { loginToOnBase } = await import("../../../../src/infra/auth/login.js");

    await expect(loginToOnBase(page)).resolves.toBe(true);
    expect(page.gotoUrls.some((u) => u.includes("Logout.aspx"))).toBe(true);
    expect(page.gotoUrls.some((u) => u.includes("Login.aspx"))).toBe(true);
    // The IdP session carried us straight in — no SSO fill/submit, no Duo.
    expect(mocks.fillSsoCredentials).not.toHaveBeenCalled();
    expect(mocks.pollDuoApproval).not.toHaveBeenCalled();
  });

  it("recovers a post-Duo session contention via the Logout.aspx hop in the success check", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/systems/onbase/selectors.js", () => ({
      onbaseSelectors: {
        nav: {
          mainMenuButton: mocks.mainMenuButton,
        },
      },
    }));
    vi.doMock("../../../../src/infra/auth/sso-fields.js", () => ({
      clickSsoSubmit: mocks.clickSsoSubmit,
      fillSsoCredentials: mocks.fillSsoCredentials,
      isSsoFormReady: mocks.isSsoFormReady,
      waitForSsoForm: mocks.waitForSsoForm,
    }));
    vi.doMock("../../../../src/infra/auth/duo-poll.js", () => ({
      pollDuoApproval: mocks.pollDuoApproval,
    }));
    vi.doMock("../../../../src/tracker/sessions/duo-queue.js", () => ({
      requestDuoApproval: mocks.requestDuoApproval,
    }));
    const page = fakeOnbasePage();
    mocks.pollDuoApproval.mockImplementation(async (p: FakeOnbasePage, options) => {
      // Post-Duo the slot is still held: contention dialog instead of NavPanel.
      p.contentionFrame = true;
      return options.successCheck(p);
    });
    const { loginToOnBase } = await import("../../../../src/infra/auth/login.js");

    await expect(loginToOnBase(page)).resolves.toBe(true);
    expect(page.gotoUrls.some((u) => u.includes("Logout.aspx"))).toBe(true);
    expect(page.menuVisible).toBe(true);
  });
});
