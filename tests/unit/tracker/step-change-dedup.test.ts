import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import { emitStepChange, type SessionEvent } from "../../../src/tracker/session-events.js";

const today = () => new Date().toISOString().slice(0, 10);

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

  function readSessionEvents(): SessionEvent[] {
    const path = join(tmp, "sessions.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("suppresses session event when matching step log was just appended (within 50ms)", async () => {
    const now = new Date();
    appendStepLog("onboarding", "alice@example.com#1", "extraction", now.toISOString());
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 0);
  });

  it("emits the event when the matching step log is older than 50ms", async () => {
    const old = new Date(Date.now() - 200).toISOString();
    appendStepLog("onboarding", "alice@example.com#1", "extraction", old);
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });

  it("emits the event when a different step's log is recent (per-triple keying)", async () => {
    const now = new Date();
    appendStepLog("onboarding", "alice@example.com#1", "pdf-download", now.toISOString());
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp);
    });
    const events = readSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });

  it("emits the event when no log context is set (no runId to key against)", () => {
    emitStepChange("Onboarding 1", "extraction", tmp);
    const events = readSessionEvents().filter((e) => e.type === "step_change");
    assert.equal(events.length, 1);
  });
});
