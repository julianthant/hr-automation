import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eidLookupPreEmitPending } from "../../../../src/workflows/eid-lookup/workflow.js";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("eidLookupPreEmitPending stamps __name from parentSubject when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "eid-preemit-"));
  try {
    eidLookupPreEmitPending(
      {
        name: "Barahona Martell, Carlos",
        parentSubject: "Oath Signature · #abcd",
      } as never,
      "eid-run-1",
      "parent-run-9999",
      "eid-item-1",
      dir,
    );
    const rows = readJsonl(join(dir, `eid-lookup-${todayLocal()}.jsonl`));
    assert.equal(rows.length, 1);
    const r = rows[0] as { parentRunId?: string; data: Record<string, string> };
    assert.equal(r.parentRunId, "parent-run-9999");
    assert.equal(r.data.__name, "Oath Signature · #abcd");
    assert.equal(r.data.parentSubject, "Oath Signature · #abcd");
    assert.equal(r.data.searchName, "Barahona Martell, Carlos");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eidLookupPreEmitPending falls back to searchName without parentSubject", () => {
  const dir = mkdtempSync(join(tmpdir(), "eid-preemit-fallback-"));
  try {
    eidLookupPreEmitPending(
      { name: "Solo Search" } as never,
      "eid-run-2",
      undefined,
      "eid-item-2",
      dir,
    );
    const rows = readJsonl(join(dir, `eid-lookup-${todayLocal()}.jsonl`));
    assert.equal(rows[0]!.data.__name, "Solo Search");
    assert.equal((rows[0]!.data as Record<string, unknown>).parentSubject, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
