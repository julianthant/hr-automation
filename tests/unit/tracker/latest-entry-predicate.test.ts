import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../../src/tracker/find-latest-entry.js";

test("findLatestEntryForPredicate scans recent tracker files newest line first", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-entry-"));
  try {
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-15T10:00:00.000Z",
      id: "session-1",
      runId: "run-old",
      status: "running",
      step: "matching",
      data: {},
    }, dir);
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-15T10:01:00.000Z",
      id: "session-1",
      runId: "run-new",
      status: "done",
      step: "approved",
      data: { fannedOutItemIds: '["10800001"]' },
    }, dir);

    const latest = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir: dir,
      lookbackDays: 7,
      predicate: (entry) => entry.id === "session-1" && entry.step === "approved",
    });

    assert.equal(latest?.runId, "run-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
