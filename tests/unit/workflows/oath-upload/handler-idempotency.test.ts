import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPriorTicketForSession } from "../../../../src/workflows/oath-upload/handler.js";
import { dateLocal, rowFilePath, rowsDir } from "../../../../src/tracker/jsonl.js";

describe("oath-upload retry/restart idempotency — findPriorTicketForSession", () => {
  it("returns null when no prior ticketNumber exists", () => {
    const result = findPriorTicketForSession("nonexistent", undefined, "/tmp/nonexistent-dir-for-test");
    assert.equal(result, null);
  });

  it("returns null when no prior run exists in any JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const result = findPriorTicketForSession("no-such-session", undefined, dir);
    assert.equal(result, null);
  });

  it("returns ticket number when prior run with same sessionId filed one (same runId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "session-abc",
      runId: "test-run-1",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "HRC0123456" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), line + "\n");

    const result = findPriorTicketForSession("session-abc", undefined, dir);
    assert.equal(result, "HRC0123456");
  });

  it("returns ticket number when retry assigns a NEW runId but same sessionId (Contract 2 retry safety)", () => {
    // This is the actual Bug #1 regression: prior run filed a ticket with runId-A;
    // retry runs with new runId-B but same sessionId. The probe must still find
    // the prior ticket so we don't submit a duplicate.
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const priorRun = JSON.stringify({
      workflow: "oath-upload",
      id: "session-shared",
      runId: "original-run",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "HRC0987654" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), priorRun + "\n");

    // The retry passes the same sessionId but the handler now has a new ctx.runId.
    // findPriorTicketForSession must still find the ticket.
    const result = findPriorTicketForSession("session-shared", undefined, dir);
    assert.equal(result, "HRC0987654");
  });

  it("ignores dry-run sentinel ticketNumber", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "session-dry",
      runId: "test-run-dry",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "DRY RUN - not submitted" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), line + "\n");

    const result = findPriorTicketForSession("session-dry", undefined, dir);
    assert.equal(result, null);
  });

  it("ignores rows with empty ticketNumber", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "session-running",
      runId: "test-run-2",
      ts: new Date().toISOString(),
      status: "running",
      step: "fill-form",
      data: { ticketNumber: "" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), line + "\n");

    const result = findPriorTicketForSession("session-running", undefined, dir);
    assert.equal(result, null);
  });

  it("rejects entries with mismatched pdfHash even when sessionId matches", () => {
    // Defensive: protects against an operator reusing a sessionId for a
    // different pdf (theoretically possible if sessionId generation collides).
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "session-xyz",
      runId: "test-run-3",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "HRC0111111", pdfHash: "hash-aaa" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), line + "\n");

    // Same sessionId but different hash → no match.
    const result = findPriorTicketForSession("session-xyz", "hash-bbb", dir);
    assert.equal(result, null);
  });

  it("matches when sessionId and pdfHash both align", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "session-hashed",
      runId: "test-run-4",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "HRC0222222", pdfHash: "hash-match" },
    });
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("oath-upload", date, dir), line + "\n");

    const result = findPriorTicketForSession("session-hashed", "hash-match", dir);
    assert.equal(result, "HRC0222222");
  });
});
