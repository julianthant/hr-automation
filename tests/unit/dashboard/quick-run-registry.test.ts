import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getQuickRunConfig,
  parseActiveCheckInputs,
} from "../../../src/dashboard/lib/quick-run-registry.js";

test("active-check quick run accepts EIDs and names separated by semicolons", () => {
  const parsed = parseActiveCheckInputs("10873698; Battistessa, Johnnie");

  assert.deepEqual(parsed, {
    ok: true,
    inputs: [
      { emplId: "10873698" },
      { name: "Battistessa, Johnnie" },
    ],
  });
});

test("active-check quick run rejects empty input", () => {
  assert.deepEqual(parseActiveCheckInputs(" ; "), {
    ok: false,
    error: "Enter at least one EID or name",
  });
});

test("active-check is visible in the dashboard quick-run registry", () => {
  const config = getQuickRunConfig("active-check");

  assert.ok(config);
  assert.match(config.placeholder, /EIDs or names/);
});
