import { privateValue } from "../../../../src/private-data.js";
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { parseEidList } from "../../../../src/domain/identity/eid.js";

describe("parseEidList (operator-reviewed not-this-person EIDs)", () => {
  test("splits on commas / semicolons / whitespace and trims", () => {
    assert.deepEqual(parseEidList(privateValue("id:d60c9d756022b15d") + ", " + privateValue("id:56b7368fdb060fa5") + ";10839930  10197468"), [
      privateValue("id:d60c9d756022b15d"),
      privateValue("id:56b7368fdb060fa5"),
      "10839930",
      "10197468",
    ]);
  });

  test("drops malformed tokens instead of widening the override", () => {
    assert.deepEqual(parseEidList(privateValue("id:d60c9d756022b15d") + ", nope, 123, 10743545x"), [privateValue("id:d60c9d756022b15d")]);
  });

  test("de-duplicates", () => {
    assert.deepEqual(parseEidList(privateValue("id:d60c9d756022b15d") + "," + privateValue("id:d60c9d756022b15d")), [privateValue("id:d60c9d756022b15d")]);
  });

  test("non-string / empty input → []", () => {
    assert.deepEqual(parseEidList(undefined), []);
    assert.deepEqual(parseEidList(""), []);
    assert.deepEqual(parseEidList([privateValue("id:d60c9d756022b15d")]), []);
  });
});
