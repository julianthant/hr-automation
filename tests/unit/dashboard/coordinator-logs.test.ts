import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  COORDINATOR_LOG_SOURCE_LABEL,
  buildMemberSummaryLines,
  isOperationCoordinatorWorkflow,
  mergeCoordinatorLogs,
  selectKeyOcrLogLines,
  type CoordinatorLogLine,
} from "../../../src/dashboard/components/log-panel/coordinator-logs.js";
import type { CollapsedLogEntry, } from "../../../src/dashboard/components/hooks/useLogs.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function log(
  partial: Partial<CollapsedLogEntry> & { ts: string; message: string },
): CollapsedLogEntry {
  return {
    workflow: "ocr",
    itemId: "sess-1",
    level: "step",
    count: 1,
    ...partial,
  };
}

/** A wire log entry carrying a structured `event` (rides the spread, not in the base type). */
function eventLog(ts: string, message: string, event: string): CollapsedLogEntry {
  return { ...log({ ts, message }), event } as CollapsedLogEntry;
}

describe("isOperationCoordinatorWorkflow", () => {
  it("matches the canonical coordinator set and nothing else", () => {
    assert.equal(isOperationCoordinatorWorkflow("oath-signature"), true);
    assert.equal(isOperationCoordinatorWorkflow("emergency-contact"), true);
    assert.equal(isOperationCoordinatorWorkflow("oath-upload"), false);
    assert.equal(isOperationCoordinatorWorkflow("ocr"), false);
    assert.equal(isOperationCoordinatorWorkflow(undefined), false);
  });
});

describe("selectKeyOcrLogLines", () => {
  it("keeps only KEY lifecycle events and drops extraction noise", () => {
    const ocrLogs: CollapsedLogEntry[] = [
      eventLog("2026-06-17T10:00:00.000Z", "Phase: matching", "step:start"),
      log({ ts: "2026-06-17T10:00:01.000Z", message: "Extracted page 1 of 5", level: "step" }),
      log({ ts: "2026-06-17T10:00:02.000Z", message: "row 2 matched", level: "debug" }),
      eventLog("2026-06-17T10:00:03.000Z", "Preparation complete", "ocr:awaiting-approval"),
    ];
    const kept = selectKeyOcrLogLines(ocrLogs);
    assert.deepEqual(
      kept.map((l) => l.message),
      ["Phase: matching", "Preparation complete"],
    );
  });

  it("returns empty when no KEY events are present", () => {
    assert.deepEqual(
      selectKeyOcrLogLines([log({ ts: "2026-06-17T10:00:00.000Z", message: "noise" })]),
      [],
    );
  });
});

describe("buildMemberSummaryLines", () => {
  const member = (over: Partial<TrackerEntry>): TrackerEntry => ({
    workflow: "oath-signature",
    timestamp: "2026-06-17T10:05:00.000Z",
    id: "signer-1",
    status: "done",
    ...over,
  });

  it("builds one summary line per member, titled + status arrow, level by status", () => {
    const members: TrackerEntry[] = [
      member({ id: "signer-1", status: "done", timestamp: "2026-06-17T10:05:00.000Z" }),
      member({ id: "signer-2", status: "running", timestamp: "2026-06-17T10:05:01.000Z" }),
      member({ id: "signer-3", status: "failed", timestamp: "2026-06-17T10:05:02.000Z" }),
    ];
    const lines = buildMemberSummaryLines(members, (m) => m.id.toUpperCase());

    assert.equal(lines.length, 3);
    assert.equal(lines[0]!.message, "SIGNER-1 → done");
    assert.equal(lines[0]!.level, "success");
    assert.equal(lines[0]!.source, "member");
    assert.equal(lines[1]!.message, "SIGNER-2 → running");
    assert.equal(lines[1]!.level, "step");
    assert.equal(lines[2]!.message, "SIGNER-3 → failed");
    assert.equal(lines[2]!.level, "error");
  });

  it("falls back to the member id when the title resolver returns empty", () => {
    const lines = buildMemberSummaryLines([member({ id: "contact-9" })], () => "");
    assert.equal(lines[0]!.message, "contact-9 → done");
  });
});

describe("mergeCoordinatorLogs", () => {
  it("merges all three sources, sorts by ts, and tags each with its source", () => {
    const coordinatorLogs = [
      log({ ts: "2026-06-17T10:00:00.000Z", message: "Operation created", level: "step" }),
      log({ ts: "2026-06-17T10:06:00.000Z", message: "OCR approved · approved", level: "step" }),
    ];
    const ocrLogs = [
      eventLog("2026-06-17T10:03:00.000Z", "Preparation complete", "ocr:awaiting-approval"),
    ];
    const memberLines: CoordinatorLogLine[] = buildMemberSummaryLines(
      [
        {
          workflow: "oath-signature",
          timestamp: "2026-06-17T10:07:00.000Z",
          id: "signer-1",
          status: "done",
        },
      ],
      (m) => m.id,
    );

    const merged = mergeCoordinatorLogs(coordinatorLogs, ocrLogs, memberLines);

    assert.deepEqual(
      merged.map((l) => [l.source, l.message]),
      [
        ["coordinator", "Operation created"],
        ["ocr", "Preparation complete"],
        ["coordinator", "OCR approved · approved"],
        ["member", "signer-1 → done"],
      ],
    );
  });

  it("orders equal-timestamp lines coordinator → ocr → member (stable)", () => {
    const ts = "2026-06-17T10:00:00.000Z";
    const coordinatorLogs = [log({ ts, message: "coord line" })];
    const ocrLogs = [eventLog(ts, "ocr line", "step:start")];
    const memberLines = buildMemberSummaryLines(
      [{ workflow: "ec", timestamp: ts, id: "contact-1", status: "running" }],
      (m) => m.id,
    );

    const merged = mergeCoordinatorLogs(coordinatorLogs, ocrLogs, memberLines);
    assert.deepEqual(merged.map((l) => l.source), ["coordinator", "ocr", "member"]);
  });

  it("dedupes exact duplicates within the same source", () => {
    const ts = "2026-06-17T10:00:00.000Z";
    const dup = log({ ts, message: "Operation created" });
    const merged = mergeCoordinatorLogs([dup, { ...dup }], [], []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.source, "coordinator");
  });

  it("keeps same-message lines from DIFFERENT sources (not cross-source dedupe)", () => {
    const ts = "2026-06-17T10:00:00.000Z";
    const merged = mergeCoordinatorLogs(
      [log({ ts, message: "same" })],
      [eventLog(ts, "same", "step:start")],
      [],
    );
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((l) => l.source), ["coordinator", "ocr"]);
  });

  it("source labels are human-readable", () => {
    assert.equal(COORDINATOR_LOG_SOURCE_LABEL.coordinator, "Operation");
    assert.equal(COORDINATOR_LOG_SOURCE_LABEL.ocr, "OCR");
    assert.equal(COORDINATOR_LOG_SOURCE_LABEL.member, "Member");
  });
});
