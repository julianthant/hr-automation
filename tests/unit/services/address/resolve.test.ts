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
