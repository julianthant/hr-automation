import assert from "node:assert/strict";
import { test } from "vitest";

import { DEMO_ROWS } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

const rows = Object.values(DEMO_ROWS);

test("every formerly thin workflow now has at least three distinct run specimens", () => {
  for (const workflow of [
    "onboarding",
    "oath-upload",
    "kronos-pay-rule",
    "crm-doc-download",
    "old-kronos-reports",
  ]) {
    const specimens = rows.filter((row) => row.workflowId === workflow);
    assert.ok(specimens.length >= 3, `${workflow} still has only ${specimens.length} specimens`);
    assert.ok(
      new Set(specimens.map((row) => row.outcome.text)).size >= 3,
      `${workflow} repeats outcomes instead of covering distinct states`,
    );
  }
});

test("i9-lookup has four delegated outcomes and distinguishes no profile from portal failure", () => {
  const specimens = rows.filter((row) => row.workflowId === "i9-lookup");
  assert.equal(specimens.length, 4);
  assert.ok(specimens.every((row) => row.parentRunId === "i9-batch"));
  assert.ok(specimens.every((row) => row.containment === "linked"));

  const signed = specimens.find((row) => row.id === "i9l-signed");
  const unsigned = specimens.find((row) => row.id === "i9l-unsigned");
  const noProfile = specimens.find((row) => row.id === "i9l-no-profile");
  const unreachable = specimens.find((row) => row.id === "i9l-unreachable");
  assert.equal(signed?.status, "verifiedDone");
  assert.equal(unsigned?.status, "doneWarnings");
  assert.equal(noProfile?.status, "verifiedDone", "not found is an answer, not a failed run");
  assert.equal(unreachable?.status, "failed");
});

test("Person Lookup Match mode covers matched, no-match, and ambiguous answers", () => {
  const matchRows = rows.filter((row) => row.id.startsWith("pl-match-"));
  assert.equal(matchRows.length, 3);
  assert.deepEqual(
    matchRows.map((row) => row.data.find((point) => point.field === "Found")?.value),
    ["Yes", "No", "Ambiguous"],
  );
  assert.equal(matchRows.find((row) => row.id === "pl-match-none")?.status, "verifiedDone");
  assert.equal(matchRows.find((row) => row.id === "pl-match-ambiguous")?.status, "doneWarnings");
});

test("the broadened corpus includes safety and recovery states instead of happy-path repeats", () => {
  assert.ok(rows.some((row) => row.dryRun));
  assert.ok(rows.some((row) => row.status === "cancelled"));
  assert.ok(rows.some((row) => row.status === "parked" && row.gate?.kind === "parked"));
  assert.ok(rows.some((row) => row.status === "failed" && row.actions.some((action) => action.command === "retry")));
  assert.ok(rows.some((row) => row.workflowVersion < row.workflow.version));
});
