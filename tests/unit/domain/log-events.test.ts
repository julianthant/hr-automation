import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeLogEvent } from "../../../src/domain/log-events.js";

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
});
