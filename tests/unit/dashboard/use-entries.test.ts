import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildEntriesHash,
  entryRenderHash,
  isEntriesEnvelope,
  resetEntriesMemoRefs,
  shouldApplyEntriesUpdate,
} from "../../../src/dashboard/components/hooks/useEntries.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("shouldApplyEntriesUpdate applies an empty first payload for a new date key", () => {
  const shouldApply = shouldApplyEntriesUpdate({
    activeKey: "active-check|2026-05-08",
    targetKey: "active-check|2026-05-07",
    previousHash: "",
    nextHash: "",
  });

  assert.equal(shouldApply, true);
});

test("shouldApplyEntriesUpdate skips unchanged payloads once the active key is current", () => {
  const shouldApply = shouldApplyEntriesUpdate({
    activeKey: "active-check|2026-05-07",
    targetKey: "active-check|2026-05-07",
    previousHash: "",
    nextHash: "",
  });

  assert.equal(shouldApply, false);
});

test("useEntries updates aggregate SSE state only once per delivery", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/dashboard/components/hooks/useEntries.ts"),
    "utf8",
  );

  assert.equal(source.match(/\bsetWorkflows\(/g)?.length ?? 0, 1);
  assert.equal(source.match(/\bsetWfCounts\(/g)?.length ?? 0, 1);
  assert.equal(source.match(/\bsetFailureCounts\(/g)?.length ?? 0, 1);
});

test("isEntriesEnvelope accepts only shallow entries payloads", () => {
  assert.equal(isEntriesEnvelope({ entries: [], workflows: [], wfCounts: {}, failureCounts: {} }), true);
  assert.equal(isEntriesEnvelope({ entries: {}, workflows: [] }), false);
  assert.equal(isEntriesEnvelope({ entries: [], workflows: {} }), false);
  assert.equal(isEntriesEnvelope(null), false);
});

test("buildEntriesHash fingerprints entries in one stable pass", () => {
  const entries: TrackerEntry[] = [
    {
      workflow: "ocr",
      id: "item-1",
      runId: "item-1#1",
      status: "running",
      step: "matching",
      timestamp: "2026-05-14T10:00:00.000Z",
      firstLogTs: "2026-05-14T10:00:01.000Z",
      lastLogTs: "2026-05-14T10:00:02.000Z",
    },
  ];

  assert.equal(
    buildEntriesHash(entries),
    "item-1|running|matching|2026-05-14T10:00:00.000Z|2026-05-14T10:00:01.000Z|2026-05-14T10:00:02.000Z|item-1#1|;",
  );
});

test("entryRenderHash ignores unread data payload fields", () => {
  const base: TrackerEntry = {
    workflow: "ocr",
    id: "ocr-prep-1",
    runId: "ocr-prep-1#1",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-14T10:00:00.000Z",
    lastLogMessage: "Awaiting approval",
    data: {
      __subject: "Oath Signature · #1234",
      __name: "Oath Signature · #1234",
      mode: "prepare",
      records: "[{\"large\":\"payload\"}]",
    },
  };

  assert.equal(
    entryRenderHash({
      ...base,
      data: {
        ...base.data,
        records: "[{\"different\":\"payload\"}]",
        someInternalDebugBlob: "unread",
      },
    }),
    entryRenderHash(base),
  );
});

test("resetEntriesMemoRefs clears the hash and active key after SSE errors", () => {
  const prevHashRef = { current: "same-snapshot-hash" };
  const activeKeyRef = { current: "active-check|2026-05-15" };

  resetEntriesMemoRefs(prevHashRef, activeKeyRef);

  assert.equal(prevHashRef.current, "");
  assert.equal(activeKeyRef.current, "");
});
