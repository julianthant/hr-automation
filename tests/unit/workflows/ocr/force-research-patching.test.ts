import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runForceResearch } from "../../../../src/workflows/ocr/force-research.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";
import type { ChildOutcome } from "../../../../src/tracker/delegation/watch-child-runs.js";

function makeDir(): string {
  const dir = join(tmpdir(), `force-research-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOcrRow(dir: string, sessionId: string, runId: string, records: unknown[]): void {
  const date = dateLocal();
  const entry = {
    workflow: "ocr",
    id: sessionId,
    runId,
    timestamp: new Date().toISOString(),
    status: "done",
    step: "awaiting-approval",
    data: {
      formType: "oath",
      records: JSON.stringify(records),
    },
  };
  writeFileSync(join(dir, `ocr-${date}.jsonl`), JSON.stringify(entry) + "\n");
}

function readLastTrackerEntry(dir: string): Record<string, unknown> {
  const date = dateLocal();
  const file = join(dir, `ocr-${date}.jsonl`);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

describe("force-research patches records from eid-lookup outcomes", () => {
  it("emitted awaiting-approval row contains patched employeeId from lookup outcome", async () => {
    const dir = makeDir();
    const sessionId = "session-fr-1";
    const runId = "run-fr-1";

    const initialRecords = [
      {
        printedName: "Smith, John",
        employeeId: "",
        matchState: "unresolved",
        forceResearch: false,
      },
    ];
    writeOcrRow(dir, sessionId, runId, initialRecords);

    const mockOutcome: ChildOutcome = {
      workflow: "eid-lookup",
      itemId: `ocr-force-${runId}-r0`,
      runId: "eid-run-1",
      status: "done",
      data: {
        emplId: "10873698",
        activeStatus: "active",
        hrStatus: "Active",
        department: "HDH",
        isActive: "true",
        isHdhAccepted: "true",
        personOrgScreenshot: "",
      },
    };

    await runForceResearch(
      { sessionId, runId, recordIndices: [0] },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async () => [mockOutcome],
      },
    );

    const lastEntry = readLastTrackerEntry(dir);
    assert.equal(lastEntry["step"], "awaiting-approval");
    assert.equal(lastEntry["status"], "done");

    const records = JSON.parse(lastEntry["data"] as string === "[object Object]"
      ? "{}"
      : (lastEntry["data"] as Record<string, string>)["records"] ?? "[]") as unknown[];
    const rec = records[0] as Record<string, unknown>;
    assert.equal(rec["employeeId"], "10873698", "employeeId should be patched from eid-lookup outcome");
    assert.equal(rec["matchState"], "resolved", "matchState should be resolved after successful lookup");
    assert.equal(rec["matchSource"], "eid-lookup");
  });

  it("emitted row has blank employeeId when lookup fails", async () => {
    const dir = makeDir();
    const sessionId = "session-fr-2";
    const runId = "run-fr-2";

    writeOcrRow(dir, sessionId, runId, [
      { printedName: "Doe, Jane", employeeId: "", matchState: "unresolved", forceResearch: false },
    ]);

    const failedOutcome: ChildOutcome = {
      workflow: "eid-lookup",
      itemId: `ocr-force-${runId}-r0`,
      runId: "eid-run-2",
      status: "failed",
      error: "no result",
    };

    await runForceResearch(
      { sessionId, runId, recordIndices: [0] },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async () => [failedOutcome],
      },
    );

    const lastEntry = readLastTrackerEntry(dir);
    const records = JSON.parse((lastEntry["data"] as Record<string, string>)["records"] ?? "[]") as unknown[];
    const rec = records[0] as Record<string, unknown>;
    assert.equal(rec["employeeId"], "", "employeeId should remain empty on failed lookup");
    assert.equal(rec["matchState"], "unresolved");
  });
});
