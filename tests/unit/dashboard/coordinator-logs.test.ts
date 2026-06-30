import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  COORDINATOR_LOG_SOURCE_LABEL,
  buildMemberSummaryLines,
  computeOperationPipelineView,
  isOperationCoordinatorRow,
  isOperationCoordinatorWorkflow,
  mergeCoordinatorLogs,
  operationCoordinatorEffectiveStatus,
  selectKeyOcrLogLines,
  type CoordinatorLogLine,
} from "../../../src/dashboard/components/log-panel/coordinator-logs.js";
import { OPERATION_COORDINATOR_WORKFLOWS as CANONICAL_OPERATION_COORDINATOR_WORKFLOWS } from "../../../src/tracker/dashboard/ocr/shared.js";
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

describe("operationCoordinatorEffectiveStatus", () => {
  it("returns done when every fanned-out member is terminal", () => {
    const parent: TrackerEntry = {
      workflow: "emergency-contact",
      id: "ocr-prep-s1",
      runId: "op-run-1",
      timestamp: "2026-06-22T15:00:00.000Z",
      status: "running",
      step: "approved",
      data: { archetype: "operation", ocrRunId: "ocr-run-1" },
    };
    const children: TrackerEntry[] = [
      {
        workflow: "emergency-contact",
        id: "10884227",
        runId: "member-run-1",
        parentRunId: "op-run-1",
        timestamp: "2026-06-22T15:17:00.000Z",
        status: "done",
        data: { archetype: "operation-member", name: "Onika Miller" },
      },
    ];
    assert.equal(operationCoordinatorEffectiveStatus(parent, children), "done");
  });

  it("stays running while any member is still in flight", () => {
    const parent: TrackerEntry = {
      workflow: "emergency-contact",
      id: "ocr-prep-s1",
      runId: "op-run-1",
      timestamp: "2026-06-22T15:00:00.000Z",
      status: "running",
      step: "approved",
      data: { archetype: "operation", ocrRunId: "ocr-run-1" },
    };
    const children: TrackerEntry[] = [
      {
        workflow: "emergency-contact",
        id: "10884227",
        runId: "member-run-1",
        parentRunId: "op-run-1",
        timestamp: "2026-06-22T15:17:00.000Z",
        status: "done",
        data: { archetype: "operation-member" },
      },
      {
        workflow: "emergency-contact",
        id: "10884228",
        runId: "member-run-2",
        parentRunId: "op-run-1",
        timestamp: "2026-06-22T15:18:00.000Z",
        status: "running",
        data: { archetype: "operation-member" },
      },
    ];
    assert.equal(operationCoordinatorEffectiveStatus(parent, children), "running");
  });

  it("rolls up an INPUT-RUN operation (no OCR) by archetype, not workflow", () => {
    // A separations multi-person operation shell is NOT in the OCR coordinator
    // workflow set, but it carries the `operation` archetype — so its effective
    // status must still roll up from its members.
    const parent: TrackerEntry = {
      workflow: "separations",
      id: "op-shell",
      runId: "op-run-1",
      timestamp: "2026-06-30T15:00:00.000Z",
      status: "running",
      data: { archetype: "operation" },
    };
    const allDone: TrackerEntry[] = [
      {
        workflow: "separations",
        id: "10884227",
        runId: "member-run-1",
        parentRunId: "op-run-1",
        timestamp: "2026-06-30T15:17:00.000Z",
        status: "done",
        data: { archetype: "operation-member" },
      },
    ];
    assert.equal(operationCoordinatorEffectiveStatus(parent, allDone), "done");
    assert.equal(
      operationCoordinatorEffectiveStatus(parent, [
        ...allDone,
        { ...allDone[0]!, id: "x", runId: "m2", status: "running" },
      ]),
      "running",
    );
  });

  it("returns the row's own status for a non-operation (single) row", () => {
    const single: TrackerEntry = {
      workflow: "separations",
      id: "10884227",
      runId: "run-1",
      timestamp: "2026-06-30T15:00:00.000Z",
      status: "running",
      data: { archetype: "single" },
    };
    assert.equal(operationCoordinatorEffectiveStatus(single, []), "running");
  });
});

describe("isOperationCoordinatorRow", () => {
  const row = (archetype: string | undefined, workflow = "separations"): TrackerEntry => ({
    workflow,
    id: "r1",
    runId: "run-1",
    timestamp: "2026-06-30T15:00:00.000Z",
    status: "running",
    data: archetype === undefined ? {} : { archetype },
  });

  it("is true for ANY operation-archetype row, regardless of workflow", () => {
    assert.equal(isOperationCoordinatorRow(row("operation", "separations")), true);
    assert.equal(isOperationCoordinatorRow(row("operation", "emergency-contact")), true);
  });

  it("is false for single / member / unstamped rows", () => {
    assert.equal(isOperationCoordinatorRow(row("single")), false);
    assert.equal(isOperationCoordinatorRow(row("operation-member")), false);
    assert.equal(isOperationCoordinatorRow(row(undefined)), false);
  });
});

describe("isOperationCoordinatorWorkflow", () => {
  it("matches the canonical coordinator set and nothing else", () => {
    assert.equal(isOperationCoordinatorWorkflow("oath-signature"), true);
    assert.equal(isOperationCoordinatorWorkflow("emergency-contact"), true);
    assert.equal(isOperationCoordinatorWorkflow("onbase"), true);
    assert.equal(isOperationCoordinatorWorkflow("oath-upload"), false);
    assert.equal(isOperationCoordinatorWorkflow("ocr"), false);
    assert.equal(isOperationCoordinatorWorkflow(undefined), false);
  });

  it("client mirror matches the canonical OPERATION_COORDINATOR_WORKFLOWS set", () => {
    // Every canonical coordinator workflow must return true via the client mirror.
    for (const workflow of CANONICAL_OPERATION_COORDINATOR_WORKFLOWS) {
      assert.equal(
        isOperationCoordinatorWorkflow(workflow),
        true,
        `client mirror missing canonical workflow: ${workflow}`,
      );
    }
    // A known non-member must stay false so the test detects over-inclusion too.
    assert.equal(isOperationCoordinatorWorkflow("oath-upload"), false);
  });
});

describe("computeOperationPipelineView", () => {
  const coordinator = (over: Partial<TrackerEntry>): TrackerEntry => ({
    workflow: "emergency-contact",
    id: "ocr-prep-s1",
    runId: "op-run-1",
    timestamp: "2026-06-22T15:00:00.000Z",
    status: "running",
    step: "ocr-prep",
    data: { archetype: "operation", ocrRunId: "ocr-run-1" },
    ...over,
  });
  const member = (over: Partial<TrackerEntry>): TrackerEntry => ({
    workflow: "emergency-contact",
    id: "10884227",
    runId: "member-run-1",
    parentRunId: "op-run-1",
    timestamp: "2026-06-22T15:17:00.000Z",
    status: "done",
    data: { archetype: "operation-member" },
    ...over,
  });

  it("always exposes the three coordinator stages", () => {
    const view = computeOperationPipelineView(coordinator({}), []);
    assert.deepEqual(view.steps, ["prepare", "review", "fan-out"]);
  });

  it("running · preparing → active on prepare", () => {
    const view = computeOperationPipelineView(
      coordinator({ data: { archetype: "operation", ocrStatus: "running" } }),
      [],
    );
    assert.deepEqual(view, { steps: ["prepare", "review", "fan-out"], currentStep: "prepare", status: "running" });
  });

  it("awaiting-review → active on review", () => {
    const view = computeOperationPipelineView(
      coordinator({ data: { archetype: "operation", ocrStatus: "awaiting-review" } }),
      [],
    );
    assert.equal(view.currentStep, "review");
    assert.equal(view.status, "running");
  });

  it("approved with members still in flight → active on fan-out", () => {
    const view = computeOperationPipelineView(
      coordinator({ step: "approved", data: { archetype: "operation", ocrStatus: "approved" } }),
      [member({ status: "running" })],
    );
    assert.deepEqual(view, { steps: ["prepare", "review", "fan-out"], currentStep: "fan-out", status: "running" });
  });

  it("all members terminal → whole pipeline done (even with a failed member)", () => {
    const view = computeOperationPipelineView(
      coordinator({ step: "approved", data: { archetype: "operation", ocrStatus: "approved" } }),
      [member({ id: "a", runId: "m1", status: "done" }), member({ id: "b", runId: "m2", status: "failed" })],
    );
    assert.deepEqual(view, { steps: ["prepare", "review", "fan-out"], currentStep: "fan-out", status: "done" });
  });

  it("OCR prep failure surfaces failed on the prepare stage", () => {
    const view = computeOperationPipelineView(
      coordinator({ status: "failed", step: "ocr-prep-failed", data: { archetype: "operation", ocrStatus: "running" } }),
      [],
    );
    assert.deepEqual(view, { steps: ["prepare", "review", "fan-out"], currentStep: "prepare", status: "failed" });
  });

  it("a cancelled/discarded coordinator marks the reached stage as the failure point", () => {
    const view = computeOperationPipelineView(
      coordinator({ status: "failed", step: "cancelled", data: { archetype: "operation", ocrStatus: "awaiting-review" } }),
      [],
    );
    assert.deepEqual(view, { steps: ["prepare", "review", "fan-out"], currentStep: "review", status: "failed" });
  });

  // Input-run operation shells (e.g. separations multi-person) have no OCR
  // phase — they use the 2-stage dispatch → fan-out timeline.
  const inputRunOp = (over: Partial<TrackerEntry>): TrackerEntry => ({
    workflow: "separations",
    id: "op-shell",
    runId: "op-run-1",
    timestamp: "2026-06-30T15:00:00.000Z",
    status: "running",
    data: { archetype: "operation" },
    ...over,
  });

  it("input-run op with no members yet → active on dispatch", () => {
    const view = computeOperationPipelineView(inputRunOp({}), []);
    assert.deepEqual(view, { steps: ["dispatch", "fan-out"], currentStep: "dispatch", status: "running" });
  });

  it("input-run op with a member in flight → active on fan-out", () => {
    const view = computeOperationPipelineView(inputRunOp({}), [
      member({ data: { archetype: "operation-member" }, status: "running" }),
    ]);
    assert.deepEqual(view, { steps: ["dispatch", "fan-out"], currentStep: "fan-out", status: "running" });
  });

  it("input-run op with all members terminal → whole pipeline done", () => {
    const view = computeOperationPipelineView(inputRunOp({}), [
      member({ id: "a", runId: "m1", status: "done" }),
      member({ id: "b", runId: "m2", status: "failed" }),
    ]);
    assert.deepEqual(view, { steps: ["dispatch", "fan-out"], currentStep: "fan-out", status: "done" });
  });

  it("input-run op that itself failed surfaces on the reached stage", () => {
    const view = computeOperationPipelineView(
      inputRunOp({ status: "failed", step: "cancelled" }),
      [],
    );
    assert.deepEqual(view, { steps: ["dispatch", "fan-out"], currentStep: "dispatch", status: "failed" });
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
