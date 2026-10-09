import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { parseEidList } from "../../../../src/domain/identity/eid.js";

describe("parseEidList (operator-reviewed not-this-person EIDs)", () => {
  test("splits on commas / semicolons / whitespace and trims", () => {
    assert.deepEqual(parseEidList("10090036, 10090189;10090240  10090017"), [
      "10090036",
      "10090189",
      "10090240",
      "10090017",
    ]);
  });

  test("drops malformed tokens instead of widening the override", () => {
    assert.deepEqual(parseEidList("10090036, nope, 123, 10090189x"), ["10090036"]);
  });

  test("de-duplicates", () => {
    assert.deepEqual(parseEidList("10090036,10090036"), ["10090036"]);
  });

  test("non-string / empty input → []", () => {
    assert.deepEqual(parseEidList(undefined), []);
    assert.deepEqual(parseEidList(""), []);
    assert.deepEqual(parseEidList(["10090036"]), []);
  });
});
