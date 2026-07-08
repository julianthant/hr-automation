import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildTraceId,
  tracePrefix,
  runIdFragment,
  formatTraceIdRunLabel,
} from "../../../src/domain/queue-trace-id.js";

describe("queue trace id — prefix helpers (trace/span model)", () => {
  it("tracePrefix returns everything before the final tail segment", () => {
    assert.equal(tracePrefix("ou-090553-1a57"), "ou-090553");
    assert.equal(tracePrefix("pl-143012-a3f1"), "pl-143012");
  });

  it("tracePrefix returns the input unchanged when there is no tail to split", () => {
    assert.equal(tracePrefix("nodash"), "nodash");
    assert.equal(tracePrefix(""), "");
  });

  it("buildTraceId without rootPrefix composes <code>-<HHMMSS>-<runId4>", () => {
    const at = new Date("2026-06-02T09:05:53.000Z");
    const id = buildTraceId({ code: "ou", runId: "1a57-aaaa-bbbb", at });
    assert.match(id, /^ou-\d{6}-1a57$/);
  });

  it("buildTraceId WITH rootPrefix composes <rootPrefix>-<ownRunId4>, ignoring code/at", () => {
    const at = new Date("2026-06-02T09:05:53.000Z");
    const runId = "9d10-zzzz-yyyy";
    const id = buildTraceId({ code: "zz", runId, at, rootPrefix: "ou-090553" });
    // The shared operation prefix + THIS row's own tail.
    assert.equal(id, `ou-090553-${runIdFragment(runId)}`);
    assert.equal(id, "ou-090553-9d10");
    // The child's own code "zz" and the clock are NOT in the composed id.
    assert.ok(!id.startsWith("zz-"));
  });

  it("two siblings under one operation share the prefix but keep distinct tails", () => {
    const at = new Date("2026-06-02T09:05:53.000Z");
    const a = buildTraceId({ code: "x", runId: "aaaa-1111", at, rootPrefix: "ou-090553" });
    const b = buildTraceId({ code: "x", runId: "bbbb-2222", at, rootPrefix: "ou-090553" });
    assert.equal(tracePrefix(a), "ou-090553");
    assert.equal(tracePrefix(b), "ou-090553");
    assert.notEqual(a, b);
  });
});

describe("formatTraceIdRunLabel — display-only run suffix", () => {
  it("returns empty string when traceId is blank", () => {
    assert.equal(formatTraceIdRunLabel("", 1), "");
    assert.equal(formatTraceIdRunLabel("   ", 2), "");
  });

  it("appends -N when runOrdinal is a positive integer", () => {
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", 1), "ec-085131-feac-1");
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", 3), "ec-085131-feac-3");
  });

  it("returns traceId unchanged when runOrdinal is missing or invalid", () => {
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", undefined), "ec-085131-feac");
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", 0), "ec-085131-feac");
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", -1), "ec-085131-feac");
    assert.equal(formatTraceIdRunLabel("ec-085131-feac", 1.5), "ec-085131-feac");
  });

  it("does not double-suffix when traceId already has a run suffix", () => {
    assert.equal(formatTraceIdRunLabel("ec-085131-feac-2", 2), "ec-085131-feac-2");
  });

  it("trims whitespace from traceId before suffixing", () => {
    assert.equal(formatTraceIdRunLabel("  ec-085131-feac  ", 1), "ec-085131-feac-1");
  });
});
