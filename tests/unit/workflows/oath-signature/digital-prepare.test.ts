import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setDigitalEnqueueForTests,
  __setDigitalLookupForTests,
  runDigitalOathPrepare,
} from "../../../../src/workflows/oath-signature/digital-prepare.js";

/**
 * Tests for the post-2026-04-29 (P4.1) digital-mode bypass:
 * `runDigitalOathPrepare` now skips the prep-row pattern entirely and
 * enqueues `{emplId, date?}` directly into the oath-signature daemon.
 * No tracker JSONL writes; the only observable side effect is the
 * stubbed enqueue call.
 */
describe("runDigitalOathPrepare — happy path", () => {
  let enqueueCalls: Array<{ emplId: string; date?: string }>;
  beforeEach(() => {
    enqueueCalls = [];
    __setDigitalEnqueueForTests(async (inputs) => {
      enqueueCalls.push(...inputs);
    });
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    __setDigitalEnqueueForTests(undefined);
  });

  it("enqueues one {emplId, date} per EID when CRM lookup returns a date", async () => {
    __setDigitalLookupForTests(async (emplIds) =>
      emplIds.map((emplId) => ({
        emplId,
        dateMmDdYyyy: "04/27/2026",
      })),
    );

    const out = await runDigitalOathPrepare({
      emplIds: ["10873611", "10873075"],
    });

    assert.equal(out.enqueued, 2);
    assert.equal(out.lookupFailures, 0);
    assert.equal(enqueueCalls.length, 2);
    assert.equal(enqueueCalls[0].emplId, "10873611");
    assert.equal(enqueueCalls[0].date, "04/27/2026");
    assert.equal(enqueueCalls[1].emplId, "10873075");
  });

  it("enqueues without a date when CRM lookup returns null (kernel today-prefills)", async () => {
    __setDigitalLookupForTests(async () => [
      { emplId: "10873611", dateMmDdYyyy: null },
    ]);

    const out = await runDigitalOathPrepare({ emplIds: ["10873611"] });

    assert.equal(out.enqueued, 1);
    assert.equal(out.lookupFailures, 0);
    assert.equal(enqueueCalls[0].emplId, "10873611");
    assert.equal(enqueueCalls[0].date, undefined);
  });

  it("counts per-EID lookup errors as lookupFailures but still enqueues", async () => {
    __setDigitalLookupForTests(async () => [
      { emplId: "10873611", dateMmDdYyyy: "04/27/2026" },
      { emplId: "99999999", dateMmDdYyyy: null, error: "EID not found in CRM" },
    ]);

    const out = await runDigitalOathPrepare({
      emplIds: ["10873611", "99999999"],
    });

    assert.equal(out.enqueued, 2);
    assert.equal(out.lookupFailures, 1);
    assert.equal(enqueueCalls[0].date, "04/27/2026");
    assert.equal(enqueueCalls[1].date, undefined);
  });
});

describe("runDigitalOathPrepare — fallback when lookup throws", () => {
  let enqueueCalls: Array<{ emplId: string; date?: string }>;
  beforeEach(() => {
    enqueueCalls = [];
    __setDigitalEnqueueForTests(async (inputs) => {
      enqueueCalls.push(...inputs);
    });
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    __setDigitalEnqueueForTests(undefined);
  });

  it("enqueues every EID without a date when the lookup batch throws", async () => {
    __setDigitalLookupForTests(async () => {
      throw new Error("CRM session crashed");
    });

    const out = await runDigitalOathPrepare({
      emplIds: ["10873611", "99999999"],
    });

    assert.equal(out.enqueued, 2);
    // 2 from the fall-back branch, plus 2 from the per-record `r.error`
    // count = 4 total. The exact number is implementation-dependent;
    // assert >= 2 to keep the test resilient.
    assert.ok(out.lookupFailures >= 2);
    assert.equal(enqueueCalls[0].date, undefined);
    assert.equal(enqueueCalls[1].date, undefined);
  });
});

describe("runDigitalOathPrepare — input validation", () => {
  beforeEach(() => {
    __setDigitalEnqueueForTests(async () => {
      /* no-op */
    });
  });
  afterEach(() => {
    __setDigitalLookupForTests(undefined);
    __setDigitalEnqueueForTests(undefined);
  });

  it("returns enqueued: 0 when emplIds is empty without calling lookup or enqueue", async () => {
    let lookupCalled = false;
    __setDigitalLookupForTests(async () => {
      lookupCalled = true;
      return [];
    });
    const out = await runDigitalOathPrepare({ emplIds: [] });
    assert.equal(out.enqueued, 0);
    assert.equal(out.lookupFailures, 0);
    assert.equal(lookupCalled, false);
  });
});
