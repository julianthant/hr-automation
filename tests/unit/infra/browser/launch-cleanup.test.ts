import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";

import { launchBrowser } from "../../../../src/infra/browser/launch.js";

describe("launchBrowser staged cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the ephemeral browser when context creation fails", async () => {
    const closeBrowser = vi.fn(async () => undefined);
    vi.spyOn(chromium, "launch").mockResolvedValue({
      newContext: vi.fn(async () => { throw new Error("context failed"); }),
      close: closeBrowser,
    } as never);

    await expect(launchBrowser()).rejects.toThrow("context failed");
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("closes context and browser when ephemeral page creation fails", async () => {
    const order: string[] = [];
    const context = {
      newPage: vi.fn(async () => { throw new Error("page failed"); }),
      close: vi.fn(async () => { order.push("context"); }),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => { order.push("browser"); }),
    };
    vi.spyOn(chromium, "launch").mockResolvedValue(browser as never);

    await expect(launchBrowser()).rejects.toThrow("page failed");
    expect(order).toEqual(["context", "browser"]);
  });

  it("closes a persistent context when selecting its page fails", async () => {
    const closeContext = vi.fn(async () => undefined);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue({
      pages: vi.fn(() => { throw new Error("pages failed"); }),
      close: closeContext,
    } as never);

    await expect(launchBrowser({ sessionDir: "/tmp/profile" })).rejects.toThrow("pages failed");
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
