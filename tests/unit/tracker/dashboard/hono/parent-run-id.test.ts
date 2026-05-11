import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PARENT_RUN_ID_VALIDATION_HINT,
  parseOptionalParentRunId,
} from "../../../../../src/tracker/dashboard/hono/parent-run-id.js";

describe("parseOptionalParentRunId", () => {
  it("accepts valid ids", () => {
    assert.equal(parseOptionalParentRunId("abcd1234"), "abcd1234");
    assert.equal(parseOptionalParentRunId("  ab.cd_12-89  "), "ab.cd_12-89");
    assert.equal(parseOptionalParentRunId(undefined), undefined);
    assert.equal(parseOptionalParentRunId(null), undefined);
  });

  it("rejects invalid shapes", () => {
    assert.equal(parseOptionalParentRunId(""), undefined);
    assert.equal(parseOptionalParentRunId("short"), undefined);
    assert.equal(parseOptionalParentRunId("a".repeat(129)), undefined);
    assert.equal(parseOptionalParentRunId("has space"), undefined);
    assert.equal(parseOptionalParentRunId(12), undefined);
  });
});

describe("PARENT_RUN_ID_VALIDATION_HINT", () => {
  it("is documented copy for 400 responses", () => {
    assert.ok(PARENT_RUN_ID_VALIDATION_HINT.length > 10);
  });
});
