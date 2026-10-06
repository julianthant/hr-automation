import type { Page } from "playwright";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  selectWorksite,
  classifyI9CreateSignals,
  isI9PostCreateRoute,
} from "../../../../src/systems/i9/create.js";
import { REMOTE_I9_CREATE_SUCCESS_RE } from "../../../../src/systems/i9/selectors.js";

describe("REMOTE_I9_CREATE_SUCCESS_RE", () => {
  it("accepts only the two exact live production success alerts", () => {
    assert.equal(REMOTE_I9_CREATE_SUCCESS_RE.test("Remote Access Form I-9 email(s) has been sent"), true);
    assert.equal(REMOTE_I9_CREATE_SUCCESS_RE.test("Remote Access Form I-9 message(s) has been sent"), true);
  });

  it("rejects broad legacy phrases and wrapped substrings", () => {
    for (const text of [
      "I-9 successfully created",
      "Section 1 invitation sent",
      "Remote Access Form I-9 email(s) has been sent successfully",
      "Notice: Remote Access Form I-9 email(s) has been sent",
      "",
    ]) {
      assert.equal(REMOTE_I9_CREATE_SUCCESS_RE.test(text), false, text);
    }
  });
});

describe("classifyI9CreateSignals", () => {
  it("gives a visible error precedence over success", () => {
    assert.equal(classifyI9CreateSignals(true, true), "error");
    assert.equal(classifyI9CreateSignals(true, false), "error");
  });

  it("requires a positive success signal", () => {
    assert.equal(classifyI9CreateSignals(false, true), "success");
    assert.equal(classifyI9CreateSignals(false, false), "pending");
  });
});

describe("isI9PostCreateRoute", () => {
  it("accepts the same-profile desktop and mobile callback routes", () => {
    assert.equal(
      isI9PostCreateRoute("https://wwwe.i9complete.com/employee/profile/12345", "12345"),
      true,
    );
    assert.equal(
      isI9PostCreateRoute(
        "https://wwwe.i9complete.com/employee/profile/12345?isNewProfileCreated=true",
        "12345",
      ),
      true,
    );
  });

  it("rejects wrong-profile, pre-create, summary, extra-path, and malformed URLs", () => {
    for (const url of [
      "https://wwwe.i9complete.com/employee/profile/99999",
      "https://wwwe.i9complete.com/employee/profile/12345?saveAndContinue=true",
      "https://wwwe.i9complete.com/form-I9/summary/12345",
      "https://wwwe.i9complete.com/employee/profile/12345/history",
      "https://example.com/employee/profile/12345",
      "not a url",
    ]) {
      assert.equal(isI9PostCreateRoute(url, "12345"), false, url);
    }
  });
});


describe("selectWorksite delayed options", () => {
  it("waits for the requested option before testing uniqueness or selecting it", async () => {
    const events: string[] = [];
    let loaded = false;
    const dropdown = {
      click: async () => { events.push("open"); },
      innerText: async () => "6-000412 HOUSING/DINING",
    };
    const option = {
      first: () => option,
      count: async () => { events.push("count"); return loaded ? 1 : 0; },
      waitFor: async () => { events.push("loaded"); loaded = true; },
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => { events.push("select"); },
    };
    const page = {
      getByRole: (role: string) => role === "listbox" ? dropdown : option,
      keyboard: { press: async () => undefined },
    } as unknown as Page;
    await selectWorksite(page, "000412");
    assert.deepEqual(events, ["open", "loaded", "count", "select"]);
  });
});


describe("selectWorksite identity guards", () => {
  it("rejects malformed department input before opening the dropdown", async () => {
    await assert.rejects(selectWorksite({} as Page, "412"), /Invalid I-9 department/);
  });
  it("refuses a different selected department", async () => {
    const option = { first: () => option, waitFor: async () => undefined, count: async () => 1,
      scrollIntoViewIfNeeded: async () => undefined, click: async () => undefined };
    const dropdown = { click: async () => undefined, innerText: async () => "6-000413 OTHER" };
    const page = { getByRole: (role: string) => role === "listbox" ? dropdown : option,
      keyboard: { press: async () => undefined } } as unknown as Page;
    await assert.rejects(selectWorksite(page, "000412"), /readback does not match department 000412/);
  });
});
