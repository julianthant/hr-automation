import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  classifyOnbasePage,
  isOnbaseForbidden,
  isOnbaseLoginUrl,
  isOnbaseMainMenuReady,
  isOnbaseSessionClosed,
  isOnbaseSessionContention,
  isOnbaseViewstateError,
  onbaseStateNeedsReauth,
  OnbasePageStateError,
  type OnbasePageState,
} from "../../../../src/systems/onbase/page-state.js";

const NAV_PANEL = "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx";
const LOGIN = "https://ucsd.hylandcloud.com/251ids/Login.aspx";

const VIEWSTATE_BODY =
  "<html><body>Validation of viewstate MAC failed. If this application is " +
  "hosted by a Web Farm or cluster, ensure that &lt;machineKey&gt; configuration " +
  "specifies the same validationKey and validation algorithm.</body></html>";
const SESSION_CLOSED_BODY =
  "<html><body>It is safe to close this window if it does not close automatically.</body></html>";
const CONTENTION_FRAME_BODY =
  "<html><body>Another session is currently active. " +
  "Close this session and continue using the active session.</body></html>";

function fakePage(opts: {
  url?: string;
  title?: string;
  content?: string;
  menuVisible?: boolean;
  /** Child-frame contents (the contention marker lives in a nested iframe). */
  frameContents?: string[];
}): Page {
  const {
    url = NAV_PANEL,
    title = "OnBase",
    content = "<html><body>ok</body></html>",
    menuVisible = false,
    frameContents = [],
  } = opts;
  const mainFrame = { content: async () => content };
  const childFrames = frameContents.map((c) => ({ content: async () => c }));
  return {
    url: () => url,
    title: async () => title,
    content: async () => content,
    frames: () => [mainFrame, ...childFrames],
    getByRole: () => ({ isVisible: async () => menuVisible }),
  } as unknown as Page;
}

describe("isOnbaseMainMenuReady", () => {
  it("true when the Main Menu is visible", async () => {
    await expect(isOnbaseMainMenuReady(fakePage({ menuVisible: true }))).resolves.toBe(true);
  });
  it("false (never throws) when the Main Menu is absent", async () => {
    await expect(isOnbaseMainMenuReady(fakePage({ menuVisible: false }))).resolves.toBe(false);
  });
});

describe("isOnbaseViewstateError", () => {
  it("detects the ASP.NET ViewState MAC failure body", async () => {
    await expect(
      isOnbaseViewstateError(fakePage({ content: VIEWSTATE_BODY })),
    ).resolves.toBe(true);
  });
  it("is false for a normal page", async () => {
    await expect(isOnbaseViewstateError(fakePage({}))).resolves.toBe(false);
  });
});

describe("isOnbaseSessionClosed", () => {
  it("detects the logout 'safe to close this window' landing", async () => {
    await expect(
      isOnbaseSessionClosed(fakePage({ content: SESSION_CLOSED_BODY })),
    ).resolves.toBe(true);
  });
  it("is false for a normal page", async () => {
    await expect(isOnbaseSessionClosed(fakePage({}))).resolves.toBe(false);
  });
});

describe("isOnbaseForbidden", () => {
  it("true on a 403 response status", async () => {
    await expect(isOnbaseForbidden(fakePage({}), 403)).resolves.toBe(true);
  });
  it("true on a 403 page title", async () => {
    await expect(
      isOnbaseForbidden(fakePage({ title: "403 - Forbidden: Access is denied." })),
    ).resolves.toBe(true);
  });
  it("false for a normal 200 NavPanel", async () => {
    await expect(isOnbaseForbidden(fakePage({}), 200)).resolves.toBe(false);
  });
});

describe("isOnbaseSessionContention", () => {
  it("detects the contention marker inside a nested child frame", async () => {
    const page = fakePage({ url: LOGIN, frameContents: [CONTENTION_FRAME_BODY] });
    await expect(isOnbaseSessionContention(page)).resolves.toBe(true);
  });
  it("false when no frame carries the marker", async () => {
    await expect(isOnbaseSessionContention(fakePage({ url: LOGIN }))).resolves.toBe(false);
  });
  it("false (never throws) when frames() is unavailable", async () => {
    const page = fakePage({});
    (page as unknown as { frames: unknown }).frames = () => {
      throw new Error("target closed");
    };
    await expect(isOnbaseSessionContention(page)).resolves.toBe(false);
  });
});

describe("isOnbaseLoginUrl", () => {
  it("true on Login.aspx", () => {
    expect(isOnbaseLoginUrl(fakePage({ url: LOGIN }))).toBe(true);
  });
  it("false on NavPanel.aspx", () => {
    expect(isOnbaseLoginUrl(fakePage({ url: NAV_PANEL }))).toBe(false);
  });
});

describe("classifyOnbasePage", () => {
  it("authenticated when the Main Menu is visible — even over an error body", async () => {
    const page = fakePage({ menuVisible: true, content: VIEWSTATE_BODY });
    await expect(classifyOnbasePage(page)).resolves.toBe("authenticated");
  });

  it("forbidden on a 403 response status", async () => {
    await expect(classifyOnbasePage(fakePage({}), 403)).resolves.toBe("forbidden");
  });

  it("forbidden from a 403 page title", async () => {
    const page = fakePage({ title: "403 - Forbidden: Access is denied." });
    await expect(classifyOnbasePage(page)).resolves.toBe("forbidden");
  });

  it("login when redirected to Login.aspx", async () => {
    await expect(classifyOnbasePage(fakePage({ url: LOGIN }))).resolves.toBe("login");
  });

  it("session-contention outranks the Login.aspx URL (the dialog is served there)", async () => {
    const page = fakePage({ url: LOGIN, frameContents: [CONTENTION_FRAME_BODY] });
    await expect(classifyOnbasePage(page)).resolves.toBe("session-contention");
  });

  it("viewstate-error from the ASP.NET MAC failure body", async () => {
    await expect(
      classifyOnbasePage(fakePage({ content: VIEWSTATE_BODY })),
    ).resolves.toBe("viewstate-error");
  });

  it("session-closed from the logout body", async () => {
    await expect(
      classifyOnbasePage(fakePage({ content: SESSION_CLOSED_BODY })),
    ).resolves.toBe("session-closed");
  });

  it("unknown for an unrecognized non-app page (e.g. Document Retrieval reset)", async () => {
    const page = fakePage({ content: "<html><body>Document Retrieval</body></html>" });
    await expect(classifyOnbasePage(page)).resolves.toBe("unknown");
  });
});

describe("onbaseStateNeedsReauth", () => {
  const cases: Array<[OnbasePageState, boolean]> = [
    ["session-closed", true],
    ["login", true],
    ["session-contention", true],
    ["viewstate-error", false],
    ["forbidden", false],
    ["unknown", false],
    ["authenticated", false],
  ];
  for (const [state, expected] of cases) {
    it(`${state} → ${expected}`, () => {
      expect(onbaseStateNeedsReauth(state)).toBe(expected);
    });
  }
});

describe("OnbasePageStateError", () => {
  it("names the state and context, and flags reauth for session death", () => {
    const err = new OnbasePageStateError("session-closed", "openImportDocument");
    expect(err).toBeInstanceOf(Error);
    expect(err.state).toBe("session-closed");
    expect(err.message).toContain("session-closed");
    expect(err.message).toContain("openImportDocument");
    expect(err.message).toContain("re-authentication required");
  });
  it("omits the reauth note for a recoverable state", () => {
    const err = new OnbasePageStateError("viewstate-error", "import");
    expect(err.message).not.toContain("re-authentication required");
  });
});
