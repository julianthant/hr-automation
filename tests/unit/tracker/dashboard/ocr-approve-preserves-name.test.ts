import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOcrApproveHandler } from "../../../../src/tracker/dashboard/ocr/approve.js";
import { openControlDb } from "../../../../src/core/control-db.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/paths.js";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJsonl(p: string): Array<Record<string, unknown>> {
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function emergencyContactPreviewRecord(employeeId: string, employeeName: string): Record<string, unknown> {
  return {
    sourcePage: 1,
    employee: { name: employeeName, employeeId },
    emergencyContact: {
      name: `${employeeName} Contact`,
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
      cellPhone: "(555) 555-0100",
    },
    notes: [],
    selected: true,
    matchState: "matched",
    warnings: [],
  };
}

test("approve-batch threads OCR parentSubject into kernel inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-name-"));
  try {
    // Seed: OCR session row with parentRunId and explicit parentSubject.
    mkdirSync(rowsDir(dir), { recursive: true });
    appendFileSync(
      rowFilePath("ocr", todayLocal(), dir),
      JSON.stringify({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "sess-x",
        runId: "ocr-run-x",
        parentRunId: "parent-1234",
        status: "running",
        step: "awaiting-approval",
        data: {
          formType: "emergency-contact",
          sessionId: "sess-x",
          parentSubject: "Emergency Contact · #1234",
          dryRun: "false",
        },
      }) + "\n",
    );

    let captured: unknown[] = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (_workflow, inputs, _deriveItemId, _opts) => {
        captured = inputs;
        return { enqueued: [] };
      },
    });
    const res = await handler({
      sessionId: "sess-x",
      runId: "ocr-run-x",
      records: [emergencyContactPreviewRecord("10874100", "Alice One")],
    });
    assert.equal(res.status, 200);

    // Sleep briefly to let the fire-and-forget dispatch complete.
    await new Promise((r) => setTimeout(r, 250));

    // OCR approved row keeps the explicit parentSubject for later re-reads.
    const ocrRows = readJsonl(rowFilePath("ocr", todayLocal(), dir));
    const approved = ocrRows.find(
      (r) => (r as { step?: string }).step === "approved",
    ) as { data: Record<string, string> } | undefined;
    assert.ok(approved, "approved row should exist");
    assert.equal(approved!.data.parentSubject, "Emergency Contact · #1234");

    // Captured kernel input carries parentSubject.
    assert.ok(captured.length >= 1, "at least one input captured");
    const first = captured[0] as { parentSubject?: string; employee?: { employeeId?: string } };
    assert.equal(first.parentSubject, "Emergency Contact · #1234");
    assert.equal(first.employee?.employeeId, "10874100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve-batch omits parentSubject when the review data carries none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-no-parent-"));
  try {
    // Delegated row (approve requires parentRunId since 2026-06-11) whose
    // review data carries NO parentSubject — the omission must propagate.
    mkdirSync(rowsDir(dir), { recursive: true });
    appendFileSync(
      rowFilePath("ocr", todayLocal(), dir),
      JSON.stringify({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "sess-y",
        runId: "ocr-run-y",
        parentRunId: "op-run-y",
        status: "running",
        step: "awaiting-approval",
        data: { formType: "emergency-contact", sessionId: "sess-y" },
      }) + "\n",
    );
    let captured: unknown[] = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (_workflow, inputs) => {
        captured = inputs;
        return { enqueued: [] };
      },
    });
    const res = await handler({
      sessionId: "sess-y",
      runId: "ocr-run-y",
      records: [emergencyContactPreviewRecord("10874100", "Alice One")],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    const first = captured[0] as { parentSubject?: string };
    assert.equal(first.parentSubject, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A dispatch failure can follow a committed child task, so it must stay
// recoverable rather than overlaying the review row with a terminal failure.
test("approve-batch dispatch failure preserves row identity and releases durable recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-fail-identity-"));
  try {
    mkdirSync(rowsDir(dir), { recursive: true });
    appendFileSync(
      rowFilePath("ocr", todayLocal(), dir),
      JSON.stringify({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "sess-fail",
        runId: "ocr-run-fail",
        parentRunId: "op-fail",
        status: "running",
        step: "awaiting-approval",
        data: {
          archetype: "preview",
          formType: "emergency-contact",
          sessionId: "sess-fail",
          queueRowKind: "file",
          pdfOriginalName: "emergency-contacts.pdf",
          __traceId: "ec-120000-fa11",
        },
      }) + "\n",
    );
    // Force the fan-out dispatch to throw after approval was claimed.
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async () => {
        throw new Error("boom: simulated dispatch failure");
      },
    });
    const res = await handler({
      sessionId: "sess-fail",
      runId: "ocr-run-fail",
      records: [emergencyContactPreviewRecord("10874100", "Alice One")],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const rows = readJsonl(rowFilePath("ocr", todayLocal(), dir));
    const failed = rows.find(
      (r) => (r as { step?: string }).step === "approve-failed",
    ) as { status?: string; data: Record<string, string> } | undefined;
    assert.equal(failed, undefined, "dispatch uncertainty must not emit a terminal failure row");
    const latest = rows.at(-1) as { data: Record<string, string> };
    assert.equal(latest.data.__traceId, "ec-120000-fa11");
    assert.equal(latest.data.queueRowKind, "file");
    assert.equal(latest.data.pdfOriginalName, "emergency-contacts.pdf");
    assert.equal(latest.data.formType, "emergency-contact");

    const durable = openControlDb({ trackerDir: dir }).db.prepare(`
      SELECT state, lease_expires_at_ms, error FROM ocr_approvals
      WHERE session_id = 'sess-fail' AND run_id = 'ocr-run-fail'
    `).get() as { state: string; lease_expires_at_ms: number; error: string | null };
    assert.equal(durable.state, "approving");
    assert.equal(durable.lease_expires_at_ms, 0);
    assert.match(durable.error ?? "", /simulated dispatch failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
