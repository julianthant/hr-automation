import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOcrApproveHandler } from "../../../../src/tracker/dashboard/ocr/approve.js";

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

test("approve-batch preserves parent __name on done row + threads parentSubject into kernel inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-name-"));
  try {
    // Seed: OCR session row with parentRunId.
    appendFileSync(
      join(dir, `ocr-${todayLocal()}.jsonl`),
      JSON.stringify({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "sess-x",
        runId: "ocr-run-x",
        parentRunId: "parent-1234",
        status: "done",
        step: "awaiting-approval",
        data: { formType: "emergency-contact", sessionId: "sess-x", __name: "Emergency Contact · #1234", parentRunId: "parent-1234", dryRun: "false" },
      }) + "\n",
    );
    // Emergency-contact parent prep row.
    appendFileSync(
      join(dir, `emergency-contact-${todayLocal()}.jsonl`),
      JSON.stringify({
        workflow: "emergency-contact",
        timestamp: new Date().toISOString(),
        id: "ocr-prep-sess-x",
        runId: "parent-1234",
        status: "running",
        data: {
          __name: "Emergency Contact · #1234",
          __id: "ocr-prep-sess-x",
          mode: "prepare",
          pdfOriginalName: "x.pdf",
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

    // Parent row's __name preserved on the approved row.
    const ecRows = readJsonl(join(dir, `emergency-contact-${todayLocal()}.jsonl`));
    const approved = ecRows.find(
      (r) => (r as { step?: string }).step === "approved",
    ) as { data: Record<string, string> } | undefined;
    assert.ok(approved, "approved row should exist");
    assert.equal(approved!.data.__name, "Emergency Contact · #1234");

    // Captured kernel input carries parentSubject.
    assert.ok(captured.length >= 1, "at least one input captured");
    const first = captured[0] as { parentSubject?: string; employee?: { employeeId?: string } };
    assert.equal(first.parentSubject, "Emergency Contact · #1234");
    assert.equal(first.employee?.employeeId, "10874100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve-batch omits parentSubject when no parent row found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-no-parent-"));
  try {
    // Seed only the OCR session row, with NO parentRunId.
    appendFileSync(
      join(dir, `ocr-${todayLocal()}.jsonl`),
      JSON.stringify({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: "sess-y",
        runId: "ocr-run-y",
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
