import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  cancelActiveBulkBody,
  daemonsSpawnBody,
  deleteBulkBody,
  ocrApproveBatchBody,
  retryBody,
  rowCancelBody,
  zodParse,
} from "../../../../../src/tracker/dashboard/hono/request-schemas.js";

/**
 * Pins the fail-loud request contract for the dashboard's JSON mutation
 * routes: malformed bodies 400 with the offending field named — they never
 * coerce (`String({}) === "[object Object]"`), never blank-default a required
 * field, and never silently swap an unknown enum for a default.
 */

function expectFailure(result: unknown): string {
  const r = result as { ok?: unknown; error?: unknown };
  assert.equal(r.ok, false, `expected a parse failure, got: ${JSON.stringify(result)}`);
  assert.equal(typeof r.error, "string");
  return r.error as string;
}

describe("zodParse(retryBody)", () => {
  const parse = zodParse(retryBody);

  it("accepts a well-formed retry request and normalizes blank optionals", () => {
    const parsed = parse({ workflow: "separations", id: "item-1", runId: "", date: null }) as {
      workflow: string; id: string; runId?: string; date?: string;
    };
    assert.equal(parsed.workflow, "separations");
    assert.equal(parsed.id, "item-1");
    assert.equal(parsed.runId, undefined);
    assert.equal(parsed.date, undefined);
  });

  it("rejects an object where a string is required — no [object Object]", () => {
    const error = expectFailure(parse({ workflow: { nested: true }, id: "item-1" }));
    assert.match(error, /workflow/);
    assert.doesNotMatch(error, /\[object Object\]/);
  });

  it("rejects a missing required field instead of blank-defaulting it", () => {
    assert.match(expectFailure(parse({ id: "item-1" })), /workflow: required/);
  });

  it("rejects a malformed date", () => {
    assert.match(expectFailure(parse({ workflow: "ocr", id: "x", date: "07/16/2026" })), /date/);
  });

  it("rejects an invalid parentRunId with the shared hint", () => {
    assert.match(
      expectFailure(parse({ workflow: "ocr", id: "x", parentRunId: "no spaces!" })),
      /parentRunId must be 8–128 characters/,
    );
  });
});

describe("zodParse(rowCancelBody) enum handling", () => {
  const parse = zodParse(rowCancelBody);
  const base = { workflow: "ocr", id: "item-1" };

  it("defaults scope to row only when ABSENT", () => {
    assert.equal((parse(base) as { scope: string }).scope, "row");
    assert.equal((parse({ ...base, scope: "tree" }) as { scope: string }).scope, "tree");
  });

  it("400s a present-but-unknown scope instead of silently defaulting", () => {
    assert.match(expectFailure(parse({ ...base, scope: "everything" })), /scope/);
  });

  it("400s an unknown status instead of ignoring it", () => {
    assert.match(expectFailure(parse({ ...base, status: "done" })), /status/);
  });
});

describe("zodParse(daemonsSpawnBody) worker bounds", () => {
  const parse = zodParse(daemonsSpawnBody);

  it("defaults an absent count to 1 and accepts in-range integers", () => {
    assert.equal((parse({ workflow: "ocr" }) as { count: number }).count, 1);
    assert.equal((parse({ workflow: "ocr", count: 3 }) as { count: number }).count, 3);
  });

  it("rejects out-of-range and non-integer counts", () => {
    assert.match(expectFailure(parse({ workflow: "ocr", count: 9 })), /count/);
    assert.match(expectFailure(parse({ workflow: "ocr", count: 1000 })), /count/);
    assert.match(expectFailure(parse({ workflow: "ocr", count: 0 })), /count/);
    assert.match(expectFailure(parse({ workflow: "ocr", count: 2.5 })), /count/);
    assert.match(expectFailure(parse({ workflow: "ocr", count: "4" })), /count/);
  });
});

describe("zodParse(deleteBulkBody)", () => {
  const parse = zodParse(deleteBulkBody);

  it("requires at least one id or item", () => {
    assert.match(
      expectFailure(parse({ workflow: "ocr", date: "2026-07-17" })),
      /ids or items must be non-empty/,
    );
  });

  it("requires a real YYYY-MM-DD date", () => {
    assert.match(
      expectFailure(parse({ workflow: "ocr", date: "today", ids: ["a"] })),
      /date/,
    );
  });

  it("accepts items with per-row overrides", () => {
    const parsed = parse({
      workflow: "ocr",
      date: "2026-07-17",
      items: [{ id: "a", runId: "r-1", date: "2026-07-16" }],
    }) as { items: Array<{ id: string; runId?: string; date?: string }> };
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.id, "a");
    assert.equal(parsed.items[0]?.runId, "r-1");
    assert.equal(parsed.items[0]?.date, "2026-07-16");
  });
});

describe("zodParse(cancelActiveBulkBody)", () => {
  const parse = zodParse(cancelActiveBulkBody);

  it("requires non-empty items each carrying a valid status", () => {
    assert.match(expectFailure(parse({ workflow: "ocr", items: [] })), /items/);
    assert.match(
      expectFailure(parse({ workflow: "ocr", items: [{ id: "a" }] })),
      /status/,
    );
  });
});

describe("zodParse(ocrApproveBatchBody)", () => {
  const parse = zodParse(ocrApproveBatchBody);

  it("rejects non-object records instead of silently dropping them", () => {
    // Approval fans out REAL downstream work — a corrupted records array must
    // stop the request, not shrink it.
    assert.match(
      expectFailure(parse({ sessionId: "s-1", runId: "r-1", records: [{ a: 1 }, "junk"] })),
      /records/,
    );
  });

  it("accepts a record list and requires the session pair", () => {
    const parsed = parse({ sessionId: "s-1", runId: "r-1", records: [{ formKind: "oath" }] }) as {
      sessionId: string; records: Array<Record<string, unknown>>;
    };
    assert.equal(parsed.sessionId, "s-1");
    assert.equal(parsed.records.length, 1);
    assert.match(expectFailure(parse({ runId: "r-1" })), /sessionId/);
  });
});
