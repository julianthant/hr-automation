import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  runPrepare,
  __setOcrForTests,
  __setEidLookupEnqueueForTests,
} from "../../../../src/workflows/emergency-contact/prepare.js";
import type { EmergencyContactRecord } from "../../../../src/workflows/emergency-contact/schema.js";
import type { OcrResult } from "../../../../src/ocr/types.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";

async function writeRoster(
  path: string,
  rows: { eid: string; first: string; last: string; street?: string; zip?: string }[],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee ID", "First Name", "Last Name", "Street", "Zip"]);
  for (const r of rows) ws.addRow([r.eid, r.first, r.last, r.street ?? "", r.zip ?? ""]);
  await wb.xlsx.writeFile(path);
}

function makeRecord(name: string, eid = ""): EmergencyContactRecord {
  return {
    sourcePage: 1,
    employee: { name, employeeId: eid },
    emergencyContact: {
      name: `${name}'s Mom`,
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
      cellPhone: "(555) 123-4567",
      homePhone: null,
      workPhone: null,
    },
    notes: [],
  };
}

function fakeOcrResult(records: EmergencyContactRecord[]): OcrResult<EmergencyContactRecord[]> {
  return {
    data: records,
    rawText: "[]",
    pageCount: records.length,
    provider: "fake",
    keyIndex: 1,
    attempts: 1,
    cached: false,
    durationMs: 10,
  };
}

interface TrackerLine {
  id: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}

function readTrackerLines(trackerDir: string): TrackerLine[] {
  const file = join(trackerDir, `emergency-contact-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

describe("runPrepare — happy path (form-EID only)", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-"));
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

  it("writes pending → loading-roster → ocr → matching → done with all records matched", async () => {
    __setOcrForTests((async () => fakeOcrResult([makeRecord("Alice Adams", "10001")])) as never);
    // Path B: the matched record now triggers a verify-only eid-lookup
    // enqueue. Simulate the daemon writing a `verified` JSONL row so the
    // orchestrator can finalize as "done".
    __setEidLookupEnqueueForTests(async (inputs, _parentRunId) => {
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        for (const input of inputs as Array<{ __itemId: string }>) {
          appendFileSync(
            eidFile,
            JSON.stringify({
              workflow: "eid-lookup",
              timestamp: new Date().toISOString(),
              id: input.__itemId,
              runId: input.__itemId,
              status: "done",
              data: {
                emplId: "10001",
                hrStatus: "Active",
                department: "HOUSING/DINING/HOSPITALITY",
                personOrgScreenshot: "shot.png",
              },
            }) + "\n",
          );
        }
      }, 30);
    });

    const out = await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    assert.equal(out.runId, out.parentRunId);
    await new Promise((r) => setTimeout(r, 1000));

    const lines = readTrackerLines(trackerDir);
    const statuses = lines.map((l) => `${l.status}${l.step ? `(${l.step})` : ""}`);
    assert.ok(statuses.includes("pending"));
    assert.ok(statuses.includes("running(loading-roster)"));
    assert.ok(statuses.includes("running(ocr)"));
    assert.ok(statuses.includes("running(matching)"));
    assert.equal(statuses[statuses.length - 1], "done");

    const last = lines[lines.length - 1];
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{ matchState: string }>;
    assert.equal(records.length, 1);
    assert.equal(records[0].matchState, "matched");
  });
});

describe("runPrepare — roster name match", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-"));
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

  it("matches by name when EID is missing on the OCR record", async () => {
    __setOcrForTests((async () => fakeOcrResult([makeRecord("Alice Adams", "")])) as never);
    // Path B verify enqueue: the roster-matched record triggers a verify-
    // only lookup. Stub it with an Active/HDH completion.
    __setEidLookupEnqueueForTests(async (inputs, _parentRunId) => {
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        for (const input of inputs as Array<{ __itemId: string }>) {
          appendFileSync(
            eidFile,
            JSON.stringify({
              workflow: "eid-lookup",
              timestamp: new Date().toISOString(),
              id: input.__itemId,
              runId: input.__itemId,
              status: "done",
              data: {
                emplId: "10001",
                hrStatus: "Active",
                department: "HOUSING/DINING/HOSPITALITY",
                personOrgScreenshot: "shot.png",
              },
            }) + "\n",
          );
        }
      }, 30);
    });

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
      rosterDir,
      uploadsDir,
      trackerDir,
    });
    await new Promise((r) => setTimeout(r, 1000));

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      matchSource?: string;
      employee: { employeeId: string };
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0].matchState, "matched");
    assert.equal(records[0].matchSource, "roster");
    assert.equal(records[0].employee.employeeId, "10001");
  });
});

describe("runPrepare — eid-lookup fallback", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-"));
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

  it("resolves a record when eid-lookup writes a done row with a numeric emplId", async () => {
    __setOcrForTests((async () => fakeOcrResult([makeRecord("Charlie Carrot", "")])) as never);

    let enqueueCalled = false;
    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      enqueueCalled = true;
      // Simulate eid-lookup daemon writing a done row asynchronously.
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        const itemId = `ec-prep-${parentRunId}-r${inputs[0].__prepIndex}`;
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

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    // Wait for async resolution.
    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(enqueueCalled, "eid-lookup enqueue should have been called");
    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      matchSource?: string;
      employee: { employeeId: string };
    }>;
    assert.equal(records[0].matchState, "resolved");
    assert.equal(records[0].matchSource, "eid-lookup");
    assert.equal(records[0].employee.employeeId, "10999");
  });

  it("marks records as unresolved when eid-lookup returns 'Not found'", async () => {
    __setOcrForTests((async () => fakeOcrResult([makeRecord("Charlie Carrot", "")])) as never);

    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        const itemId = `ec-prep-${parentRunId}-r${inputs[0].__prepIndex}`;
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

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
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

describe("runPrepare — error paths", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-"));
    trackerDir = join(tmp, "tracker");
    rosterDir = join(tmp, "empty-data"); // intentionally empty
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
    const out = await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
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
