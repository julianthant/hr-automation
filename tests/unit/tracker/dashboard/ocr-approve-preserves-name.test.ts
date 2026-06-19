import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOcrApproveHandler } from "../../../../src/tracker/dashboard/ocr/approve.js";
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
        status: "done",
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
        status: "done",
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

// ISS-006 (e2e run 20260618-2146): when an approve-batch dispatch FAILS, the
// failed row must INHERIT the prior OCR row's identity (__traceId, queueRowKind,
// pdfOriginalName, formType). Before the fix it re-emitted a bare
// `data: { archetype: "preview" }`, which latest-wins-merged and WIPED the row's
// title + trace (rendered as a cryptic "<sessionId> — failed") and severed the
// delegation-trace lineage through that node.
test("approve-batch failure preserves the row's identity fields (ISS-006)", async () => {
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
        status: "done",
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
    // Force the fan-out dispatch to throw -> exercises the approve-failed emit path.
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
    assert.ok(failed, "approve-failed row should exist");
    assert.equal(failed!.status, "failed");
    // The failure row must KEEP its identity (was wiped to null before the fix).
    assert.equal(failed!.data.__traceId, "ec-120000-fa11");
    assert.equal(failed!.data.queueRowKind, "file");
    assert.equal(failed!.data.pdfOriginalName, "emergency-contacts.pdf");
    assert.equal(failed!.data.formType, "emergency-contact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
