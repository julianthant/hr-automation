import { test } from "vitest";
import assert from "node:assert/strict";
import {
  diffAddressFields,
  formatAddressOneLine,
  hasResolvableStreet,
  isLikelyUsAddress,
  normalizeCountryHint,
} from "../../../../src/services/address/format.js";
import { geocodeWithCensus } from "../../../../src/services/address/census.js";
import { geocodeWithNominatim } from "../../../../src/services/address/nominatim.js";
import { resolveAddress } from "../../../../src/services/address/index.js";
import { __resetNominatimRateLimitForTests } from "../../../../src/services/address/rate-limit.js";

test("isLikelyUsAddress detects US hints", () => {
  assert.equal(isLikelyUsAddress({ street: "1 Main", state: "CA" }), true);
  assert.equal(isLikelyUsAddress({ street: "1 Main", zip: "92101" }), true);
  assert.equal(isLikelyUsAddress({ street: "1 Main", country: "US" }), true);
  assert.equal(isLikelyUsAddress({ street: "1 Main", country: "CN" }), false);
});

test("normalizeCountryHint maps common names to ISO codes", () => {
  assert.equal(normalizeCountryHint("china"), "CN");
  assert.equal(normalizeCountryHint("CN"), "CN");
  assert.equal(normalizeCountryHint("United Kingdom"), "GB");
});

test("hasResolvableStreet requires a meaningful query line", () => {
  assert.equal(hasResolvableStreet({ street: "123 Main St, San Diego, CA" }), true);
  assert.equal(hasResolvableStreet({ street: "x" }), false);
});

test("diffAddressFields lists changed components only", () => {
  const changes = diffAddressFields(
    { street: "123 main st", city: "san diego", state: "ca", zip: "92101" },
    { street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
  );
  assert.equal(changes.length, 3);
});

test("geocodeWithCensus maps a Census match", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        result: {
          addressMatches: [{
            matchedAddress: "123 MAIN ST, SAN DIEGO, CA, 92173",
            addressComponents: {
              fromAddress: "123",
              streetName: "MAIN",
              suffixType: "ST",
              city: "SAN DIEGO",
              state: "CA",
              zip: "92173",
            },
          }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const result = await geocodeWithCensus(
    { street: "123 main st", city: "san diego", state: "ca" },
    fetchImpl as typeof fetch,
  );
  assert.ok(result);
  assert.equal(result!.source, "census");
  assert.equal(result!.address.state, "CA");
  assert.equal(result!.address.city, "San Diego");
  assert.match(result!.address.street, /123 Main/i);
});

// ─── House-number / unit preservation (2026-07-13 corruption regression) ──────
// Census `addressComponents.fromAddress`/`toAddress` are the TIGER block address
// RANGE, not the matched house number — using them REWROTE the operator's OCR'd
// street to a different building. These pins hold the line.

function censusResponse(matchedAddress: string, components: Record<string, string>) {
  return async () =>
    new Response(
      JSON.stringify({
        result: { addressMatches: [{ matchedAddress, addressComponents: components }] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as unknown as Response;
}

test("geocodeWithCensus keeps the input house number when it differs from the TIGER block range", async () => {
  const fetchImpl = censusResponse("3449 INVICTA WAY, SAN DIEGO, CA, 92154", {
    fromAddress: "3401",
    toAddress: "3499",
    streetName: "INVICTA",
    suffixType: "WAY",
    city: "SAN DIEGO",
    state: "CA",
    zip: "92154",
  });

  const result = await geocodeWithCensus(
    { street: "3449 invicta way", city: "san diego", state: "CA", zip: "92154" },
    fetchImpl as unknown as typeof fetch,
  );

  assert.ok(result);
  assert.equal(result!.address.street, "3449 Invicta Way");
});

test("geocodeWithCensus preserves an apartment designator Census components omit", async () => {
  const fetchImpl = censusResponse("1177 MARKET ST, SAN FRANCISCO, CA, 94103", {
    fromAddress: "1101",
    toAddress: "1199",
    streetName: "MARKET",
    suffixType: "ST",
    city: "SAN FRANCISCO",
    state: "CA",
    zip: "94103",
  });

  const result = await geocodeWithCensus(
    { street: "1177 Market St. Apt 1208", city: "San Francisco", state: "CA", zip: "94103" },
    fetchImpl as unknown as typeof fetch,
  );

  assert.ok(result);
  assert.match(result!.address.street, /^1177 Market St/i);
  assert.match(result!.address.street, /Apt 1208/i);
});

test("geocodeWithCensus still corrects the street name/suffix while keeping the house number", async () => {
  const fetchImpl = censusResponse("12677 CANDLEWOOD LN, SAN DIEGO, CA, 92128", {
    fromAddress: "12601",
    toAddress: "12699",
    streetName: "CANDLEWOOD",
    suffixType: "LN",
    city: "SAN DIEGO",
    state: "CA",
    zip: "92128",
  });

  const result = await geocodeWithCensus(
    { street: "12677 Candlewood In", city: "San Diego", state: "CA", zip: "92128" },
    fetchImpl as unknown as typeof fetch,
  );

  assert.ok(result);
  assert.equal(result!.address.street, "12677 Candlewood Ln");
});

test("geocodeWithCensus does not claim exact confidence when the matched house number differs", async () => {
  const fetchImpl = censusResponse("3429 INVICTA WAY, SAN DIEGO, CA, 92154", {
    fromAddress: "3401",
    toAddress: "3499",
    streetName: "INVICTA",
    suffixType: "WAY",
    city: "SAN DIEGO",
    state: "CA",
    zip: "92154",
  });

  const result = await geocodeWithCensus(
    { street: "3449 invicta way", city: "san diego", state: "CA", zip: "92154" },
    fetchImpl as unknown as typeof fetch,
  );

  assert.ok(result);
  assert.notEqual(result!.confidence, "exact");
  assert.equal(result!.address.street, "3449 Invicta Way");
});

test("geocodeWithNominatim maps international OSM results", async () => {
  __resetNominatimRateLimitForTests();
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([{
        display_name: "10 Downing Street, Westminster, London, SW1A 2AA, United Kingdom",
        importance: 0.6,
        address: {
          house_number: "10",
          road: "Downing Street",
          city: "London",
          state: "England",
          postcode: "SW1A 2AA",
          country_code: "gb",
        },
      }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const result = await geocodeWithNominatim(
    { street: "10 Downing St", city: "London", country: "GB" },
    fetchImpl as typeof fetch,
  );
  assert.ok(result);
  assert.equal(result!.source, "nominatim");
  assert.equal(result!.address.country, "GB");
  assert.equal(result!.address.zip, "SW1A 2AA");
  assert.equal(result!.confidence, "exact");
});

test("geocodeWithNominatim keeps the input house number and unit", async () => {
  __resetNominatimRateLimitForTests();
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([{
        display_name: "1177, Market Street, San Francisco, CA, 94103, United States",
        importance: 0.6,
        address: {
          house_number: "1101",
          road: "Market Street",
          city: "San Francisco",
          state: "California",
          postcode: "94103",
          country_code: "us",
        },
      }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const result = await geocodeWithNominatim(
    { street: "1177 Market St. Apt 1208", city: "San Francisco", state: "CA", zip: "94103" },
    fetchImpl as typeof fetch,
  );

  assert.ok(result);
  assert.match(result!.address.street, /^1177 Market Street/i);
  assert.match(result!.address.street, /Apt 1208/i);
});

test("resolveAddress uses Census for US then falls back to Nominatim", async () => {
  __resetNominatimRateLimitForTests();
  let call = 0;
  const fetchImpl = async (url: string | URL | Request) => {
    call += 1;
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("geocoding.geo.census.gov")) {
      return new Response(JSON.stringify({ result: { addressMatches: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify([{
        display_name: "9500 Gilman Drive, San Diego, CA 92093",
        importance: 0.55,
        address: {
          house_number: "9500",
          road: "Gilman Drive",
          city: "San Diego",
          state: "California",
          postcode: "92093",
          country_code: "us",
        },
      }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await resolveAddress(
    { street: "9500 Gilman Dr", city: "La Jolla", state: "CA", zip: "92093" },
    { fetch: fetchImpl as typeof fetch },
  );
  assert.ok(result);
  assert.equal(call, 2);
  assert.equal(result!.source, "nominatim");
  assert.equal(result!.address.zip, "92093");
});

test("resolveAddress skips international through Census", async () => {
  __resetNominatimRateLimitForTests();
  let censusCalled = false;
  const fetchImpl = async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("geocoding.geo.census.gov")) {
      censusCalled = true;
      return new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 });
    }
    return new Response(
      JSON.stringify([{
        display_name: "No. 1, Zhongguancun East Road, Beijing",
        importance: 0.4,
        address: {
          road: "Zhongguancun East Road",
          city: "Beijing",
          postcode: "100080",
          country_code: "cn",
        },
      }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await resolveAddress(
    { street: "Zhongguancun East Rd 1", city: "Beijing", country: "CN" },
    { fetch: fetchImpl as typeof fetch },
  );
  assert.ok(result);
  assert.equal(censusCalled, false);
  assert.equal(result!.address.country, "CN");
});

test("resolveAddress returns null when APIs miss", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  const result = await resolveAddress(
    { street: "999 Nonexistent Place", city: "Nowhere", country: "ZZ" },
    { fetch: fetchImpl as typeof fetch },
  );
  assert.equal(result, null);
});

test("formatAddressOneLine joins present parts", () => {
  assert.equal(
    formatAddressOneLine({ street: "1 Main", city: "Paris", country: "FR" }),
    "1 Main, Paris, FR",
  );
});
