import { describe, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withLogContext, setLogRunId } from "../../../src/utils/log.js";
import {
  emitSessionEvent,
  emitWorkflowStart,
  emitItemStart,
  emitItemComplete,
  readSessionEvents,
  type SessionEvent,
} from "../../../src/tracker/session-events.js";

describe("emitSessionEvent + runId", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sess-evt-")); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  function readEvents(): SessionEvent[] {
    return readSessionEvents(tmp);
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

  it("emitItemStart / emitItemComplete tag events with the explicit runId param", () => {
    // Daemon mode: the daemon's main loop fires these OUTSIDE the per-item
    // withLogContext, so getLogRunId() returns undefined. The explicit runId
    // arg is the only thing keeping each item's events from leaking into
    // sibling items' run-events streams via the workflowInstance fallback.
    emitItemStart("Separation 1", "doc-3930", tmp, "doc-3930#5");
    emitItemComplete("Separation 1", "doc-3930", tmp, "doc-3930#5");
    const events = readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "item_start");
    assert.equal(events[0].runId, "doc-3930#5");
    assert.equal(events[1].type, "item_complete");
    assert.equal(events[1].runId, "doc-3930#5");
  });

});
