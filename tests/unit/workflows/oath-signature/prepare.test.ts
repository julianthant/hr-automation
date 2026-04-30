import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  runPaperOathPrepare,
  __setOcrForTests,
  __setEidLookupEnqueueForTests,
} from "../../../../src/workflows/oath-signature/prepare.js";
import type { OathRosterOcrRecord } from "../../../../src/workflows/oath-signature/preview-schema.js";
import type { OcrResult } from "../../../../src/ocr/types.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";

async function writeRoster(
  path: string,
  rows: { eid: string; first: string; last: string }[],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee ID", "First Name", "Last Name"]);
  for (const r of rows) ws.addRow([r.eid, r.first, r.last]);
  await wb.xlsx.writeFile(path);
}

function makeRow(
  printedName: string,
  employeeSigned: boolean,
  rowIndex = 0,
  dateSigned: string | null = null,
): OathRosterOcrRecord {
  return {
    sourcePage: 1,
    rowIndex,
    printedName,
    employeeSigned,
    officerSigned: null,
    dateSigned,
    notes: [],
  };
}

function fakeOcrResult(records: OathRosterOcrRecord[]): OcrResult<OathRosterOcrRecord[]> {
  return {
    data: records,
    rawText: "[]",
    pageCount: 1,
    provider: "fake",
    keyIndex: 1,
    attempts: 1,
    cached: false,
    durationMs: 10,
  };
}

interface TrackerLine {
  id: string;
  workflow: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}

function readTrackerLines(trackerDir: string): TrackerLine[] {
  const file = join(trackerDir, `oath-signature-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

describe("runPaperOathPrepare — happy path (roster name match)", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-"));
    trackerDir = join(tmp, "tracker");
    rosterDir = join(tmp, "data");
    uploadsDir = join(tmp, "uploads");
    pdfPath = join(tmp, "fake.pdf");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    await writeRoster(join(rosterDir, "roster.xlsx"), [
      { eid: "10001", first: "Alice", last: "Adams" },
      { eid: "10002", first: "Bob", last: "Beam" },
    ]);
  });
  afterEach(() => {
    __setOcrForTests(undefined);
    __setEidLookupEnqueueForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes pending → loading-roster → ocr → matching → done with roster-matched record", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Alice Adams", true, 0, "04/27/2026")])) as never);

    const out = await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    assert.equal(out.runId, out.parentRunId);
    const lines = readTrackerLines(trackerDir);
    const statuses = lines.map((l) => `${l.status}${l.step ? `(${l.step})` : ""}`);
    assert.ok(statuses.includes("pending"));
    assert.ok(statuses.includes("running(loading-roster)"));
    assert.ok(statuses.includes("running(ocr)"));
    assert.ok(statuses.includes("running(matching)"));
    assert.equal(statuses[statuses.length - 1], "done");

    const last = lines[lines.length - 1];
    assert.equal(last.workflow, "oath-signature");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      matchSource?: string;
      employeeId: string;
      dateSigned: string | null;
      selected: boolean;
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0].matchState, "matched");
    assert.equal(records[0].matchSource, "roster");
    assert.equal(records[0].employeeId, "10001");
    assert.equal(records[0].dateSigned, "04/27/2026");
    assert.equal(records[0].selected, true);
  });
});

describe("runPaperOathPrepare — unsigned rows are extracted but not selected", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-"));
    trackerDir = join(tmp, "tracker");
    rosterDir = join(tmp, "data");
    uploadsDir = join(tmp, "uploads");
    pdfPath = join(tmp, "fake.pdf");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    await writeRoster(join(rosterDir, "roster.xlsx"), [
      { eid: "10001", first: "Alice", last: "Adams" },
    ]);
  });
  afterEach(() => {
    __setOcrForTests(undefined);
    __setEidLookupEnqueueForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips matching for signed=false rows, marks them extracted + deselected", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([
        makeRow("Alice Adams", true, 0, "04/27/2026"),
        makeRow("Bob Beam", false, 1, null),
      ])) as never);

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      printedName: string;
      matchState: string;
      selected: boolean;
    }>;
    assert.equal(records.length, 2);
    const alice = records.find((r) => r.printedName === "Alice Adams")!;
    const bob = records.find((r) => r.printedName === "Bob Beam")!;
    assert.equal(alice.matchState, "matched");
    assert.equal(alice.selected, true);
    assert.equal(bob.matchState, "extracted");
    assert.equal(bob.selected, false);
  });
});

describe("runPaperOathPrepare — eid-lookup fallback", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-"));
    trackerDir = join(tmp, "tracker");
    rosterDir = join(tmp, "data");
    uploadsDir = join(tmp, "uploads");
    pdfPath = join(tmp, "fake.pdf");
    mkdirSync(rosterDir, { recursive: true });
    mkdirSync(trackerDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
    await writeRoster(join(rosterDir, "roster.xlsx"), [
      { eid: "10001", first: "Alice", last: "Adams" },
    ]);
  });
  afterEach(() => {
    __setOcrForTests(undefined);
    __setEidLookupEnqueueForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves via eid-lookup when the roster has no good match", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Charlie Carrot", true, 0, "04/27/2026")])) as never);

    let enqueueCalled = false;
    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      enqueueCalled = true;
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        const itemId = `oath-prep-${parentRunId}-r${inputs[0].__prepIndex}`;
        const row = {
          workflow: "eid-lookup",
          timestamp: new Date().toISOString(),
          id: itemId,
          runId: itemId,
          status: "done",
          data: { emplId: "10999", searchName: inputs[0].name },
        };
        appendFileSync(eidFile, JSON.stringify(row) + "\n");
      }, 50);
    });

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(enqueueCalled, "eid-lookup enqueue should have been called");
    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      matchSource?: string;
      employeeId: string;
    }>;
    assert.equal(records[0].matchState, "resolved");
    assert.equal(records[0].matchSource, "eid-lookup");
    assert.equal(records[0].employeeId, "10999");
  });

  it("marks records as unresolved when eid-lookup returns 'Not found'", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Charlie Carrot", true)])) as never);

    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        const itemId = `oath-prep-${parentRunId}-r${inputs[0].__prepIndex}`;
        const row = {
          workflow: "eid-lookup",
          timestamp: new Date().toISOString(),
          id: itemId,
          runId: itemId,
          status: "done",
          data: { emplId: "Not found", searchName: inputs[0].name },
        };
        appendFileSync(eidFile, JSON.stringify(row) + "\n");
      }, 50);
    });

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1000));

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{ matchState: string }>;
    assert.equal(records[0].matchState, "unresolved");
  });
});

describe("runPaperOathPrepare — error paths", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-"));
    trackerDir = join(tmp, "tracker");
    rosterDir = join(tmp, "empty-data");
    uploadsDir = join(tmp, "uploads");
    pdfPath = join(tmp, "fake.pdf");
    writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
  });
  afterEach(() => {
    __setOcrForTests(undefined);
    __setEidLookupEnqueueForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails with a clear error when no roster is available", async () => {
    const out = await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });
    assert.ok(out.runId);
    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "failed");
  });
});
