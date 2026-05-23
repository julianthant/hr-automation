import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveParentSubject } from "../../../../src/services/ocr/parent-subject.js";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("resolveParentSubject reads parent.__name from the origin workflow tracker", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-parent-"));
  try {
    appendFileSync(
      join(dir, `oath-signature-${todayLocal()}.jsonl`),
      JSON.stringify({
        workflow: "oath-signature",
        timestamp: new Date().toISOString(),
        id: "ocr-prep-x",
        runId: "parent-9999",
        status: "running",
        data: { __name: "Oath Signature · #9999" },
      }) + "\n",
    );
    const v = resolveParentSubject({
      parentRunId: "parent-9999",
      originWorkflow: "oath-signature",
      trackerDir: dir,
    });
    assert.equal(v, "Oath Signature · #9999");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveParentSubject returns undefined when no match", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-parent-miss-"));
  try {
    const v = resolveParentSubject({
      parentRunId: "missing",
      originWorkflow: "oath-signature",
      trackerDir: dir,
    });
    assert.equal(v, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveParentSubject returns undefined when parentRunId or originWorkflow missing", () => {
  assert.equal(
    resolveParentSubject({ parentRunId: undefined, originWorkflow: "x" }),
    undefined,
  );
  assert.equal(
    resolveParentSubject({ parentRunId: "y", originWorkflow: undefined }),
    undefined,
  );
});
