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
  runPrepare,
  __setOcrForTests,
  __setEidLookupEnqueueForTests,
  computeVerification,
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

describe("computeVerification — discriminator states", () => {
  it("returns lookup-failed when hrStatus is missing", () => {
    const v = computeVerification({});
    assert.equal(v.state, "lookup-failed");
    if (v.state === "lookup-failed") {
      assert.equal(v.error, "no result");
      assert.ok(v.checkedAt);
    }
  });

  it("returns inactive when hrStatus is not Active", () => {
    const v = computeVerification({
      hrStatus: "Terminated",
      department: "HOUSING/DINING/HOSPITALITY",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "inactive");
    if (v.state === "inactive") {
      assert.equal(v.hrStatus, "Terminated");
      assert.equal(v.department, "HOUSING/DINING/HOSPITALITY");
      assert.equal(v.screenshotFilename, "shot.png");
    }
  });

  it("returns non-hdh when active but department is not HDH", () => {
    const v = computeVerification({
      hrStatus: "Active",
      department: "QUALCOMM INSTITUTE",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "non-hdh");
    if (v.state === "non-hdh") {
      assert.equal(v.department, "QUALCOMM INSTITUTE");
      assert.equal(v.screenshotFilename, "shot.png");
    }
  });

  it("returns verified when active and HDH", () => {
    const v = computeVerification({
      hrStatus: "Active",
      department: "HOUSING/DINING/HOSPITALITY",
      personOrgScreenshot: "shot.png",
    });
    assert.equal(v.state, "verified");
    if (v.state === "verified") {
      assert.equal(v.hrStatus, "Active");
      assert.equal(v.department, "HOUSING/DINING/HOSPITALITY");
      assert.equal(v.screenshotFilename, "shot.png");
    }
  });
});

describe("runPrepare — Path B verification (form-EID + roster-verified-name)", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-verify-"));
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

  it("enqueues verify items for matched (form-EID) records and patches verification on terminal entry", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRecord("Alice Adams", "10001")])) as never);

    const enqueueCalls: Array<{ inputs: unknown[]; parentRunId: string }> = [];
    __setEidLookupEnqueueForTests(async (inputs, parentRunId) => {
      enqueueCalls.push({ inputs, parentRunId });
      // Simulate verification result coming back from eid-lookup daemon.
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

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1500));

    // The enqueue should have been called (Path B for matched records).
    assert.ok(enqueueCalls.length > 0, "eid-lookup enqueue should have been called for verification");
    // Should be exactly one verify item with emplId
    const allInputs = enqueueCalls.flatMap((c) => c.inputs as Array<{ emplId?: string; name?: string; __itemId: string }>);
    const verifyInputs = allInputs.filter((i) => "emplId" in i && i.emplId);
    assert.equal(verifyInputs.length, 1, "Expected exactly one verify input");
    assert.equal(verifyInputs[0].emplId, "10001");
    assert.ok(verifyInputs[0].__itemId.includes("ec-verify-"), `expected ec-verify- prefix, got ${verifyInputs[0].__itemId}`);

    // Tracker entries should reflect verification.
    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      verification?: { state: string; department?: string };
      selected: boolean;
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0].verification?.state, "verified");
    assert.equal(records[0].selected, true);
  });
});

describe("runPrepare — Path A (eid-lookup) skips dedicated verify enqueue", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-verify-"));
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

  it("only enqueues a name-lookup item for unresolved-name records (no separate verify enqueue)", async () => {
    __setOcrForTests((async () =>
      fakeOcrResult([makeRecord("Charlie Carrot", "")])) as never);

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

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
      rosterDir,
      uploadsDir,
      trackerDir,
    });

    await new Promise((r) => setTimeout(r, 1500));

    // Only the name-lookup ec-prep- item should have been enqueued — NO ec-verify- for that same record.
    const prepIds = allItemIdsSent.filter((id) => id.includes("ec-prep-"));
    const verifyIds = allItemIdsSent.filter((id) => id.includes("ec-verify-"));
    assert.equal(prepIds.length, 1, "expected one ec-prep- item");
    assert.equal(verifyIds.length, 0, "Path A should NOT enqueue a separate ec-verify- item");

    const lines = readTrackerLines(trackerDir);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "done");
    const records = JSON.parse(last.data?.records ?? "[]") as Array<{
      matchState: string;
      verification?: { state: string };
      selected: boolean;
    }>;
    assert.equal(records[0].matchState, "resolved");
    // Verification flows from the SAME eid-lookup row (Path A).
    assert.equal(records[0].verification?.state, "verified");
    assert.equal(records[0].selected, true);
  });
});

describe("runPrepare — auto-deselect on inactive verification", () => {
  let tmp: string, trackerDir: string, rosterDir: string, uploadsDir: string, pdfPath: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-verify-"));
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
      fakeOcrResult([makeRecord("Alice Adams", "10001")])) as never);

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

    await runPrepare({
      pdfPath,
      pdfOriginalName: "scan.pdf",
      rosterMode: "existing",
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
    assert.equal(records[0].selected, false, "record should be auto-deselected when verification fails");
  });
});
