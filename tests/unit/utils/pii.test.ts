import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSsn, maskDob, redactPii } from "../../../src/utils/pii.js";

describe("maskSsn (pass-through)", () => {
  it("returns the SSN unchanged (redaction disabled)", () => {
    assert.equal(maskSsn("123-45-6789"), "123-45-6789");
    assert.equal(maskSsn("123456789"), "123456789");
    assert.equal(maskSsn("123 45 6789"), "123 45 6789");
    assert.equal(maskSsn("(123).45.6789"), "(123).45.6789");
  });

  it("returns '' for empty/null/undefined", () => {
    assert.equal(maskSsn(""), "");
    assert.equal(maskSsn(null), "");
    assert.equal(maskSsn(undefined), "");
  });

  it("coerces non-string inputs via String()", () => {
    // Pass-through preserves input shape (String-coerced).
    assert.equal(maskSsn("12"), "12");
    assert.equal(maskSsn("abc"), "abc");
  });
});

describe("maskDob (pass-through)", () => {
  it("returns the DOB unchanged", () => {
    assert.equal(maskDob("01/15/1992"), "01/15/1992");
    assert.equal(maskDob("1/5/1988"), "1/5/1988");
    assert.equal(maskDob("1992-01-15"), "1992-01-15");
    assert.equal(maskDob("05/11/2007"), "05/11/2007");
    assert.equal(maskDob("2007-05-11"), "2007-05-11");
  });

  it("returns '' for empty/null/undefined", () => {
    assert.equal(maskDob(""), "");
    assert.equal(maskDob(null), "");
    assert.equal(maskDob(undefined), "");
  });

  it("passes through arbitrary strings unchanged", () => {
    assert.equal(maskDob("Born 01/15/1992"), "Born 01/15/1992");
    assert.equal(maskDob("not a date"), "not a date");
  });
});

describe("redactPii (pass-through)", () => {
  it("returns the input unchanged", () => {
    const input = "SSN 123-45-6789 DOB 05/11/2007";
    assert.equal(redactPii(input), input);
  });

  it("leaves SSN-like strings unchanged", () => {
    assert.equal(
      redactPii("SSN 123-45-6789 not found in I9"),
      "SSN 123-45-6789 not found in I9"
    );
    assert.equal(
      redactPii("record 123456789 failed"),
      "record 123456789 failed"
    );
  });

  it("leaves DOB-like strings unchanged", () => {
    assert.equal(
      redactPii("DOB 01/15/1992 in extracted form"),
      "DOB 01/15/1992 in extracted form"
    );
    assert.equal(
      redactPii("born 1992-01-15 confirmed"),
      "born 1992-01-15 confirmed"
    );
  });

  it("leaves ISO timestamps intact", () => {
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

  it("returns '' for null/undefined/empty", () => {
    assert.equal(redactPii(""), "");
    assert.equal(redactPii(null), "");
    assert.equal(redactPii(undefined), "");
  });
});
