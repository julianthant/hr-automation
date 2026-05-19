import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test_writeOriginParentPending as writeOriginParentPending }
  from "../../../../src/tracker/dashboard/ocr/prepare.js";

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("writeOriginParentPending writes Oath batch queue title fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-prep-naming-"));
  try {
    writeOriginParentPending({
      originWorkflow: "oath-signature",
      parentItemId: "ocr-prep-abc123",
      parentRunId: "1234567890ab",
      pdfOriginalName: "Xerox Scan.pdf",
      formType: "oath",
      ocrSessionId: "sess-1",
      ocrRunId: "ocr-run-1",
      trackerDir: dir,
    });
    const rows = readJsonl(join(dir, `oath-signature-${todayLocal()}.jsonl`));
    assert.ok(rows.length >= 1);
    const pending = rows[0] as { data: Record<string, string> };
    assert.equal(pending.data.__name, "Oath · 90ab");
    assert.equal(pending.data.__queueTitle, "Oath · 90ab");
    assert.equal(pending.data.__queueTitleKind, "batch");
    assert.equal(pending.data.__queueRootTitle, "Oath · 90ab");
    assert.equal(pending.data.pdfOriginalName, "Xerox Scan.pdf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emergency-contact prep uses the registry label too", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-prep-naming-"));
  try {
    writeOriginParentPending({
      originWorkflow: "emergency-contact",
      parentItemId: "ocr-prep-xyz",
      parentRunId: "abcdef123456",
      pdfOriginalName: "ec.pdf",
      formType: "emergency-contact",
      ocrSessionId: "sess-2",
      ocrRunId: "ocr-run-2",
      trackerDir: dir,
    });
    const rows = readJsonl(join(dir, `emergency-contact-${todayLocal()}.jsonl`));
    const pending = rows[0] as { data: Record<string, string> };
    assert.equal(pending.data.__name, "Emergency Contact · #3456");
    assert.equal(pending.data.__queueTitle, "Emergency Contact · #3456");
    assert.equal(pending.data.__queueTitleKind, "batch");
    assert.equal(pending.data.__queueRootTitle, "Emergency Contact · #3456");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOriginParentPending does not emit a synthetic request child row", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-prep-req-"));
  try {
    writeOriginParentPending({
      originWorkflow: "oath-signature",
      parentItemId: "ocr-prep-abc",
      parentRunId: "parent-run-9999",
      pdfOriginalName: "test.pdf",
      formType: "oath",
      ocrSessionId: "sess",
      ocrRunId: "ocr-run",
      trackerDir: dir,
    });
    const rows = readJsonl(join(dir, `oath-signature-${todayLocal()}.jsonl`));
    const childRows = rows.filter(
      (r) => (r as { parentRunId?: string }).parentRunId === "parent-run-9999",
    );
    assert.equal(childRows.length, 0, "origin prep parent should be the only queue-panel row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOriginParentPending groups multi-file oath uploads without reusing file run ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-prep-group-"));
  try {
    writeOriginParentPending({
      originWorkflow: "oath-signature",
      parentItemId: "ocr-prep-file-1",
      parentRunId: "file-run-1111",
      originBatchRunId: "batch-run-9999",
      originBatchSubject: "Oath · 9999",
      pdfOriginalName: "first.pdf",
      formType: "oath",
      ocrSessionId: "sess-1",
      ocrRunId: "ocr-run-1",
      trackerDir: dir,
    });

    const rows = readJsonl(join(dir, `oath-signature-${todayLocal()}.jsonl`));
    const parent = rows.find(
      (r) => (r as { id?: string; status?: string }).id === "ocr-prep-file-1" && (r as { status?: string }).status === "running",
    ) as { runId: string; parentRunId?: string; data: Record<string, string> } | undefined;
    const requestRows = rows.filter(
      (r) => String((r as { id?: string }).id ?? "").endsWith("-request"),
    );

    assert.ok(parent, "expected grouped file parent row");
    assert.equal(parent.runId, "file-run-1111");
    assert.equal(parent.parentRunId, "batch-run-9999");
    assert.equal(parent.data.__name, "Oath · 9999");
    assert.equal(parent.data.__queueRootTitle, "Oath · 9999");
    assert.equal(parent.data.pdfOriginalName, "first.pdf");

    assert.deepEqual(requestRows, [], "multi-file prep should not emit request child rows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
