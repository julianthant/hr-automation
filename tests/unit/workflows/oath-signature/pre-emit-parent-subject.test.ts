import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oathSignaturePreEmitPending } from "../../../../src/workflows/oath-signature/workflow.js";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("oathSignaturePreEmitPending stamps __name from parentSubject when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-preemit-"));
  try {
    oathSignaturePreEmitPending(
      { emplId: "10874100", parentSubject: "Oath Signature · #abcd" } as never,
      "oath-run-1",
      "parent-run-9999",
      "oath-item-1",
      dir,
    );
    const rows = readJsonl(join(dir, `oath-signature-${todayLocal()}.jsonl`));
    assert.equal(rows.length, 1);
    const r = rows[0] as { parentRunId?: string; data: Record<string, string> };
    assert.equal(r.parentRunId, "parent-run-9999");
    assert.equal(r.data.__name, "Oath Signature · #abcd");
    assert.equal(r.data.parentSubject, "Oath Signature · #abcd");
    assert.equal(r.data.emplId, "10874100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathSignaturePreEmitPending omits __name when no parentSubject (back-compat)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-preemit-fallback-"));
  try {
    oathSignaturePreEmitPending(
      { emplId: "10874100" } as never,
      "oath-run-2",
      undefined,
      "oath-item-2",
      dir,
    );
    const rows = readJsonl(join(dir, `oath-signature-${todayLocal()}.jsonl`));
    const data = rows[0]!.data as Record<string, string>;
    assert.equal(data.parentSubject, undefined);
    assert.equal(data.__name, undefined);
    assert.equal(data.emplId, "10874100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
