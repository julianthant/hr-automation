import { describe, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import { emitStepChange, readSessionEvents, type SessionEvent } from "../../../src/tracker/session-events.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";
import { logFilePath, logsDir } from "../../../src/tracker/paths.js";

// emitStepChange is the ONLY carrier of a daemon's live `currentStep`
// (rebuildSessionState derives it from these events), which drives the session
// card's footer step + step pipeline. It must therefore ALWAYS emit.
//
// A previous version deduped the event against a `step:start` log written
// within 50ms for the same (workflow, runId, step). But `Stepper.announce`
// writes that very log immediately before calling emitStepChange, so the guard
// matched on every `ctx.step` and suppressed the event for the whole run —
// leaving `currentStep` null and the card stuck on the item id. The
// duplicate-line concern now lives at render time (mergeDisplayItems drops the
// redundant step_change from the merged log view). These tests pin that the
// event is no longer suppressed at emit time.
const today = () => dateLocal();

describe("emitStepChange always emits a step_change session event", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "step-emit-")); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  function appendStepLog(workflow: string, runId: string, step: string, ts: string): void {
    mkdirSync(logsDir(tmp), { recursive: true });
    appendFileSync(logFilePath(workflow, today(), tmp), JSON.stringify({
      workflow, itemId: "alice@example.com", runId, level: "step",
      message: `Phase: ${step}`, ts,
    }) + "\n");
  }

  function stepChanges(): SessionEvent[] {
    return readSessionEvents(tmp).filter((e) => e.type === "step_change");
  }

  it("emits even when a matching step log was just appended (the Stepper.announce order)", async () => {
    // This is the exact scenario the old dedup suppressed: log first, then emit.
    appendStepLog("onboarding", "alice@example.com#1", "extraction", new Date().toISOString());
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      emitStepChange("Onboarding 1", "extraction", tmp, "onboarding");
    });
    const events = stepChanges();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.currentStep, "extraction");
  });

  it("emits when no log context is set", () => {
    emitStepChange("Onboarding 1", "extraction", tmp, "onboarding");
    assert.equal(stepChanges().length, 1);
  });

  it("emits one event per step transition (no cross-step suppression)", async () => {
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#1");
      appendStepLog("onboarding", "alice@example.com#1", "extraction", new Date().toISOString());
      emitStepChange("Onboarding 1", "extraction", tmp, "onboarding");
      appendStepLog("onboarding", "alice@example.com#1", "fill-award", new Date().toISOString());
      emitStepChange("Onboarding 1", "fill-award", tmp, "onboarding");
    });
    assert.deepEqual(stepChanges().map((e) => e.currentStep), ["extraction", "fill-award"]);
  });
});
