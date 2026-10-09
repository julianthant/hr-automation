import { test } from "vitest";
import assert from "node:assert/strict";

import {
  applyInputRunOptions,
  getInputRunConfig,
  parseCrmDocDownloadInputs,
  parsePersonLookupInputs,
  parsePersonLookupMatchInputs,
  parseProcessEidSheet,
} from "../../../src/dashboard/lib/input-run-registry.js";

test("person-lookup input run accepts EIDs and names separated by semicolons", () => {
  const parsed = parsePersonLookupInputs("10090305; Bodukiwapet, Jabepik");

  assert.deepEqual(parsed, {
    ok: true,
    inputs: [
      { emplId: "10090305" },
      { name: "Bodukiwapet, Jabepik" },
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
  assert.equal(config.supportsCrmCheck, true);
  assert.deepEqual(
    config.modes?.map((mode) => ({
      key: mode.key,
      label: mode.label,
      crmCheckDefault: mode.crmCheckDefault,
    })),
    [
      { key: "search", label: "Search", crmCheckDefault: true },
      { key: "match", label: "Match", crmCheckDefault: false },
    ],
  );
});

test("person-lookup Match mode parses semicolon-delimited legal names with DOB/SSN fields", () => {
  assert.deepEqual(
    parsePersonLookupMatchInputs(
      "Romag, Maczd, 01/02/1980, x; vuf Bzoom, John, x, 123456789",
    ),
    {
      ok: true,
      inputs: [
        {
          mode: "match",
          lastName: "Romag",
          firstName: "Maczd",
          dob: "01/02/1980",
        },
        {
          mode: "match",
          lastName: "Vuf Bzoom",
          firstName: "John",
          ssn: "123456789",
        },
      ],
    },
  );
});

test("person-lookup Match mode surfaces the offending record when both identifiers are absent", () => {
  assert.deepEqual(parsePersonLookupMatchInputs("Romag, Maczd, X, x"), {
    ok: false,
    error: 'Person Lookup Match input "Romag, Maczd, X, x" cannot use x for both DOB and SSN',
  });
});

test("process-eid input run accepts one exact roster worksheet label", () => {
  assert.deepEqual(parseProcessEidSheet("  September   14  "), {
    ok: true,
    inputs: [{ source: "roster-sheet", sheet: "September 14" }],
  });

  const config = getInputRunConfig("process-eid");
  assert.ok(config);
  assert.match(config.placeholder, /worksheet label/i);
});

test("process-eid input run rejects an empty worksheet label", () => {
  assert.deepEqual(parseProcessEidSheet(" \n\t "), {
    ok: false,
    error: "Enter a roster worksheet label, or the full path to a roster .xlsx/.csv",
  });
});

test("process-eid input run takes a roster file path instead of a worksheet label", () => {
  assert.deepEqual(
    parseProcessEidSheet("  <downloads>/26-27 Student Applicants(Sept 28).csv  "),
    {
      ok: true,
      inputs: [
        {
          source: "roster-sheet",
          rosterPath: "<downloads>/26-27 Student Applicants(Sept 28).csv",
        },
      ],
    },
  );
  // A bare filename is a path too — it is the extension that decides.
  assert.deepEqual(parseProcessEidSheet("roster.xlsx"), {
    ok: true,
    inputs: [{ source: "roster-sheet", rosterPath: "roster.xlsx" }],
  });
});

test("process-eid input run rejects a path whose file cannot be a roster", () => {
  assert.deepEqual(parseProcessEidSheet("<downloads>/roster.pdf"), {
    ok: false,
    error: "A roster path must end in .csv or .xlsx",
  });
});

test("input-run options fold the selected mode and explicit CRM state onto every item", () => {
  assert.deepEqual(
    applyInputRunOptions(
      [{ name: "Romag, Maczd" }, { emplId: "10090305" }],
      { mode: "search", crmCheck: false },
    ),
    [
      { name: "Romag, Maczd", mode: "search", crmCheck: false },
      { emplId: "10090305", mode: "search", crmCheck: false },
    ],
  );
});

test("crm-doc-download input run accepts EIDs separated by commas", () => {
  const config = getInputRunConfig("crm-doc-download");

  assert.ok(config);
  assert.match(config.placeholder, /EIDs/);
  assert.deepEqual(config.parseInput("10090305, 10090306"), {
    ok: true,
    inputs: [{ emplId: "10090305" }, { emplId: "10090306" }],
  });
});

test("crm-doc-download input run accepts emails and EIDs interchangeably", () => {
  assert.deepEqual(
    parseCrmDocDownloadInputs("10090305, fixture024@example.edu, fixture008@example.edu"),
    {
      ok: true,
      inputs: [
        { emplId: "10090305" },
        { email: "fixture024@example.edu" },
        { email: "fixture008@example.edu" },
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
  assert.deepEqual(config.parseInput("fixture024@example.edu, fixture008@example.edu"), {
    ok: true,
    inputs: [{ email: "fixture024@example.edu" }, { email: "fixture008@example.edu" }],
  });
});

test("onboarding input run rejects a malformed email", () => {
  const config = getInputRunConfig("onboarding");

  assert.ok(config);
  const parsed = config.parseInput("not-an-email");
  assert.equal(parsed.ok, false);
});
