import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePhone,
  normalizeUsState,
  normalizeZip,
  canonicalizeRelationshipRule,
  canonicalizeRelationship,
  normalizeEmergencyContactRecord,
  summarizeNormalizationChanges,
} from "../../../../src/services/llm/normalize-contact.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "normalize-contact-"));
}

// A fake pool that returns a fixed JSON reply, tracking whether it was called.
function fakePool(reply: string, hit: { called: boolean }): TextPoolKey[] {
  return [
    {
      id: "gemini-1",
      providerId: "gemini",
      keyIndex: 1,
      rotationKey: "k",
      priority: 1,
      models: [{ id: "m", limit: { rpm: 10, tpm: 250_000, rpd: 250, imgTokens: 1000 } }],
      callText: async () => {
        hit.called = true;
        return { text: reply };
      },
    },
  ];
}

test("normalizePhone canonicalizes common formats to (XXX) XXX-XXXX", () => {
  assert.equal(normalizePhone("858-534-1234"), "(858) 534-1234");
  assert.equal(normalizePhone("8585341234"), "(858) 534-1234");
  assert.equal(normalizePhone("1 (858) 534.1234"), "(858) 534-1234");
  assert.equal(normalizePhone("+18585341234"), "(858) 534-1234");
  assert.equal(normalizePhone("534-1234"), null, "too few digits → untouched");
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

test("normalizeUsState maps names and abbreviations to USPS codes", () => {
  assert.equal(normalizeUsState("California"), "CA");
  assert.equal(normalizeUsState("ca"), "CA");
  assert.equal(normalizeUsState("CA"), "CA");
  assert.equal(normalizeUsState("New York"), "NY");
  assert.equal(normalizeUsState("Cali"), null, "unrecognized → null");
  assert.equal(normalizeUsState(null), null);
});

test("normalizeZip handles 5 and 9 digit ZIPs", () => {
  assert.equal(normalizeZip("92093"), "92093");
  assert.equal(normalizeZip("920930021"), "92093-0021");
  assert.equal(normalizeZip("92093-0021"), "92093-0021");
  assert.equal(normalizeZip("9209"), null);
  assert.equal(normalizeZip(null), null);
});

test("canonicalizeRelationshipRule maps synonyms, detects canonical, returns null for unknown", () => {
  assert.equal(canonicalizeRelationshipRule("husband"), "Spouse");
  assert.equal(canonicalizeRelationshipRule("Mom"), "Parent");
  assert.equal(canonicalizeRelationshipRule("my older brother"), "Sibling", "substring pass");
  assert.equal(canonicalizeRelationshipRule("Spouse"), "__already");
  assert.equal(canonicalizeRelationshipRule("shdgf"), null, "unknown → LLM fallback");
  assert.equal(canonicalizeRelationshipRule(""), null);
});

test("canonicalizeRelationshipRule maps '-in-law' affinity qualifiers to Relative, never blood-tier", () => {
  assert.equal(canonicalizeRelationshipRule("sister-in-law"), "Relative", "not Sibling");
  assert.equal(canonicalizeRelationshipRule("son-in-law"), "Relative", "not Child");
  assert.equal(canonicalizeRelationshipRule("mother-in-law"), "Relative", "not Parent");
  assert.equal(canonicalizeRelationshipRule("father-in-law"), "Relative", "not Parent");
  assert.equal(canonicalizeRelationshipRule("brother-in-law"), "Relative", "not Sibling");
  assert.equal(canonicalizeRelationshipRule("daughter-in-law"), "Relative", "not Child");
  assert.equal(canonicalizeRelationshipRule("mother in law"), "Relative", "no-hyphen variant");
});

test("canonicalizeRelationship takes the rule fast-path WITHOUT calling the LLM", async () => {
  __resetUsageTrackerForTests();
  const hit = { called: false };
  const pool = fakePool('{"relationship":"Other","confidence":1}', hit);
  const out = await canonicalizeRelationship("wife", { pool });
  assert.deepEqual(out, { value: "Spouse", method: "rule" });
  assert.equal(hit.called, false, "rule table hit → no API call");
});

test("canonicalizeRelationship returns null for an already-canonical value", async () => {
  __resetUsageTrackerForTests();
  const hit = { called: false };
  const out = await canonicalizeRelationship("Parent", { pool: fakePool("{}", hit) });
  assert.equal(out, null);
  assert.equal(hit.called, false);
});

test("canonicalizeRelationship falls through to the LLM for unmapped free text", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const hit = { called: false };
    const pool = fakePool('{"relationship":"Guardian","confidence":0.9}', hit);
    const out = await canonicalizeRelationship("legal ward sponsor", { pool, cacheDir: dir });
    assert.deepEqual(out, { value: "Guardian", method: "llm" });
    assert.equal(hit.called, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalizeRelationship rejects a low-confidence LLM answer", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const hit = { called: false };
    const pool = fakePool('{"relationship":"Other","confidence":0.2}', hit);
    const out = await canonicalizeRelationship("qwxyz", { pool, cacheDir: dir });
    assert.equal(out, null, "below the 0.6 confidence floor → no change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeEmergencyContactRecord applies rule changes and reports them", async () => {
  __resetUsageTrackerForTests();
  const record = {
    employee: {
      cellPhone: "858.534.0000",
      homeAddress: { street: "9500 Gilman Dr", city: "La Jolla", state: "California", zip: "920930021" },
    },
    emergencyContact: {
      relationship: "husband",
      cellPhone: "(619)555-2222",
      homePhone: "not a phone",
      address: { state: "ca", zip: "92122" },
    },
  };
  // No pool → LLM path unavailable, but relationship "husband" is rule-mapped.
  const changes = await normalizeEmergencyContactRecord(record, { pool: [] });

  assert.equal(record.emergencyContact.relationship, "Spouse");
  assert.equal(record.emergencyContact.cellPhone, "(619) 555-2222");
  assert.equal(record.emergencyContact.homePhone, "not a phone", "un-normalizable phone left untouched");
  assert.equal(record.emergencyContact.address.state, "CA");
  assert.equal(record.employee.cellPhone, "(858) 534-0000");
  assert.equal(record.employee.homeAddress.state, "CA");
  assert.equal(record.employee.homeAddress.zip, "92093-0021");

  const fields = changes.map((c) => c.field).sort();
  assert.ok(fields.includes("emergencyContact.relationship"));
  assert.ok(fields.includes("emergencyContact.cellPhone"));
  assert.ok(fields.includes("employee.homeAddress.zip"));
  assert.ok(!fields.includes("emergencyContact.homePhone"), "no change recorded for untouched field");
});

test("normalizeEmergencyContactRecord makes no changes on already-clean data", async () => {
  __resetUsageTrackerForTests();
  const record = {
    emergencyContact: { relationship: "Spouse", cellPhone: "(858) 534-1234", address: { state: "CA", zip: "92093" } },
  };
  const changes = await normalizeEmergencyContactRecord(record, { pool: [] });
  assert.equal(changes.length, 0);
});

test("summarizeNormalizationChanges renders a compact review warning", () => {
  const warn = summarizeNormalizationChanges([
    { field: "emergencyContact.relationship", from: "husband", to: "Spouse", method: "rule" },
    { field: "emergencyContact.cellPhone", from: "8585341234", to: "(858) 534-1234", method: "rule" },
  ]);
  assert.ok(warn);
  assert.match(warn, /Normalized:/);
  assert.match(warn, /relationship "husband"→"Spouse"/);
  assert.equal(summarizeNormalizationChanges([]), null);
});
