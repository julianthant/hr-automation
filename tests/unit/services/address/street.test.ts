import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  composeResolvedStreet,
  extractUnitSuffix,
  extractUnitTokens,
  isSafeStreetReplacement,
  parseHouseNumber,
} from "../../../../src/services/address/street.js";

describe("parseHouseNumber", () => {
  test("reads the leading house number", () => {
    assert.equal(parseHouseNumber("3449 Invicta Way"), "3449");
  });

  test("keeps a letter suffix and a hyphenated number", () => {
    assert.equal(parseHouseNumber("12B Baker St"), "12B");
    assert.equal(parseHouseNumber("123-45 Queens Blvd"), "123-45");
  });

  test("returns null when the street has no leading number", () => {
    assert.equal(parseHouseNumber("Market Street"), null);
    assert.equal(parseHouseNumber(""), null);
    assert.equal(parseHouseNumber(null), null);
  });

  test("does not read a number embedded later in the line", () => {
    assert.equal(parseHouseNumber("Apt 1208 Market St"), null);
  });
});

describe("extractUnitTokens", () => {
  test("detects common secondary designators", () => {
    assert.deepEqual(extractUnitTokens("1177 Market St. Apt 1208"), ["apt1208"]);
    assert.deepEqual(extractUnitTokens("500 Main St Unit B"), ["unitb"]);
    assert.deepEqual(extractUnitTokens("500 Main St Ste. 200"), ["ste200"]);
    assert.deepEqual(extractUnitTokens("500 Main St #4"), ["4"]);
  });

  test("returns an empty list for a plain street", () => {
    assert.deepEqual(extractUnitTokens("3449 Invicta Way"), []);
  });

  test("does not false-positive on a street name that merely starts with a keyword", () => {
    assert.deepEqual(extractUnitTokens("123 Flower St"), []);
    assert.deepEqual(extractUnitTokens("123 Unity Ave"), []);
  });
});

describe("extractUnitSuffix", () => {
  test("returns the trailing unit portion verbatim", () => {
    assert.equal(extractUnitSuffix("1177 Market St. Apt 1208"), "Apt 1208");
    assert.equal(extractUnitSuffix("500 Main St, #4"), "#4");
  });

  test("returns null when there is no unit", () => {
    assert.equal(extractUnitSuffix("3449 Invicta Way"), null);
  });
});

describe("composeResolvedStreet", () => {
  test("puts the original's house number and unit around the geocoder's street name", () => {
    assert.equal(
      composeResolvedStreet("1177 Market St. Apt 1208", "Market St"),
      "1177 Market St Apt 1208",
    );
  });

  test("applies a street-name correction while keeping the house number", () => {
    assert.equal(composeResolvedStreet("12677 Candlewood In", "Candlewood Ln"), "12677 Candlewood Ln");
  });

  test("never invents a house number the original lacked", () => {
    assert.equal(composeResolvedStreet("Market St", "Market St"), "Market St");
  });

  test("returns empty when the geocoder supplied no street name", () => {
    assert.equal(composeResolvedStreet("1177 Market St", "  "), "");
  });
});

describe("isSafeStreetReplacement", () => {
  test("accepts a pure street-name/suffix correction", () => {
    assert.equal(isSafeStreetReplacement("12677 Candlewood In", "12677 Candlewood Ln"), true);
  });

  test("rejects a changed house number", () => {
    assert.equal(isSafeStreetReplacement("3449 Invicta Way", "3429 Invicta Way"), false);
  });

  test("rejects a dropped unit", () => {
    assert.equal(isSafeStreetReplacement("1177 Market St Apt 1208", "1177 Market St"), false);
  });

  test("rejects a house number added to a street that had none", () => {
    assert.equal(isSafeStreetReplacement("Market St", "1101 Market St"), false);
  });

  test("rejects an empty candidate", () => {
    assert.equal(isSafeStreetReplacement("1177 Market St", ""), false);
  });

  test("accepts a candidate that keeps house number and unit", () => {
    assert.equal(isSafeStreetReplacement("1177 Market St. Apt 1208", "1177 Market Street Apt 1208"), true);
  });
});
