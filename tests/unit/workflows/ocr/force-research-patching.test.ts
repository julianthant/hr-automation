import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runForceResearch } from "../../../../src/workflows/ocr/force-research.js";
import { dateLocal, rowFilePath, rowsDir } from "../../../../src/tracker/jsonl.js";
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
  mkdirSync(rowsDir(dir), { recursive: true });
  writeFileSync(rowFilePath("ocr", date, dir), JSON.stringify(entry) + "\n");
}

function readLastTrackerEntry(dir: string): Record<string, unknown> {
  const date = dateLocal();
  const file = rowFilePath("ocr", date, dir);
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

  it("hard-rejects a verify row (N4) — force-research must not corrupt the completeness report", async () => {
    const dir = makeDir();
    const sessionId = "session-fr-verify";
    const runId = "run-fr-verify";
    const date = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    // A verify-formType OCR row. force-research would clear employeeId + drop
    // paperEmployeeId + never rebuild checks[] → corrupt the report. It must
    // refuse before touching anything.
    writeFileSync(
      rowFilePath("ocr", date, dir),
      JSON.stringify({
        workflow: "ocr",
        id: sessionId,
        runId,
        timestamp: new Date().toISOString(),
        status: "done",
        step: "person-lookup",
        data: { formType: "verify", records: JSON.stringify([{ name: "Doe, Jane", employeeId: "10000001", paperEmployeeId: "10000001", checks: [] }]) },
      }) + "\n",
    );

    let threw: unknown;
    try {
      await runForceResearch(
        { sessionId, runId, recordIndices: [0] },
        { trackerDir: dir, _enqueueOverride: async () => { throw new Error("must not enqueue a verify row"); }, _watchChildRunsOverride: async () => { throw new Error("must not watch a verify row"); } },
      );
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, "force-research must reject a verify row");
    assert.match((threw as Error).message, /verify/i, "error explains verify rows use verify-relookup");
  });

  it("two selected records sharing the SAME extracted name do not collide — both get the correct outcome, not a misapplied one (itemId collision fix)", async () => {
    const dir = makeDir();
    const sessionId = "session-fr-collide";
    const runId = "run-fr-collide";

    // Two DIFFERENT people who happen to share a printed name — force-research
    // clears employeeId and re-fans by name, so both records resolve to the
    // IDENTICAL fan-out input. Before the fix this collided inside
    // fanOutAndWatch's own JSON.stringify(input)-keyed map (last-write-wins)
    // and only ONE of the two records would ever get patched.
    const initialRecords = [
      { printedName: "Smith, John", employeeId: "", matchState: "unresolved", forceResearch: false },
      { printedName: "Smith, John", employeeId: "", matchState: "unresolved", forceResearch: false },
    ];
    writeOcrRow(dir, sessionId, runId, initialRecords);

    let expectedItemIdsSeen: string[] = [];
    const mockOutcome: ChildOutcome = {
      workflow: "eid-lookup",
      itemId: `ocr-force-${runId}-r0`,
      runId: "eid-run-collide",
      status: "done",
      data: {
        emplId: "10999999",
        activeStatus: "active",
        hrStatus: "Active",
        department: "HDH",
        isActive: "true",
        isHdhAccepted: "true",
        personOrgScreenshot: "",
      },
    };

    await runForceResearch(
      { sessionId, runId, recordIndices: [0, 1] },
      {
        trackerDir: dir,
        _enqueueOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async (opts) => {
          expectedItemIdsSeen = [...opts.expectedItemIds];
          return [mockOutcome];
        },
      },
    );

    // Collision-proof by construction: only ONE child dispatched for the
    // shared name, not two (deduped, not a collided pair).
    assert.deepEqual(expectedItemIdsSeen, [`ocr-force-${runId}-r0`]);

    const lastEntry = readLastTrackerEntry(dir);
    const records = JSON.parse((lastEntry["data"] as Record<string, string>)["records"] ?? "[]") as Array<Record<string, unknown>>;
    assert.equal(records.length, 2);
    // BOTH records — not just the dispatched one — must receive the outcome.
    assert.equal(records[0]!["employeeId"], "10999999", "record 0 patched from the shared lookup outcome");
    assert.equal(records[1]!["employeeId"], "10999999", "record 1 (aliased, same name) also patched — not left unresolved");
    assert.equal(records[0]!["matchState"], "resolved");
    assert.equal(records[1]!["matchState"], "resolved");
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
