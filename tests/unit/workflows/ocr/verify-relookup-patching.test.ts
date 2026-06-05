import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runVerifyRelookup } from "../../../../src/workflows/ocr/verify-relookup.js";
import { dateLocal, rowFilePath, rowsDir } from "../../../../src/tracker/jsonl.js";
import type { ChildOutcome } from "../../../../src/tracker/delegation/watch-child-runs.js";
import type { VerifyCheck } from "../../../../src/services/ocr/forms/verify.js";

function makeDir(): string {
  const dir = join(tmpdir(), `verify-relookup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeVerifyRow(dir: string, sessionId: string, runId: string, records: unknown[]): void {
  const date = dateLocal();
  const entry = {
    workflow: "ocr",
    id: sessionId,
    runId,
    timestamp: new Date().toISOString(),
    status: "done",
    step: "awaiting-approval",
    data: {
      formType: "verify",
      mode: "prepare",
      archetype: "preview",
      records: JSON.stringify(records),
    },
  };
  mkdirSync(rowsDir(dir), { recursive: true });
  writeFileSync(rowFilePath("ocr", date, dir), JSON.stringify(entry) + "\n");
}

function readLastRecords(dir: string): Array<Record<string, unknown>> {
  const date = dateLocal();
  const file = rowFilePath("ocr", date, dir);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  const data = last["data"] as Record<string, string>;
  return JSON.parse(data["records"] ?? "[]") as Array<Record<string, unknown>>;
}

function findCheck(rec: Record<string, unknown>, key: string): VerifyCheck | undefined {
  const checks = (rec["checks"] as VerifyCheck[]) ?? [];
  return checks.find((c) => c.key === key);
}

function oathRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formKind: "oath",
    sourcePage: 1,
    printedName: "Provenzano, Vincent R",
    name: "Provenzano, Vincent R",
    employeeId: "10535871",
    officerSigned: false,
    matchState: "resolved",
    selected: true,
    warnings: [],
    checks: [],
    ...over,
  };
}

describe("runVerifyRelookup — person lookup", () => {
  it("patches active status + CRM dates and flips the activeStatus check to found", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-person";
    const runId = "r-vr-person";
    writeVerifyRow(dir, sessionId, runId, [oathRecord()]);

    await runVerifyRelookup(
      { sessionId, runId, recordIndex: 0, lookup: "person" },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async (opts): Promise<ChildOutcome[]> => [
          {
            workflow: "person-lookup",
            itemId: opts.expectedItemIds[0]!,
            runId: "pl-1",
            status: "done",
            data: {
              emplId: "10535871",
              searchName: "Provenzano, Vincent R",
              activeStatus: "inactive",
              employmentDate: "11/3/2021",
              oathDate: "10/26/2021",
            },
          },
        ],
      },
    );

    const rec = readLastRecords(dir)[0]!;
    assert.equal(rec["activeStatus"], "inactive");
    assert.equal(rec["employmentDate"], "11/3/2021");
    assert.equal(rec["oathDate"], "10/26/2021");
    const activeCheck = findCheck(rec, "activeStatus");
    assert.equal(activeCheck?.status, "found", "activeStatus check should now be found");
    assert.equal(activeCheck?.foundValue, "inactive");
  });

  it("marks the record unresolved when person-lookup times out (no outcome)", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-person-to";
    const runId = "r-vr-person-to";
    writeVerifyRow(dir, sessionId, runId, [oathRecord({ matchState: "lookup-pending", employeeId: "" })]);

    await runVerifyRelookup(
      { sessionId, runId, recordIndex: 0, lookup: "person" },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async (): Promise<ChildOutcome[]> => [],
      },
    );

    const rec = readLastRecords(dir)[0]!;
    assert.equal(rec["matchState"], "unresolved");
  });
});

describe("runVerifyRelookup — i9 signer lookup", () => {
  it("patches officialSigner and flips the officialSigner check from missing to found", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-i9";
    const runId = "r-vr-i9";
    writeVerifyRow(dir, sessionId, runId, [oathRecord()]);

    await runVerifyRelookup(
      { sessionId, runId, recordIndex: 0, lookup: "i9" },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async (opts): Promise<ChildOutcome[]> => [
          {
            workflow: "i9-lookup",
            itemId: opts.expectedItemIds[0]!,
            runId: "i9-1",
            status: "done",
            data: { signerName: "Garcia, Maria" },
          },
        ],
      },
    );

    const rec = readLastRecords(dir)[0]!;
    assert.equal(rec["officialSigner"], "Garcia, Maria");
    const signerCheck = findCheck(rec, "officialSigner");
    assert.equal(signerCheck?.status, "found");
    assert.equal(signerCheck?.source, "i9");
  });

  it("leaves the officialSigner check missing when i9-lookup returns nothing", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-i9-none";
    const runId = "r-vr-i9-none";
    writeVerifyRow(dir, sessionId, runId, [oathRecord()]);

    await runVerifyRelookup(
      { sessionId, runId, recordIndex: 0, lookup: "i9" },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async (): Promise<ChildOutcome[]> => [],
      },
    );

    const rec = readLastRecords(dir)[0]!;
    assert.equal(rec["officialSigner"] ?? "", "");
    assert.equal(findCheck(rec, "officialSigner")?.status, "missing");
  });
});

describe("runVerifyRelookup — guards", () => {
  it("throws when the record has no name to look up", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-noname";
    const runId = "r-vr-noname";
    writeVerifyRow(dir, sessionId, runId, [oathRecord({ name: "", printedName: "" })]);

    await assert.rejects(
      () =>
        runVerifyRelookup(
          { sessionId, runId, recordIndex: 0, lookup: "person" },
          { trackerDir: dir, _enqueueOverride: async () => {}, _watchChildRunsOverride: async () => [] },
        ),
      /no name/i,
    );
  });

  it("throws when the OCR row is not a verify row", async () => {
    const dir = makeDir();
    const sessionId = "s-vr-wrong";
    const runId = "r-vr-wrong";
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(
      rowFilePath("ocr", date, dir),
      JSON.stringify({
        workflow: "ocr",
        id: sessionId,
        runId,
        timestamp: new Date().toISOString(),
        status: "done",
        step: "awaiting-approval",
        data: { formType: "oath", records: "[]" },
      }) + "\n",
    );

    await assert.rejects(
      () =>
        runVerifyRelookup(
          { sessionId, runId, recordIndex: 0, lookup: "person" },
          { trackerDir: dir, _enqueueOverride: async () => {}, _watchChildRunsOverride: async () => [] },
        ),
      /verify/i,
    );
  });
});
