import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { parseEidList } from "../../../../src/domain/identity/eid.js";

describe("parseEidList (operator-reviewed not-this-person EIDs)", () => {
  test("splits on commas / semicolons / whitespace and trims", () => {
    assert.deepEqual(parseEidList("10001072, 10001585;10839930  10197468"), [
      "10001072",
      "10001585",
      "10839930",
      "10197468",
    ]);
  });

  test("drops malformed tokens instead of widening the override", () => {
    assert.deepEqual(parseEidList("10001072, nope, 123, 10743545x"), ["10001072"]);
  });

  test("de-duplicates", () => {
    assert.deepEqual(parseEidList("10001072,10001072"), ["10001072"]);
  });

  test("non-string / empty input → []", () => {
    assert.deepEqual(parseEidList(undefined), []);
    assert.deepEqual(parseEidList(""), []);
    assert.deepEqual(parseEidList(["10001072"]), []);
  });
});
