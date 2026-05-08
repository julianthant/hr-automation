import { describe, it, beforeEach, afterEach, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import { emitStepChange, readSessionEvents, recentStepLogExists, type SessionEvent } from "../../../src/tracker/session-events.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";
import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";

const today = () => dateLocal();

describe("emitStepChange dedupe against recent step log", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "step-dedup-")); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  function appendStepLog(workflow: string, runId: string, step: string, ts: string): void {
    const path = join(tmp, `${workflow}-${today()}-logs.jsonl`);
    if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
    appendFileSync(path, JSON.stringify({
      workflow, itemId: "alice@example.com", runId, level: "step",
      message: `step started: ${step}`, ts,
    }) + "\n");
  }

  function readLocalSessionEvents(): SessionEvent[] {
    return readSessionEvents(tmp);
  }

  it("suppresses session event when matching step log was just appended (within 50ms)", async () => {
    const now = new Date();
    appendStepLog("onboarding", "alice@example.com#1", "extraction", now.toISOString());
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readLocalSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 0);
  });

  it("emits the event when the matching step log is older than 50ms", async () => {
    const old = new Date(Date.now() - 200).toISOString();
    appendStepLog("onboarding", "alice@example.com#1", "extraction", old);
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readLocalSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });

  it("emits the event when a different step's log is recent (per-triple keying)", async () => {
    const now = new Date();
    appendStepLog("onboarding", "alice@example.com#1", "pdf-download", now.toISOString());
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readLocalSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });

  it("emits the event when no log context is set (no runId to key against)", () => {
    emitStepChange("Onboarding 1", "extraction", tmp);
    const events = readLocalSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });
});

test("recentStepLogExists LIKE escape: % and _ in step name match literally (SQLite path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-like-"));
  try {
    const db = openStateDb(dir);
    const date = dateLocal();
    const now = Date.now();
    const appliedAt = new Date().toISOString();
    // Seed two log rows:
    //   row 0: message contains the literal step "extract%done"
    //   row 1: message contains "extractZdone" — would match if % were treated as wildcard
    db.prepare(`
      INSERT INTO logs (source_path, source_line, source_offset, workflow, tracker_date, item_id, run_id, level, message, ts, ts_ms, raw_json, applied_at)
      VALUES
        ('fake', 1, 0, 'test-wf', ?, 'item-1', 'item-1#1', 'step', 'literal extract%done message', ?, ?, '{}', ?),
        ('fake', 2, 1, 'test-wf', ?, 'item-1', 'item-1#1', 'step', 'extractZdone wildcard-leak message', ?, ?, '{}', ?)
    `).run(date, new Date().toISOString(), now, appliedAt, date, new Date().toISOString(), now, appliedAt);

    // "extract%done" should match only the first row (literal)
    const found = recentStepLogExists("test-wf", "item-1#1", "extract%done", dir);
    assert.equal(found, true, "literal step name containing % should match");

    // "extractXdone" should not match (the wildcard-leak check)
    const leak = recentStepLogExists("test-wf", "item-1#1", "extractXdone", dir);
    assert.equal(leak, false, "literal step name should not match different message under wildcard semantics");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
