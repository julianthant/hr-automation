import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPriorTicketForRunId } from "../../../../src/workflows/oath-upload/handler.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";

describe("oath-upload restart idempotency", () => {
  it("findPriorTicketForRunId returns null when no prior ticketNumber exists", () => {
    const result = findPriorTicketForRunId("nonexistent", "/tmp/nonexistent-dir-for-test");
    assert.equal(result, null);
  });

  it("findPriorTicketForRunId returns null when no prior run exists in any JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const result = findPriorTicketForRunId("no-such-run", dir);
    assert.equal(result, null);
  });

  it("findPriorTicketForRunId returns ticket number when prior run filed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "pdf-1",
      runId: "test-run-1",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "HRC0123456" },
    });
    writeFileSync(join(dir, `oath-upload-${date}.jsonl`), line + "\n");

    const result = findPriorTicketForRunId("test-run-1", dir);
    assert.equal(result, "HRC0123456");
  });

  it("findPriorTicketForRunId ignores dry-run sentinel ticketNumber", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "pdf-1",
      runId: "test-run-dry",
      ts: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { ticketNumber: "DRY RUN - not submitted" },
    });
    writeFileSync(join(dir, `oath-upload-${date}.jsonl`), line + "\n");

    const result = findPriorTicketForRunId("test-run-dry", dir);
    assert.equal(result, null);
  });

  it("findPriorTicketForRunId ignores rows with empty ticketNumber", () => {
    const dir = mkdtempSync(join(tmpdir(), "oath-idem-"));
    const date = dateLocal();
    const line = JSON.stringify({
      workflow: "oath-upload",
      id: "pdf-1",
      runId: "test-run-2",
      ts: new Date().toISOString(),
      status: "running",
      step: "fill-form",
      data: { ticketNumber: "" },
    });
    writeFileSync(join(dir, `oath-upload-${date}.jsonl`), line + "\n");

    const result = findPriorTicketForRunId("test-run-2", dir);
    assert.equal(result, null);
  });
});
