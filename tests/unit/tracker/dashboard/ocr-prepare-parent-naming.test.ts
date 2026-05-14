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
    assert.equal(pending.data.__name, "Oath · #90ab");
    assert.equal(pending.data.__queueTitle, "Oath · #90ab");
    assert.equal(pending.data.__queueTitleKind, "batch");
    assert.equal(pending.data.__queueRootTitle, "Oath · #90ab");
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

test("writeOriginParentPending emits a 'Oath Signature Request' child row marked done", () => {
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
    // Find the request child rows by parentRunId
    const childRows = rows.filter(
      (r) => (r as { parentRunId?: string }).parentRunId === "parent-run-9999",
    );
    assert.ok(childRows.length >= 2, "expected at least pending+done child rows");
    const doneChild = childRows.find(
      (r) => (r as { status?: string }).status === "done",
    ) as { status: string; parentRunId: string; data: Record<string, string> } | undefined;
    assert.ok(doneChild, "expected a done child row");
    assert.equal(doneChild!.data.__name, "Oath Signature Request");
    assert.equal(doneChild!.data.parentSubject, "Oath · #9999");
    assert.equal(doneChild!.data.__queueRootTitle, "Oath · #9999");
    assert.equal(doneChild!.data.__queueTitleKind, "delegation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
