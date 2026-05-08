import { describe, it, beforeEach, afterEach, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import { emitStepChange, readSessionEvents, type SessionEvent } from "../../../src/tracker/session-events.js";
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

test("emitStepChange wildcard escape: % in step name does not over-match unrelated SQLite log rows", async () => {
  // Drives the SQLite-path wildcard escape via the public emitStepChange caller.
  //
  // Setup: seed a SQLite logs row whose message contains "extractZdone" — NOT
  // a literal "extract%done". Then call emitStepChange with step "extract%done".
  //
  // Pre-fix, recentStepLogExists's SQL becomes  LIKE '%extract%done%'  (no
  // ESCAPE), the inner % is treated as a wildcard and matches the Z in
  // "extractZdone", so the dedupe gate fires and the session event is
  // suppressed → 0 events emitted.
  //
  // Post-fix, the SQL becomes  LIKE '%extract\%done%' ESCAPE '\\' , the % is
  // literal, no row matches, dedupe doesn't fire → 1 event emitted.
  //
  // The discriminating shape is "no row literally contains 'extract%done'."
  // An earlier version of this test seeded a literal-`%done` row alongside
  // the wildcard-leak row — with that row present, BOTH pre-fix (wildcard
  // path) and post-fix (literal path) hit a match and dedupe equally,
  // hiding the regression.
  const dir = mkdtempSync(join(tmpdir(), "step-wildcard-"));
  try {
    const db = openStateDb(dir);
    const date = dateLocal();
    const now = Date.now();
    const appliedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO logs (source_path, source_line, source_offset, workflow, tracker_date, item_id, run_id, level, message, ts, ts_ms, raw_json, applied_at)
      VALUES ('fake', 1, 0, 'onboarding', ?, 'alice@example.com', 'alice@example.com#1', 'step', 'step started: extractZdone', ?, ?, '{}', ?)
    `).run(date, new Date().toISOString(), now, appliedAt);

    // emitStepChange discovers workflows by scanning *-{date}-logs.jsonl
    // filenames; create an empty file so the dedupe loop iterates with
    // wf="onboarding" and recentStepLogExists is actually called.
    appendFileSync(join(dir, `onboarding-${date}-logs.jsonl`), "");

    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extract%done", dir);
    });

    const events = readSessionEvents(dir).filter((e) => e.type === "step_change");
    assert.equal(events.length, 1, "step_change should emit; pre-fix wildcard would falsely dedupe against extractZdone");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
