import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSsn, maskDob, redactPii } from "../../../src/utils/pii.js";

describe("maskSsn", () => {
  it("masks standard dashed form", () => {
    assert.equal(maskSsn("123-45-6789"), "***-**-6789");
  });

  it("masks raw 9-digit form", () => {
    assert.equal(maskSsn("123456789"), "***-**-6789");
  });

  it("strips non-digits before masking", () => {
    assert.equal(maskSsn("123 45 6789"), "***-**-6789");
    assert.equal(maskSsn("(123).45.6789"), "***-**-6789");
  });

  it("falls back to *** when fewer than 4 digits", () => {
    assert.equal(maskSsn("12"), "***");
    assert.equal(maskSsn("abc"), "");
  });

  it("returns '' for empty/null/undefined", () => {
    assert.equal(maskSsn(""), "");
    assert.equal(maskSsn(null), "");
    assert.equal(maskSsn(undefined), "");
  });

  it("keeps only last 4 when input is >9 digits (defensive)", () => {
    assert.equal(maskSsn("12345678901234"), "***-**-1234");
  });
});

describe("maskDob", () => {
  it("masks MM/DD/YYYY preserving year", () => {
    assert.equal(maskDob("01/15/1992"), "**/**/1992");
  });

  it("masks M/D/YYYY preserving year", () => {
    assert.equal(maskDob("1/5/1988"), "**/**/1988");
  });

  it("masks ISO YYYY-MM-DD preserving year", () => {
    assert.equal(maskDob("1992-01-15"), "1992-**-**");
  });

  it("returns '' for empty/null/undefined", () => {
    assert.equal(maskDob(""), "");
    assert.equal(maskDob(null), "");
    assert.equal(maskDob(undefined), "");
  });

  it("runs redactPii fallback for unknown shapes containing date-like substrings", () => {
    // "Born 01/15/1992" contains a DOB-like substring even though the whole
    // input isn't a bare DOB — the generic scrubber catches it.
    assert.equal(maskDob("Born 01/15/1992"), "Born **/**/****");
  });

  it("leaves unknown shapes with no date-like substring intact", () => {
    assert.equal(maskDob("not a date"), "not a date");
  });
});

describe("redactPii", () => {
  it("scrubs SSN inside an error message", () => {
    assert.equal(
      redactPii("SSN 123-45-6789 not found in I9"),
      "SSN ***-**-**** not found in I9"
    );
  });

  it("scrubs raw 9-digit SSN", () => {
    assert.equal(
      redactPii("record 123456789 failed"),
      "record ***-**-**** failed"
    );
  });

  it("scrubs multiple SSNs in one message", () => {
    assert.equal(
      redactPii("compared 111-22-3333 and 444-55-6666"),
      "compared ***-**-**** and ***-**-****"
    );
  });

  it("scrubs MM/DD/YYYY dates", () => {
    assert.equal(
      redactPii("DOB 01/15/1992 in extracted form"),
      "DOB **/**/**** in extracted form"
    );
  });

  it("scrubs ISO dates", () => {
    assert.equal(
      redactPii("born 1992-01-15 confirmed"),
      "born ****-**-** confirmed"
    );
  });

  it("leaves ISO timestamps (with T separator) intact — those are tracker timestamps, not DOBs", () => {
    assert.equal(
      redactPii("ran at 2026-04-17T08:00:00.000Z"),
      "ran at 2026-04-17T08:00:00.000Z"
    );
  });

  it("passes through text with no PII untouched", () => {
    assert.equal(
      redactPii("kuali extraction succeeded"),
      "kuali extraction succeeded"
    );
  });

  it("returns '' for null/undefined", () => {
    assert.equal(redactPii(null), "");
    assert.equal(redactPii(undefined), "");
  });
});
