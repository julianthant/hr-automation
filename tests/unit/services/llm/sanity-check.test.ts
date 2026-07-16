import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEmail,
  checkDob,
  checkEid,
  checkRequired,
  runRuleChecks,
  inferRuleSpec,
  sanityCheckRecord,
  hasBlockingIssue,
  summarizeSanityIssues,
} from "../../../../src/services/llm/sanity-check.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "sanity-"));
}

function fakePool(reply: string): TextPoolKey[] {
  return [
    {
      id: "gemini-1",
      providerId: "gemini",
      keyIndex: 1,
      rotationKey: "k",
      priority: 1,
      models: [{ id: "m", limit: { rpm: 10, tpm: 250_000, rpd: 250, imgTokens: 1000 }, tier: 2, trust: "unbenchmarked" }],
      callText: async () => ({ text: reply }),
    },
  ];
}

test("checkEmail flags malformed addresses, passes valid ones and blanks", () => {
  assert.equal(checkEmail("workEmail", "jane@ucsd.edu"), null);
  assert.equal(checkEmail("workEmail", ""), null);
  assert.equal(checkEmail("workEmail", null), null);
  const bad = checkEmail("workEmail", "jane@ucsd");
  assert.ok(bad);
  assert.equal(bad.severity, "error");
});

test("checkDob flags unparseable and out-of-range years", () => {
  assert.equal(checkDob("dob", "1990-05-01"), null);
  assert.equal(checkDob("dob", "")?.severity, undefined);
  assert.ok(checkDob("dob", "not a date"));
  assert.equal(checkDob("dob", "not a date")?.severity, "error");
  assert.equal(checkDob("dob", "1850-01-01")?.severity, "warning");
  assert.equal(checkDob("dob", "2090-01-01")?.severity, "warning");
});

test("checkEid flags non-5+-digit ids", () => {
  assert.equal(checkEid("employeeId", "10000001"), null);
  assert.equal(checkEid("employeeId", "123")?.severity, "warning");
  assert.equal(checkEid("employeeId", ""), null);
});

test("checkRequired flags blank required fields", () => {
  assert.equal(checkRequired("name", "Doe, Jane"), null);
  assert.equal(checkRequired("name", "")?.severity, "error");
  assert.equal(checkRequired("name", null)?.severity, "error");
});

test("inferRuleSpec detects common HR field names", () => {
  const spec = inferRuleSpec({
    workEmail: "a@b.com",
    personalEmail: "c@d.com",
    dateOfBirth: "1990-01-01",
    employeeId: "10000001",
    name: "Doe, Jane",
  });
  assert.deepEqual(spec.email?.sort(), ["personalEmail", "workEmail"]);
  assert.deepEqual(spec.dob, ["dateOfBirth"]);
  assert.deepEqual(spec.eid, ["employeeId"]);
});

test("runRuleChecks aggregates issues across categories", () => {
  const issues = runRuleChecks(
    { workEmail: "bad", employeeId: "12", name: "" },
    { email: ["workEmail"], eid: ["employeeId"], required: ["name"] },
  );
  const fields = issues.map((i) => i.field).sort();
  assert.deepEqual(fields, ["employeeId", "name", "workEmail"]);
  assert.ok(hasBlockingIssue(issues), "malformed email + blank name are errors");
});

test("sanityCheckRecord with useLlm:false runs rules only (no pool needed)", async () => {
  __resetUsageTrackerForTests();
  const issues = await sanityCheckRecord(
    { workEmail: "jane@ucsd", employeeId: "10000001" },
    { rules: { email: ["workEmail"], eid: ["employeeId"] }, useLlm: false },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "workEmail");
  assert.equal(issues[0].source, "rule");
});

test("sanityCheckRecord merges rule issues with the LLM cross-field pass", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const reply = JSON.stringify({
      issues: [{ field: "name", severity: "warning", message: "Name looks OCR-garbled." }],
    });
    const issues = await sanityCheckRecord(
      { workEmail: "jane@ucsd", name: "Jaaane Doooe" },
      { rules: { email: ["workEmail"] }, pool: fakePool(reply), cacheDir: dir },
    );
    const sources = issues.map((i) => i.source).sort();
    assert.deepEqual(sources, ["llm", "rule"]);
    assert.ok(issues.find((i) => i.field === "name" && i.source === "llm"));
    assert.ok(issues.find((i) => i.field === "workEmail" && i.source === "rule"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanityCheckRecord degrades to rule issues when the pool is exhausted", async () => {
  __resetUsageTrackerForTests();
  const issues = await sanityCheckRecord(
    { workEmail: "jane@ucsd" },
    { rules: { email: ["workEmail"] }, pool: [] },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, "rule");
});

test("summarizeSanityIssues renders issues, null when empty", () => {
  assert.equal(summarizeSanityIssues([]), null);
  const s = summarizeSanityIssues([
    { field: "workEmail", severity: "error", message: "bad", source: "rule" },
  ]);
  assert.match(s ?? "", /Sanity check:/);
  assert.match(s ?? "", /workEmail: bad/);
});
