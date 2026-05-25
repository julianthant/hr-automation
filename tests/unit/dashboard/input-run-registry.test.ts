import { test } from "vitest";
import assert from "node:assert/strict";

import {
  getInputRunConfig,
  parseActiveCheckInputs,
} from "../../../src/dashboard/lib/input-run-registry.js";

test("active-check input run accepts EIDs and names separated by semicolons", () => {
  const parsed = parseActiveCheckInputs("10873698; Battistessa, Johnnie");

  assert.deepEqual(parsed, {
    ok: true,
    inputs: [
      { emplId: "10873698" },
      { name: "Battistessa, Johnnie" },
    ],
  });
});

test("active-check input run rejects empty input", () => {
  assert.deepEqual(parseActiveCheckInputs(" ; "), {
    ok: false,
    error: "Enter at least one EID or name",
  });
});

test("active-check is visible in the dashboard input-run registry", () => {
  const config = getInputRunConfig("active-check");

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
