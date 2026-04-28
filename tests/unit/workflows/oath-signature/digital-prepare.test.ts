import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setDigitalLookupForTests,
  runDigitalOathPrepare,
} from "../../../../src/workflows/oath-signature/digital-prepare.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";

interface TrackerLine {
  status: string;
  step?: string;
  workflow: string;
  data?: Record<string, string>;
  error?: string;
}

function readLines(trackerDir: string): TrackerLine[] {
  const file = join(trackerDir, `oath-signature-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrackerLine);
}

describe("runDigitalOathPrepare — happy path", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-digital-"));
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("transitions pending → crm-auth → lookup → done with one matched record per EID", async () => {
    __setDigitalLookupForTests(async (emplIds) =>
      emplIds.map((emplId) => ({
        emplId,
        dateMmDdYyyy: "04/27/2026",
        displayName: `Employee ${emplId}`,
      })),
    );

    const out = await runDigitalOathPrepare({
      emplIds: ["10873611", "10873075"],
      label: "smoke-test",
      trackerDir: tmp,
    });
    assert.equal(out.runId, out.parentRunId);

    const lines = readLines(tmp);
    const statuses = lines.map((l) => `${l.status}${l.step ? `(${l.step})` : ""}`);
    assert.ok(statuses.includes("pending"));
    assert.ok(statuses.includes("running(crm-auth)"));
    assert.ok(statuses.includes("running(lookup)"));
    assert.equal(statuses[statuses.length - 1], "done");

    const last = lines[lines.length - 1];
    assert.equal(last.workflow, "oath-signature");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      employeeId: string;
      dateSigned: string;
      matchState: string;
      selected: boolean;
      printedName: string;
    }>;
    assert.equal(records.length, 2);
    assert.equal(records[0].employeeId, "10873611");
    assert.equal(records[0].dateSigned, "04/27/2026");
    assert.equal(records[0].matchState, "matched");
    assert.equal(records[0].selected, true);
    assert.equal(records[0].printedName, "Employee 10873611");
  });
});

describe("runDigitalOathPrepare — unresolved + error rows", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-digital-"));
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks records unresolved + deselected when the lookup returns no date", async () => {
    __setDigitalLookupForTests(async () => [
      { emplId: "10873611", dateMmDdYyyy: null },
    ]);

    await runDigitalOathPrepare({ emplIds: ["10873611"], trackerDir: tmp });

    const last = readLines(tmp).at(-1);
    assert.equal(last?.status, "done");
    const records = JSON.parse(last?.data?.records ?? "[]") as Array<{
      matchState: string;
      selected: boolean;
      warnings: string[];
    }>;
    assert.equal(records[0].matchState, "unresolved");
    assert.equal(records[0].selected, false);
    assert.match(records[0].warnings[0], /No.*Witness Ceremony Oath/i);
  });

  it("captures per-EID lookup errors as warnings without aborting the batch", async () => {
    __setDigitalLookupForTests(async () => [
      { emplId: "10873611", dateMmDdYyyy: "04/27/2026" },
      { emplId: "99999999", dateMmDdYyyy: null, error: "EID not found in CRM" },
    ]);

    await runDigitalOathPrepare({
      emplIds: ["10873611", "99999999"],
      trackerDir: tmp,
    });

    const last = readLines(tmp).at(-1);
    assert.equal(last?.status, "done");
    const records = JSON.parse(last?.data?.records ?? "[]") as Array<{
      employeeId: string;
      matchState: string;
      warnings: string[];
    }>;
    assert.equal(records[0].matchState, "matched");
    assert.equal(records[1].matchState, "unresolved");
    assert.match(records[1].warnings[0], /EID not found/);
  });
});

describe("runDigitalOathPrepare — input validation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-digital-"));
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails synchronously when emplIds is empty", async () => {
    await runDigitalOathPrepare({ emplIds: [], trackerDir: tmp });
    const last = readLines(tmp).at(-1);
    assert.equal(last?.status, "failed");
    assert.match(last?.error ?? "", /No EIDs/);
  });

  it("fails when the lookup function throws", async () => {
    __setDigitalLookupForTests(async () => {
      throw new Error("CRM session crashed");
    });
    await runDigitalOathPrepare({ emplIds: ["10873611"], trackerDir: tmp });
    const last = readLines(tmp).at(-1);
    assert.equal(last?.status, "failed");
    assert.match(last?.error ?? "", /CRM session crashed/);
  });
});
