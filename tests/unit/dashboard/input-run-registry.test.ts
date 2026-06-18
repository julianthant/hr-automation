import { test } from "vitest";
import assert from "node:assert/strict";

import {
  getInputRunConfig,
  parseCrmDocDownloadInputs,
  parsePersonLookupInputs,
} from "../../../src/dashboard/lib/input-run-registry.js";

test("person-lookup input run accepts EIDs and names separated by semicolons", () => {
  const parsed = parsePersonLookupInputs("10873698; Battistessa, Johnnie");

  assert.deepEqual(parsed, {
    ok: true,
    inputs: [
      { emplId: "10873698" },
      { name: "Battistessa, Johnnie" },
    ],
  });
});

test("person-lookup input run rejects empty input", () => {
  assert.deepEqual(parsePersonLookupInputs(" ; "), {
    ok: false,
    error: "Enter at least one EID or name",
  });
});

test("person-lookup is visible in the dashboard input-run registry", () => {
  const config = getInputRunConfig("person-lookup");

  assert.ok(config);
  assert.match(config.placeholder, /EIDs or names/);
});

test("crm-doc-download input run accepts EIDs separated by commas", () => {
  const config = getInputRunConfig("crm-doc-download");

  assert.ok(config);
  assert.match(config.placeholder, /EIDs/);
  assert.deepEqual(config.parseInput("10873698, 10873699"), {
    ok: true,
    inputs: [{ emplId: "10873698" }, { emplId: "10873699" }],
  });
});

test("crm-doc-download input run accepts emails and EIDs interchangeably", () => {
  assert.deepEqual(
    parseCrmDocDownloadInputs("10873698, jdoe@ucsd.edu, asmith@ucsd.edu"),
    {
      ok: true,
      inputs: [
        { emplId: "10873698" },
        { email: "jdoe@ucsd.edu" },
        { email: "asmith@ucsd.edu" },
      ],
    },
  );
});

test("crm-doc-download input run mentions emails in its placeholder", () => {
  const config = getInputRunConfig("crm-doc-download");

  assert.ok(config);
  assert.match(config.placeholder, /emails/);
});

test("crm-doc-download input run rejects a token that is neither EID nor email", () => {
  const parsed = parseCrmDocDownloadInputs("not-an-id");

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed, {
    ok: false,
    error: 'Expected an EID (5+ digits) or email: "not-an-id"',
  });
});

test("crm-doc-download input run rejects empty input", () => {
  assert.deepEqual(parseCrmDocDownloadInputs("  ,  "), {
    ok: false,
    error: "Enter at least one EID or email",
  });
});

test("onboarding input run accepts comma-separated emails and opts into dry-run", () => {
  const config = getInputRunConfig("onboarding");

  assert.ok(config);
  assert.match(config.placeholder, /emails/);
  assert.equal(config.supportsDryRun, true);
  assert.deepEqual(config.parseInput("jdoe@ucsd.edu, asmith@ucsd.edu"), {
    ok: true,
    inputs: [{ email: "jdoe@ucsd.edu" }, { email: "asmith@ucsd.edu" }],
  });
});

test("onboarding input run rejects a malformed email", () => {
  const config = getInputRunConfig("onboarding");

  assert.ok(config);
  const parsed = config.parseInput("not-an-email");
  assert.equal(parsed.ok, false);
});
