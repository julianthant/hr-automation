import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreNameMatch,
  normalizeUsAddress,
  compareUsAddresses,
  matchAgainstRoster,
  type RosterRow,
} from "../../../../src/workflows/emergency-contact/match.js";

describe("scoreNameMatch", () => {
  it("scores 1.0 for exact match (case + whitespace insensitive)", () => {
    assert.equal(scoreNameMatch("John Doe", "JOHN  DOE").score, 1.0);
  });
  it("scores 0.85+ for first/last swap with comma", () => {
    const r = scoreNameMatch("Doe, Jane", "Jane Doe");
    assert.ok(r.score >= 0.85, `expected >= 0.85, got ${r.score}`);
  });
  it("scores 0.9 when middle name is in one but not the other (token intersect)", () => {
    const r = scoreNameMatch("John Michael Doe", "John Doe");
    assert.ok(r.score >= 0.9, `expected >= 0.9, got ${r.score}`);
  });
  it("scores 0.7 for Levenshtein-2 fuzzy", () => {
    const r = scoreNameMatch("John Doee", "John Doe");
    assert.ok(r.score >= 0.7 && r.score < 0.85, `expected 0.7..0.85, got ${r.score}`);
  });
  it("scores 0 for no match", () => {
    assert.equal(scoreNameMatch("Alice Wonderland", "John Doe").score, 0);
  });
  it("returns 0 for empty input", () => {
    assert.equal(scoreNameMatch("", "John Doe").score, 0);
    assert.equal(scoreNameMatch("John Doe", "").score, 0);
  });
});

describe("normalizeUsAddress", () => {
  it("lowercases + expands street type abbreviations", () => {
    const r = normalizeUsAddress({ street: "123 MAIN ST" });
    assert.equal(r.street, "123 main street");
  });
  it("expands Ave / Dr / Blvd", () => {
    assert.equal(normalizeUsAddress({ street: "418 Oak Ave" }).street, "418 oak avenue");
    assert.equal(
      normalizeUsAddress({ street: "9485 S Scholars Dr" }).street,
      "9485 south scholars drive",
    );
    assert.equal(
      normalizeUsAddress({ street: "10 Sunset Blvd" }).street,
      "10 sunset boulevard",
    );
  });
  it("strips trailing punctuation", () => {
    assert.equal(normalizeUsAddress({ street: "418 Oak Ave." }).street, "418 oak avenue");
  });
  it("collapses whitespace", () => {
    assert.equal(normalizeUsAddress({ street: "418  Oak    Ave" }).street, "418 oak avenue");
  });
  it("normalizes 2-letter state to full name", () => {
    assert.equal(normalizeUsAddress({ street: "x", state: "CA" }).state, "california");
    assert.equal(normalizeUsAddress({ street: "x", state: "nj" }).state, "new jersey");
  });
  it("strips ZIP+4 to base 5-digit", () => {
    assert.equal(normalizeUsAddress({ street: "x", zip: "92093-2008" }).zip, "92093");
  });
});

describe("compareUsAddresses", () => {
  it("matches identical addresses", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07661" },
      { street: "418 OAK AVENUE", city: "river edge", state: "nj", zip: "07661" },
    );
    assert.equal(r, "match");
  });
  it("matches with abbreviation expansion", () => {
    const r = compareUsAddresses(
      { street: "9485 S Scholars Dr", city: "La Jolla", state: "CA", zip: "92093" },
      { street: "9485 South Scholars Drive", city: "la jolla", state: "ca", zip: "92093" },
    );
    assert.equal(r, "match");
  });
  it("differs when ZIP differs", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07661" },
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07662" },
    );
    assert.equal(r, "differ");
  });
  it("differs when street differs significantly (same ZIP)", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", zip: "07661" },
      { street: "999 Pine Boulevard", zip: "07661" },
    );
    assert.equal(r, "differ");
  });
  it("returns missing when either side is null", () => {
    assert.equal(compareUsAddresses(null, { street: "x", zip: "01234" }), "missing");
    assert.equal(compareUsAddresses({ street: "x", zip: "01234" }, null), "missing");
    assert.equal(compareUsAddresses(undefined, undefined), "missing");
  });
  it("returns missing when ZIP is missing on either side", () => {
    assert.equal(
      compareUsAddresses({ street: "x" }, { street: "x", zip: "01234" }),
      "missing",
    );
  });
});

describe("matchAgainstRoster", () => {
  const roster: RosterRow[] = [
    { eid: "10001", name: "Jane Doe", street: "123 Main", city: "Denver", state: "CO", zip: "80201" },
    { eid: "10002", name: "Bob Smith", street: "456 Elm", city: "Boulder", state: "CO", zip: "80302" },
    { eid: "10003", name: "Doe, Jane", street: "999 Diff", zip: "99999" },
  ];

  it("returns the unique match with score 1.0 when target is in the roster", () => {
    const r = matchAgainstRoster(roster, "Bob Smith");
    assert.equal(r.bestScore, 1.0);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].eid, "10002");
  });

  it("returns multiple candidates when name is ambiguous (e.g. comma-formatted dup)", () => {
    const r = matchAgainstRoster(roster, "Jane Doe");
    assert.ok(r.candidates.length >= 2);
  });

  it("returns no candidates when nothing matches", () => {
    const r = matchAgainstRoster(roster, "Charlie Brown");
    assert.equal(r.bestScore, 0);
    assert.equal(r.candidates.length, 0);
  });

  it("orders candidates by score DESC", () => {
    const r = matchAgainstRoster(roster, "Jane Doe");
    for (let i = 1; i < r.candidates.length; i++) {
      assert.ok(r.candidates[i - 1].score >= r.candidates[i].score);
    }
  });
});
