import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  isAuthenticatedUcpathAppUrl,
  ucpathNavigateAndFill,
  ucpathSubmitAndWaitForDuo,
} from "../../../../src/infra/auth/login.js";
import { log } from "../../../../src/utils/log.js";

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

  it("does not treat the PeopleSoft expired-session signon URL (?cmd=login / ?cmd=expire) as authenticated", () => {
    // Classic PIA expiry lands on `…/psp/<site>/?cmd=login` — the domain matches
    // and the "/login" PATH exclusion does not match the query-string shape, so
    // without an explicit exclusion a signed-out session reads as warm.
    assert.equal(
      isAuthenticatedUcpathAppUrl("https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/?cmd=login"),
      false,
    );
    assert.equal(
      isAuthenticatedUcpathAppUrl(
        "https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/?cmd=expire&languageCd=ENG",
      ),
      false,
    );
  });
});

describe("ucpathSubmitAndWaitForDuo", () => {
  it("returns true without clicking submit when the stale-form re-prepare reports already_logged_in", async () => {
    // Warm page: no SSO submit button (isSsoFormReady → false), and the URL is
    // an authenticated UCPath app URL, so the re-prepare short-circuits with
    // "already_logged_in". The submit phase must return true — falling through
    // to clickSsoSubmit on a page with NO SSO form is a guaranteed TimeoutError.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const clicks: string[] = [];
    const goto = vi.fn(async () => {
      throw new Error("should not navigate away from the warm UCPath page");
    });
    const page = {
      url: () => "https://ucpath.universityofcalifornia.edu/psp/UCPATHHM/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL",
      goto,
      locator: () => ({
        count: async () => 0, // SSO submit button absent on the warm app page
        click: async () => {
          clicks.push("submit");
          throw new Error("must not click SSO submit on an already-authenticated page");
        },
      }),
      on: () => {},
      off: () => {},
    } as unknown as Page;

    try {
      const ok = await ucpathSubmitAndWaitForDuo(page);
      assert.equal(ok, true, "already_logged_in from the re-prepare must short-circuit as success");
      assert.deepEqual(clicks, [], "no SSO submit attempt on a warm page");
      assert.equal(goto.mock.calls.length, 0, "no re-navigation away from the warm page");
    } finally {
      warn.mockRestore();
    }
  });
});
