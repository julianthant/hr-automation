import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
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
