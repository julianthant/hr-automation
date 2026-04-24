import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import {
  emitSessionEvent,
  emitWorkflowStart,
  type SessionEvent,
} from "../../../src/tracker/session-events.js";

describe("emitSessionEvent + runId", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sess-evt-")); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  function readEvents(): SessionEvent[] {
    const path = join(tmp, "sessions.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("writes runId field when called inside a log context with runId set", async () => {
    await withLogContext("onboarding", "alice@example.com", async () => {
      setLogRunId("alice@example.com#2");
      emitWorkflowStart("Onboarding 1", tmp);
    });
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, "alice@example.com#2");
  });

  it("omits runId field when called outside a log context", () => {
    emitWorkflowStart("Onboarding 1", tmp);
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, undefined);
  });

});
