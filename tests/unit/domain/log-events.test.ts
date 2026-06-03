import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { normalizeLogEvent, type LogEventName } from "../../../src/domain/log-events.js";

describe("structured log events", () => {
  it("keeps a readable message while preserving structured fields", () => {
    assert.deepEqual(
      normalizeLogEvent({
        level: "waiting",
        message: "Waiting for Duo approval",
        category: "auth",
        occasion: "waiting",
        subject: "Oath Signature EID 00123456",
        system: "ucpath",
        step: "ucpath-auth",
        attempt: 1,
      }),
      {
        level: "waiting",
        message: "Waiting for Duo approval",
        category: "auth",
        occasion: "waiting",
        subject: "Oath Signature EID 00123456",
        system: "ucpath",
        step: "ucpath-auth",
        attempt: 1,
      },
    );
  });

  it("preserves the stable `event` name + `count` fields (Tier-1 harness contract)", () => {
    assert.deepEqual(
      normalizeLogEvent({
        level: "step",
        message: "Delegating 3 person-lookup child run(s)",
        category: "delegation",
        occasion: "started",
        event: "delegation:children-spawned",
        childWorkflow: "person-lookup",
        count: 3,
      }),
      {
        level: "step",
        message: "Delegating 3 person-lookup child run(s)",
        category: "delegation",
        occasion: "started",
        event: "delegation:children-spawned",
        childWorkflow: "person-lookup",
        count: 3,
      },
    );
  });

  it("the closed event-name set is the documented contract (renaming is breaking)", () => {
    // This list MUST stay in lockstep with `LogEventName` in
    // src/domain/log-events.ts and docs/engineering/structured-log-events.md.
    // The Tier-1 harness `waitForEvent` matches these literal strings; a
    // rename here is a breaking change.
    const names: LogEventName[] = [
      "delegation:children-spawned",
      "step:start",
      "step:done",
      "ocr:awaiting-approval",
      "cancel:requested",
      "run:terminal",
    ];
    // Type-level guard: every member is assignable to LogEventName (compile)
    // and the runtime set is the expected size.
    assert.equal(new Set(names).size, 6, "expected 6 distinct stable event names");
  });
});
