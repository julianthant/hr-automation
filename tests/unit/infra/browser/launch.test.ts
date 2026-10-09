import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import {
  gotoWithRetry,
  DEFAULT_NAVIGATION_RETRIES,
} from "../../../../src/infra/browser/launch.js";

/**
 * Minimal fake Page exposing only the surface `gotoWithRetry` touches
 * (`goto`, `waitForLoadState`, `url`, `waitForTimeout`). `gotoBehavior` may
 * throw to simulate a failed navigation; `waitForTimeout` is a no-op counter so
 * the retry delay doesn't slow the test.
 */
function makeFakePage(opts: {
  gotoBehavior: (attempt: number) => void;
  url?: string;
}): { page: Page; gotoCalls: () => number; delayCalls: () => number } {
  let gotoCount = 0;
  let delayCount = 0;
  const page = {
    async goto(_url: string, _o: unknown): Promise<void> {
      gotoCount++;
      opts.gotoBehavior(gotoCount);
    },
    async waitForLoadState(_state: string, _o: unknown): Promise<void> {},
    url(): string {
      return opts.url ?? "https://example.com/";
    },
    async waitForTimeout(_ms: number): Promise<void> {
      delayCount++;
    },
  } as unknown as Page;
  return { page, gotoCalls: () => gotoCount, delayCalls: () => delayCount };
}

describe("gotoWithRetry", () => {
  it("defaults to 10 navigation attempts (operator policy: refresh up to 10×)", () => {
    expect(DEFAULT_NAVIGATION_RETRIES).toBe(10);
  });

  it("retries a navigation TIMEOUT and succeeds on a later attempt (regression: timeouts used to fail on attempt 1)", async () => {
    const { page, gotoCalls, delayCalls } = makeFakePage({
      gotoBehavior: (attempt) => {
        // The exact Playwright/Kuali message that previously was NOT retryable.
        if (attempt < 3) throw new Error("page.goto: Timeout 15000ms exceeded");
      },
    });
    await gotoWithRetry(page, "https://kualibuild.com", undefined, 5, 10);
    expect(gotoCalls()).toBe(3);
    expect(delayCalls()).toBe(2); // one pause before each of the two retries
  });

  it("retries chromium net errors (net::ERR_TIMED_OUT)", async () => {
    const { page, gotoCalls } = makeFakePage({
      gotoBehavior: (attempt) => {
        if (attempt < 2) throw new Error("net::ERR_TIMED_OUT at https://x");
      },
    });
    await gotoWithRetry(page, "https://x", undefined, 5, 10);
    expect(gotoCalls()).toBe(2);
  });

  it("gives up and throws only after exhausting all attempts when the site never loads", async () => {
    const { page, gotoCalls } = makeFakePage({
      gotoBehavior: () => {
        throw new Error("page.goto: Timeout 15000ms exceeded");
      },
    });
    await expect(
      gotoWithRetry(page, "https://down", undefined, 4, 10),
    ).rejects.toThrow(/Timeout/);
    expect(gotoCalls()).toBe(4);
  });

  it("does NOT retry a non-loading error — it escapes on the first attempt", async () => {
    const { page, gotoCalls } = makeFakePage({
      gotoBehavior: () => {
        throw new Error("Some unrelated application bug");
      },
    });
    await expect(
      gotoWithRetry(page, "https://x", undefined, 5, 10),
    ).rejects.toThrow(/unrelated application bug/);
    expect(gotoCalls()).toBe(1);
  });

  it("retries when the post-load verify misses, then passes once the element renders", async () => {
    let verifyCalls = 0;
    const { page, gotoCalls } = makeFakePage({ gotoBehavior: () => {} });
    const verify = async (): Promise<boolean> => {
      verifyCalls++;
      return verifyCalls >= 2; // first load: element absent; second: present
    };
    await gotoWithRetry(page, "https://x", verify, 5, 10);
    expect(gotoCalls()).toBe(2);
  });

  it("treats a chrome-error landing URL as a retryable failure", async () => {
    let attempt = 0;
    const page = {
      async goto(): Promise<void> {
        attempt++;
      },
      async waitForLoadState(): Promise<void> {},
      url(): string {
        // First attempt lands on a chrome-error page; second is clean.
        return attempt < 2 ? "chrome-error://chromewebdata/" : "https://x/";
      },
      async waitForTimeout(): Promise<void> {},
    } as unknown as Page;
    await gotoWithRetry(page, "https://x", undefined, 5, 10);
    expect(attempt).toBe(2);
  });
});
