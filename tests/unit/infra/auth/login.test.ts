import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  isAuthenticatedUcpathAppUrl,
  ucpathNavigateAndFill,
} from "../../../../src/infra/auth/login.js";

describe("ucpathNavigateAndFill", () => {
  it("reuses an already-authenticated UCPath page without restarting SSO", async () => {
    const goto = vi.fn(async () => {
      throw new Error("should not navigate away from the warm UCPath page");
    });
    const page = {
      url: () => "https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL",
      goto,
    } as unknown as Page;

    const result = await ucpathNavigateAndFill(page);

    assert.equal(result, "already_logged_in");
    assert.equal(goto.mock.calls.length, 0);
  });
});

describe("isAuthenticatedUcpathAppUrl", () => {
  it("does not treat UCPath SSO, discovery, Duo, or error pages as reusable app sessions", () => {
    assert.equal(
      isAuthenticatedUcpathAppUrl("https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/EMPLOYEE/HRMS"),
      true,
    );
    assert.equal(
      isAuthenticatedUcpathAppUrl("https://ucpath.universityofcalifornia.edu/ucpathdiscovery/disco"),
      false,
    );
    assert.equal(
      isAuthenticatedUcpathAppUrl("https://api-prod.duosecurity.com/frame/prompt?host=universityofcalifornia.edu"),
      false,
    );
    assert.equal(
      isAuthenticatedUcpathAppUrl("https://ucpath.universityofcalifornia.edu/login"),
      false,
    );
    assert.equal(isAuthenticatedUcpathAppUrl("chrome-error://chromewebdata/"), false);
  });
});
