import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __setUploadsDirForTests,
  __setOathPrepareForTests,
  handleOathApproveBatch,
  handleOathDiscardPrepare,
  handleOathPrepareUpload,
  sweepStuckOathPrepRows,
} from "../../../src/tracker/oath-signature-http.js";
import { dateLocal, trackEvent } from "../../../src/tracker/jsonl.js";

interface TrackerLine {
  id: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
  error?: string;
  runId?: string;
}

function readLines(trackerDir: string): TrackerLine[] {
  const file = join(trackerDir, `oath-signature-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrackerLine);
}

describe("sweepStuckOathPrepRows", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-sweep-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("marks pending and running prep rows as failed", () => {
    const id = "oath-prep-1";
    const runId = "run-1";
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "ocr",
        data: { mode: "prepare", pdfPath: "/tmp/x.pdf" },
      },
      tmp,
    );
    const swept = sweepStuckOathPrepRows(tmp);
    assert.equal(swept, 1);
    const lines = readLines(tmp);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "failed");
    assert.equal(last.runId, runId);
    assert.match(last.error ?? "", /Dashboard restarted/);
  });

  it("ignores already-terminal prep rows", () => {
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id: "oath-prep-2",
        runId: "run-2",
        status: "done",
        data: { mode: "prepare", pdfPath: "/tmp/y.pdf" },
      },
      tmp,
    );
    assert.equal(sweepStuckOathPrepRows(tmp), 0);
  });

  it("ignores non-prepare oath-signature rows (real per-item rows)", () => {
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id: "10873611",
        runId: "run-3",
        status: "running",
        data: {},
      },
      tmp,
    );
    assert.equal(sweepStuckOathPrepRows(tmp), 0);
  });
});

describe("handleOathPrepareUpload", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-prep-up-"));
  });
  afterEach(() => {
    __setUploadsDirForTests(undefined);
    __setOathPrepareForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects empty PDF bytes", async () => {
    const r = await handleOathPrepareUpload(
      { pdfBytes: Buffer.alloc(0), pdfOriginalName: "x.pdf" },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("returns parentRunId synchronously and forwards runId to runPaperOathPrepare", async () => {
    const uploads = join(tmp, "uploads");
    __setUploadsDirForTests(uploads);
    const calls: Array<{ runId?: string; pdfPath: string }> = [];
    __setOathPrepareForTests(async (input) => {
      calls.push({ runId: input.runId, pdfPath: input.pdfPath });
      return { runId: input.runId ?? "fallback", parentRunId: input.runId ?? "fallback" };
    });
    const result = await handleOathPrepareUpload(
      {
        pdfBytes: Buffer.from("PDF"),
        pdfOriginalName: "scan.pdf",
      },
      tmp,
    );
    assert.equal(result.ok, true);
    assert.ok(result.parentRunId);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, result.parentRunId);
    assert.ok(existsSync(calls[0].pdfPath));
  });
});

describe("handleOathApproveBatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-approve-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function emitPrepRow(runId: string): string {
    const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "done",
        data: {
          mode: "prepare",
          pdfPath: "/tmp/x.pdf",
          pdfOriginalName: "x.pdf",
          rosterPath: "roster.xlsx",
          records: "[]",
        },
      },
      tmp,
    );
    return id;
  }

  it("rejects when parentRunId has no prep row", async () => {
    const r = await handleOathApproveBatch(
      { parentRunId: "missing", records: [makeRec("Alice", "10001")] },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("rejects when no records are approvable", async () => {
    const runId = "run-only-pending";
    emitPrepRow(runId);
    const r = await handleOathApproveBatch(
      { parentRunId: runId, records: [makeRec("Alice", "", "lookup-pending")] },
      tmp,
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /no approvable/);
  });

  it("rejects when empty records array", async () => {
    const r = await handleOathApproveBatch({ parentRunId: "x", records: [] }, tmp);
    assert.equal(r.ok, false);
  });

  it("rejects records lacking a valid 5+ digit EID", async () => {
    const runId = "run-bad-eid";
    emitPrepRow(runId);
    const r = await handleOathApproveBatch(
      { parentRunId: runId, records: [makeRec("Alice", "abc", "matched")] },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("rejects deselected records as unapprovable", async () => {
    const runId = "run-deselected";
    emitPrepRow(runId);
    const rec = makeRec("Alice", "10001", "matched");
    (rec as { selected: boolean }).selected = false;
    const r = await handleOathApproveBatch(
      { parentRunId: runId, records: [rec] },
      tmp,
    );
    assert.equal(r.ok, false);
  });
});

describe("handleOathDiscardPrepare", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oath-discard-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("rejects an unknown parentRunId", async () => {
    const r = await handleOathDiscardPrepare({ parentRunId: "nope" }, tmp);
    assert.equal(r.ok, false);
  });

  it("emits a failed/discarded row when prep is in progress", async () => {
    const runId = "run-discard";
    const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "ocr",
        data: { mode: "prepare", pdfPath: "/tmp/missing.pdf" },
      },
      tmp,
    );
    const r = await handleOathDiscardPrepare({ parentRunId: runId, reason: "user" }, tmp);
    assert.equal(r.ok, true);
    const lines = readLines(tmp);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "failed");
    assert.equal(last.step, "discarded");
  });

  it("refuses to discard an already-terminal row", async () => {
    const runId = "run-already-done";
    const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "done",
        data: { mode: "prepare", pdfPath: "/tmp/x.pdf" },
      },
      tmp,
    );
    const r = await handleOathDiscardPrepare({ parentRunId: runId }, tmp);
    assert.equal(r.ok, false);
  });

  it("preserves the uploaded PDF when the path is missing on disk (best-effort)", async () => {
    const runId = "run-discard-missing-pdf";
    const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "ocr",
        data: { mode: "prepare", pdfPath: "/never-exists/no.pdf" },
      },
      tmp,
    );
    const r = await handleOathDiscardPrepare({ parentRunId: runId }, tmp);
    assert.equal(r.ok, true);
  });
});

// ─── helpers ───

function makeRec(name: string, eid = "", matchState: string = "matched"): unknown {
  return {
    sourcePage: 1,
    rowIndex: 0,
    printedName: name,
    signed: true,
    dateSigned: "04/27/2026",
    notes: [],
    employeeId: eid,
    matchState,
    matchSource: matchState === "matched" ? "roster" : undefined,
    selected: true,
    warnings: [],
  };
}
