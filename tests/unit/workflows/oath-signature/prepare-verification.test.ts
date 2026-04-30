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
  computeVerification,
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

describe("oath computeVerification — discriminator states", () => {
  it("returns lookup-failed when hrStatus is missing", () => {
    const v = computeVerification({});
    assert.equal(v.state, "lookup-failed");
  });

  it("returns inactive when hrStatus is not Active", () => {
    const v = computeVerification({
      hrStatus: "Terminated",
      department: "HOUSING/DINING/HOSPITALITY",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "inactive");
  });

  it("returns non-hdh when active but department is not HDH", () => {
    const v = computeVerification({
      hrStatus: "Active",
      department: "QUALCOMM INSTITUTE",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "non-hdh");
  });

  it("returns verified when active and HDH", () => {
    const v = computeVerification({
      hrStatus: "Active",
      department: "DINING SERVICES",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "verified");
  });
});

describe("runPaperOathPrepare — Path B verification (roster-matched names)", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-verify-"));
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

  it("enqueues verify items for roster-matched signed records", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Alice Adams", true, 0, "04/27/2026")])) as never);

    const allItemIdsSent: string[] = [];
    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      for (const input of inputs as Array<{
        name?: string;
        emplId?: string;
        __prepIndex: number;
        __itemId: string;
      }>) {
        allItemIdsSent.push(input.__itemId);
      }
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        for (const input of inputs as Array<{
          name?: string;
          emplId?: string;
          __prepIndex: number;
          __itemId: string;
        }>) {
          const row = {
            workflow: "eid-lookup",
            timestamp: new Date().toISOString(),
            id: input.__itemId,
            runId: input.__itemId,
            status: "done",
            data: {
              emplId: "10001",
              hrStatus: "Active",
              department: "HOUSING/DINING/HOSPITALITY",
              personOrgScreenshot: "person-org-1.png",
            },
          };
          appendFileSync(eidFile, JSON.stringify(row) + "\n");
        }
      }, 50);
    });

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1500));

    const verifyIds = allItemIdsSent.filter((id) => id.includes("oath-verify-"));
    assert.equal(verifyIds.length, 1, `expected one oath-verify- item, got ids: ${allItemIdsSent.join(",")}`);

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      verification?: { state: string };
      selected: boolean;
    }>;
    assert.equal(records[0].verification?.state, "verified");
    assert.equal(records[0].selected, true);
  });
});

describe("runPaperOathPrepare — Path A skips dedicated verify enqueue", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-verify-"));
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

  it("eid-lookup records do NOT get a separate oath-verify- enqueue", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Charlie Carrot", true, 0, "04/27/2026")])) as never);

    const allItemIdsSent: string[] = [];
    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      for (const input of inputs as Array<{
        name?: string;
        emplId?: string;
        __prepIndex: number;
        __itemId: string;
      }>) {
        allItemIdsSent.push(input.__itemId);
      }
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        for (const input of inputs as Array<{
          name?: string;
          emplId?: string;
          __prepIndex: number;
          __itemId: string;
        }>) {
          const row = {
            workflow: "eid-lookup",
            timestamp: new Date().toISOString(),
            id: input.__itemId,
            runId: input.__itemId,
            status: "done",
            data: {
              emplId: "10999",
              hrStatus: "Active",
              department: "HOUSING/DINING/HOSPITALITY",
              personOrgScreenshot: "person-org-1.png",
            },
          };
          appendFileSync(eidFile, JSON.stringify(row) + "\n");
        }
      }, 50);
    });

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1500));

    const prepIds = allItemIdsSent.filter((id) => id.includes("oath-prep-"));
    const verifyIds = allItemIdsSent.filter((id) => id.includes("oath-verify-"));
    assert.equal(prepIds.length, 1);
    assert.equal(verifyIds.length, 0, "Path A should NOT enqueue a separate oath-verify- item");

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      verification?: { state: string };
      selected: boolean;
    }>;
    assert.equal(records[0].matchState, "resolved");
    assert.equal(records[0].verification?.state, "verified");
    assert.equal(records[0].selected, true);
  });
});

describe("runPaperOathPrepare — auto-deselect on inactive verification", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-verify-"));
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

  it("deselects a record whose verification finalizes as inactive", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRow("Alice Adams", true, 0, "04/27/2026")])) as never);

    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      setTimeout(() => {
        const eidFile = join(trackerDir, `eid-lookup-${dateLocal()}.jsonl`);
        for (const input of inputs as Array<{
          name?: string;
          emplId?: string;
          __prepIndex: number;
          __itemId: string;
        }>) {
          const row = {
            workflow: "eid-lookup",
            timestamp: new Date().toISOString(),
            id: input.__itemId,
            runId: input.__itemId,
            status: "done",
            data: {
              emplId: "10001",
              hrStatus: "Terminated",
              department: "HOUSING/DINING/HOSPITALITY",
              personOrgScreenshot: "person-org-1.png",
            },
          };
          appendFileSync(eidFile, JSON.stringify(row) + "\n");
        }
      }, 50);
    });

    await runPaperOathPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1500));

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      verification?: { state: string };
      selected: boolean;
    }>;
    assert.equal(records[0].verification?.state, "inactive");
    assert.equal(records[0].selected, false);
  });
});
