import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __setRosterDirsForTests,
  __setUploadsDirForTests,
  __setPrepareForTests,
  handleApproveBatch,
  handleDiscardPrepare,
  handlePrepareUpload,
  listRosters,
  sweepStuckPrepRows,
} from "../../../src/tracker/emergency-contact-http.js";
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
  const file = join(trackerDir, `emergency-contact-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrackerLine);
}

describe("listRosters", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rosters-"));
  });
  afterEach(() => {
    __setRosterDirsForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when no dirs exist", () => {
    __setRosterDirsForTests([join(tmp, "missing")]);
    assert.deepEqual(listRosters(), []);
  });

  it("lists xlsx files sorted newest first", () => {
    const dir = join(tmp, "rosters");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.xlsx"), "old");
    // Force a measurable mtime gap on filesystems with ms precision.
    const past = new Date(Date.now() - 5_000);
    utimesSync(join(dir, "old.xlsx"), past, past);
    writeFileSync(join(dir, "new.xlsx"), "new");
    writeFileSync(join(dir, "ignore.txt"), "ignore");
    __setRosterDirsForTests([dir]);
    const result = listRosters();
    assert.equal(result.length, 2);
    assert.equal(result[0].filename, "new.xlsx");
    assert.equal(result[1].filename, "old.xlsx");
  });
});

describe("sweepStuckPrepRows", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sweep-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("marks pending and running prep rows as failed", () => {
    const id = "ec-prep-1";
    const runId = "run-1";
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "ocr",
        data: { mode: "prepare", pdfPath: "/tmp/x.pdf" },
      },
      tmp,
    );
    const swept = sweepStuckPrepRows(tmp);
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
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: "ec-prep-2",
        runId: "run-2",
        status: "done",
        data: { mode: "prepare", pdfPath: "/tmp/y.pdf" },
      },
      tmp,
    );
    assert.equal(sweepStuckPrepRows(tmp), 0);
  });

  it("ignores non-prepare emergency-contact rows", () => {
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: "p01-12345",
        runId: "run-3",
        status: "running",
        data: {},
      },
      tmp,
    );
    assert.equal(sweepStuckPrepRows(tmp), 0);
  });
});

describe("handlePrepareUpload", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ec-prep-up-"));
  });
  afterEach(() => {
    __setUploadsDirForTests(undefined);
    __setPrepareForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects empty PDF bytes", async () => {
    const r = await handlePrepareUpload(
      { pdfBytes: Buffer.alloc(0), pdfOriginalName: "x.pdf", rosterMode: "existing" },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("rejects an invalid rosterMode", async () => {
    const r = await handlePrepareUpload(
      {
        pdfBytes: Buffer.from("FAKE"),
        pdfOriginalName: "x.pdf",
        rosterMode: "garbage" as never,
      },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("returns parentRunId synchronously and forwards the runId to runPrepare", async () => {
    const uploads = join(tmp, "uploads");
    __setUploadsDirForTests(uploads);
    const calls: Array<{ runId?: string; pdfPath: string }> = [];
    __setPrepareForTests(async (input) => {
      calls.push({ runId: input.runId, pdfPath: input.pdfPath });
      return { runId: input.runId ?? "fallback", parentRunId: input.runId ?? "fallback" };
    });
    const result = await handlePrepareUpload(
      {
        pdfBytes: Buffer.from("PDF"),
        pdfOriginalName: "scan.pdf",
        rosterMode: "existing",
      },
      tmp,
    );
    assert.equal(result.ok, true);
    assert.ok(result.parentRunId);
    // Give the fire-and-forget call a tick to land.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, result.parentRunId);
    assert.ok(existsSync(calls[0].pdfPath));
  });
});

describe("handleApproveBatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "approve-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function emitPrepRow(runId: string): string {
    const id = `ec-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "done",
        data: {
          mode: "prepare",
          pdfPath: "/tmp/x.pdf",
          pdfOriginalName: "x.pdf",
          rosterMode: "existing",
          rosterPath: "roster.xlsx",
          records: "[]",
        },
      },
      tmp,
    );
    return id;
  }

  it("rejects when parentRunId has no prep row", async () => {
    const r = await handleApproveBatch(
      { parentRunId: "missing", records: [makeRec("Alice", "10001")] },
      tmp,
    );
    assert.equal(r.ok, false);
  });

  it("rejects when no records are approvable", async () => {
    const runId = "run-only-pending";
    emitPrepRow(runId);
    const r = await handleApproveBatch(
      { parentRunId: runId, records: [makeRec("Alice", "", "lookup-pending")] },
      tmp,
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /no approvable/);
  });

  it("rejects when empty records array", async () => {
    const r = await handleApproveBatch({ parentRunId: "x", records: [] }, tmp);
    assert.equal(r.ok, false);
  });
});

describe("handleDiscardPrepare", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "discard-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("rejects an unknown parentRunId", async () => {
    const r = await handleDiscardPrepare({ parentRunId: "nope" }, tmp);
    assert.equal(r.ok, false);
  });

  it("emits a failed/discarded row when prep is in progress", async () => {
    const runId = "run-discard";
    const id = `ec-prep-${dateLocal()}-${runId.slice(0, 8)}`;
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "ocr",
        data: { mode: "prepare", pdfPath: "/tmp/missing.pdf" },
      },
      tmp,
    );
    const r = await handleDiscardPrepare({ parentRunId: runId, reason: "user" }, tmp);
    assert.equal(r.ok, true);
    const lines = readLines(tmp);
    const last = lines[lines.length - 1];
    assert.equal(last.status, "failed");
    assert.equal(last.step, "discarded");
  });

  it("refuses to discard an already-resolved row (approved or already-discarded)", async () => {
    // step: "approved" — operator already fanned out the kernel items
    const approvedRunId = "run-already-approved";
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: `ec-prep-${dateLocal()}-${approvedRunId.slice(0, 8)}`,
        runId: approvedRunId,
        status: "done",
        step: "approved",
        data: { mode: "prepare", pdfPath: "/tmp/x.pdf" },
      },
      tmp,
    );
    const a = await handleDiscardPrepare({ parentRunId: approvedRunId }, tmp);
    assert.equal(a.ok, false);

    // step: "discarded" — duplicate click on a stale view
    const discardedRunId = "run-already-discarded";
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: `ec-prep-${dateLocal()}-${discardedRunId.slice(0, 8)}`,
        runId: discardedRunId,
        status: "failed",
        step: "discarded",
        data: { mode: "prepare", pdfPath: "/tmp/y.pdf" },
      },
      tmp,
    );
    const d = await handleDiscardPrepare({ parentRunId: discardedRunId }, tmp);
    assert.equal(d.ok, false);
  });

  it("allows discarding a failed-from-restart row so the operator can clear it", async () => {
    // The sweep marks orphaned prep rows as failed/interrupted on dashboard
    // startup. The operator must be able to dismiss them — otherwise the
    // failed row sticks on the dashboard forever.
    const runId = "run-stuck-failed";
    trackEvent(
      {
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: `ec-prep-${dateLocal()}-${runId.slice(0, 8)}`,
        runId,
        status: "failed",
        step: "interrupted",
        data: { mode: "prepare", pdfPath: "/tmp/x.pdf" },
        error: "Dashboard restarted while prepare was in progress — please re-upload",
      },
      tmp,
    );
    const r = await handleDiscardPrepare({ parentRunId: runId }, tmp);
    assert.equal(r.ok, true);
  });

  it("finds prep rows in earlier-date tracker files and writes the discard line back into that file", async () => {
    // Reproduces the user-facing bug: prep row was created on a previous
    // local-day, lives in `emergency-contact-<earlier>.jsonl`, but the operator
    // is discarding it today. The handler must scan across date files AND
    // emit the resolution line into the same file (so the dashboard's
    // per-date SSE reflects the new state when viewing the original date).
    const earlier = "2099-01-01";
    const runId = "run-on-earlier-day";
    const id = `ec-prep-${earlier}-${runId.slice(0, 8)}`;
    const earlierFile = join(tmp, `emergency-contact-${earlier}.jsonl`);
    writeFileSync(
      earlierFile,
      JSON.stringify({
        workflow: "emergency-contact",
        timestamp: `${earlier}T12:00:00.000Z`,
        id,
        runId,
        status: "failed",
        step: "interrupted",
        data: { mode: "prepare", pdfPath: "/tmp/cross-date.pdf" },
        error: "Dashboard restarted while prepare was in progress — please re-upload",
      }) + "\n",
    );
    const r = await handleDiscardPrepare({ parentRunId: runId }, tmp);
    assert.equal(r.ok, true);
    // Resolution line must land in the prep row's date file, not today's.
    const earlierLines = readFileSync(earlierFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrackerLine);
    const discardLine = earlierLines.find((l) => l.runId === runId && l.step === "discarded");
    assert.ok(discardLine, "discard line should be appended to the prep row's date file");
    // Today's file should remain empty (no resolution leakage).
    const todayFile = join(tmp, `emergency-contact-${dateLocal()}.jsonl`);
    assert.equal(existsSync(todayFile), false, "no entry should be written to today's file");
  });
});

// ─── helpers ───

function makeRec(name: string, eid = "", matchState: string = "matched"): unknown {
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
    matchState,
    matchSource: matchState === "matched" ? "form" : undefined,
    selected: true,
    warnings: [],
  };
}
