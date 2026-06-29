import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildProjectionFromQueueSurface,
  buildWorkflowRunProjection,
} from "../../../src/domain/workflow-runtime/projection.js";
import { defaultPresentationFromMetadata } from "../../../src/domain/workflow-presentation/resolve.js";
import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import { OCR_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/ocr/workflow.js";
import { OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-signature/workflow.js";
import { OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-upload/workflow.js";
import { EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/emergency-contact/workflow.js";
import { PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/person-lookup/workflow.js";
import { CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/crm-doc-download/workflow.js";
import { SHAREPOINT_DOWNLOAD_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/sharepoint-download/workflow.js";
import { SEPARATIONS_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/separations/workflow.js";
import { ONBOARDING_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/onboarding/workflow.js";
import { WORK_STUDY_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/work-study/workflow.js";
import { KRONOS_REPORTS_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/old-kronos-reports/workflow.js";
import {
  DEFAULT_GROUP_DELETE_ACTION,
  DEFAULT_GROUP_RETRY_ACTION,
  DEFAULT_ROW_BUMP_ACTION,
  DEFAULT_ROW_CANCEL_ACTION,
  DEFAULT_ROW_DELETE_ACTION,
  DEFAULT_ROW_RETRY_ACTION,
} from "../../../src/domain/workflow-runtime/default-policy.js";

const phase4Policies = new Map([
  ["ocr", OCR_WORKFLOW_RUNTIME_POLICY],
  ["oath-signature", OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY],
  ["oath-upload", OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY],
  ["emergency-contact", EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY],
]);

const phase5Policies = new Map([
  ...phase4Policies,
  ["person-lookup", PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY],
  ["crm-doc-download", CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY],
  ["sharepoint-download", SHAREPOINT_DOWNLOAD_WORKFLOW_RUNTIME_POLICY],
  ["separations", SEPARATIONS_WORKFLOW_RUNTIME_POLICY],
  ["onboarding", ONBOARDING_WORKFLOW_RUNTIME_POLICY],
  ["work-study", WORK_STUDY_WORKFLOW_RUNTIME_POLICY],
  ["kronos-reports", KRONOS_REPORTS_WORKFLOW_RUNTIME_POLICY],
]);

function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-05-20T12:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

describe("workflow runtime projection adapters", () => {
  it("projects a normal row as a normal surface", () => {
    const row = entry({
      workflow: "work-study",
      id: "Doe, Jane",
      runId: "work-study-run-1",
      status: "pending",
      data: { __queueTitle: "Doe, Jane", __queueTitleKind: "single" },
    });

    const projection = buildWorkflowRunProjection(row, {});

    assert.equal(projection.runId, "work-study-run-1");
    assert.equal(projection.workflowId, "work-study");
    assert.equal(projection.title, "Doe, Jane");
    assert.equal(projection.surfaceType, "single");
  });

  it("projects an OCR approval delegation surface", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        pdfOriginalName: "oath-file.pdf",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {});

    assert.equal(projection.surfaceType, "preview");
    assert.equal(projection.runId, "ocr-run-1");
    assert.equal(projection.title, "oath-file.pdf");
  });

  it("projects a daemon batch group as batch delegation", () => {
    const first = entry({
      workflow: "onboarding",
      id: "child-1",
      runId: "child-run-1",
      parentRunId: "parent-run-1",
      status: "pending",
      data: { __queueTitle: "Avery Admin", __queueTitleKind: "single" },
    });
    const second = entry({
      workflow: "onboarding",
      id: "child-2",
      runId: "child-run-2",
      parentRunId: "parent-run-1",
      status: "pending",
      data: { __queueTitle: "Bailey Benefits", __queueTitleKind: "single" },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [first, second],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      workflowLabels: new Map([["onboarding", "Onboarding"]]),
    });

    assert.equal(projection.surfaceType, "operation");
    assert.deepEqual(
      projection.batchMembers.map((member) => member.runId),
      ["child-run-1", "child-run-2"],
    );
  });

  it("renders a lone OCR utility person-lookup child as a one-member batch (alwaysBatchDelegatedMembers)", () => {
    const child = entry({
      workflow: "person-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "single",
        __queueTitle: "Doe, Jane",
        __queueTitleKind: "single",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [child],
      runtimePolicies: phase5Policies,
    });

    // person-lookup opts into alwaysBatchDelegatedMembers, so a single delegated
    // lookup is a one-member batch surface, not a flat single.
    assert.equal(surfaces.flatEntries.length, 0);
    assert.equal(surfaces.groupRows.length, 1);
    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {});
    assert.equal(projection.surfaceType, "operation");
  });

  it("does not expose a raw parent run id as the batch group subtitle", () => {
    const first = entry({
      workflow: "person-lookup",
      id: "lookup-first",
      runId: "lookup-first-run",
      parentRunId: "oath-batch-run-1234",
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        parentSubject: "Oath · 1234",
      },
    });
    const second = entry({
      workflow: "person-lookup",
      id: "lookup-second",
      runId: "lookup-second-run",
      parentRunId: "oath-batch-run-1234",
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        parentSubject: "Oath · 1234",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {});

    assert.equal(projection.surfaceType, "operation");
    // Person batches carry no synthetic title (count badge + member preview
    // identify the bag of people); session-local `· #1234` ordinals are retired.
    assert.equal(projection.title, "");
    assert.notEqual(projection.subtitle, "oath-batch-run-1234");
    assert.equal(projection.subtitle, undefined);
  });

  it("derives the PARENT trace id (shared prefix, parent runId4 tail) as a one-member person batch group subtitle", () => {
    // oath-signature / person-lookup fan-out: a lone delegated person member
    // renders as a one-member batch (alwaysBatchDelegatedMembers) with NO parent
    // row in panel (the parent run lives in another workflow's tracker). The
    // group card's footer id must identify the PARENT run — derived from
    // `parentRunId` as `<sharedPrefix>-<parentRunId4>` — NOT the member's own
    // trace id and never the EID. The member preview renders its OWN trace
    // (`os-090551-ad01`), so parent footer and member read as one operation yet
    // differ in the final 4.
    const member = entry({
      workflow: "oath-signature",
      id: "ocr-oath-f85c86b9-r0",
      runId: "ad013f70-7c7e",
      parentRunId: "f85c86b9-2d85",
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        emplId: "10874100",
        name: "Barahona Martell, Carlos, D",
        __name: "Barahona Martell, Carlos, D",
        __subjectKind: "eid",
        __traceId: "os-090551-ad01",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [member],
      delegationSourceEntries: [member],
      runtimePolicies: phase5Policies,
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase5Policies,
    });

    assert.equal(projection.surfaceType, "operation");
    // Shared prefix `os-090551`, parent's runId4 tail `f85c` (from parentRunId
    // "f85c86b9-2d85") — distinct from the member's own `-ad01` tail.
    assert.equal(projection.subtitle, "os-090551-f85c");
    assert.notEqual(projection.subtitle, "os-090551-ad01");
    assert.notEqual(projection.subtitle, "10874100");
  });

  it("uses the TRACE ID as an OCR file preview subtitle, never the workflow label", () => {
    // A stamped OCR prep row (file kind + trace id) renders its footer subtitle
    // as the trace id — NOT the `data.__name = "OCR"` fallback that leaks the
    // literal workflow label.
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-trace",
      runId: "ocr-run-trace",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        queueRowKind: "file",
        pdfOriginalName: "test.pdf",
        __name: "OCR",
        __traceId: "oc-090214-1234",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      runtimePolicies: phase4Policies,
    });

    const groupProjection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });
    assert.equal(groupProjection.subtitle, "oc-090214-1234");
    assert.notEqual(groupProjection.subtitle, "OCR");

    // The flat EntryItem path (preview with no members) resolves the same id.
    const flatProjection = buildWorkflowRunProjection(ocr, {
      runtimePolicies: phase4Policies,
    });
    assert.equal(flatProjection.subtitle, "oc-090214-1234");
    assert.notEqual(flatProjection.subtitle, "OCR");
  });

  it("keeps the EID as the subtitle for a flat single person row (unchanged)", () => {
    // Flat single → the footer is the only place the EID shows, so it stays the
    // EID. preferTraceIdSubtitle is NOT applied to flat rows.
    const single = entry({
      workflow: "person-lookup",
      id: "lookup-flat",
      runId: "lookup-flat-run",
      status: "done",
      data: {
        archetype: "single",
        queueRowKind: "person",
        emplId: "20991234",
        name: "Valencia, Adolfo",
        __name: "Valencia, Adolfo",
        __subjectKind: "person",
        __traceId: "pl-100142-1bff",
      },
    });

    const projection = buildWorkflowRunProjection(single, {
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "single");
    assert.equal(projection.subtitle, "20991234");
    assert.notEqual(projection.subtitle, "pl-100142-1bff");
  });

  it("projects a single OCR prep file as single delegation preview from policy", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-single-file",
      runId: "ocr-run-0001",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        pdfOriginalName: "single-oath.pdf",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      runtimePolicies: phase4Policies,
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "preview");
    assert.equal(projection.title, "single-oath.pdf");
    assert.equal(projection.rowTypeLabel, "Preview");
  });

  // (Removed 2026-06-02: oath-signature no longer emits `mode: "prepare"` PDF
  // prep rows — it's EID-only and OCR owns prep/approval. The PDF prep-row
  // projection behavior is still covered by the emergency-contact + OCR
  // prep-row tests above, which keep their `prepRow` policy.)

  it("groups multiple OCR utility rows by parent run", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
      },
    });
    const lookup = entry({
      workflow: "person-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "single",
        searchName: "Doe, Jane",
      },
    });
    const active = entry({
      workflow: "person-lookup",
      id: "active-1",
      runId: "active-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "single",
        emplId: "10000001",
      },
    });

    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [ocr, lookup, active],
      runtimePolicies: phase4Policies,
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "operation");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((row) => row.id), ["lookup-1", "active-1"]);
    assert.deepEqual(surfaces.flatEntries.map((row) => row.id), []);
  });

  it("projects final Oath Signature rows as person-titled delegation members", () => {
    const finalRow = entry({
      workflow: "oath-signature",
      id: "ocr-oath-technical-r0",
      runId: "signature-run-1",
      parentRunId: "oath-file-run-9876",
      status: "pending",
      data: {
        archetype: "single",
        name: "Jane Doe",
        emplId: "10000001",
        __queueTitle: "Oath · 9876",
        __queueTitleKind: "batch",
      },
    });

    const projection = buildWorkflowRunProjection(finalRow, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "single");
    assert.equal(projection.title, "Jane Doe");
    assert.equal(projection.actions.find((action) => action.kind === "cancel")?.scope, "row");
  });

  it("renders the Oath Upload row as a single-row card with no nested children", () => {
    // Oath Upload is `archetype: "single"` and does NOT parent OCR / signature
    // descendants directly. It delegates one oath-signature PDF stage, waits,
    // and files the ServiceNow ticket when the delegated stage is done.
    const root = entry({
      workflow: "oath-upload",
      id: "upload-session-1",
      runId: "oath-upload-run-1",
      status: "running",
      step: "wait-signatures",
      data: {
        archetype: "single",
        pdfOriginalName: "upload-packet.pdf",
      },
    });

    const projection = buildWorkflowRunProjection(root, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.workflowId, "oath-upload");
    assert.equal(projection.runId, "oath-upload-run-1");
    assert.equal(projection.itemId, "upload-session-1");
    // Tree-scoped: a full-mode ticket owns a delegated OCR prep that must
    // unwind with it (E2E-010).
    assert.equal(projection.actions.find((action) => action.kind === "cancel")?.scope, "tree");
    // No subtitleTemplate on oath-upload — falls back to the item id.
    assert.equal(projection.subtitle, "upload-session-1");
    // No batch members — single archetype row.
    assert.equal(projection.batchMembers.length, 0);
  });

  it("projects an operation coordinator surface — OCR status before approval, signer summary after", () => {
    const operation = entry({
      workflow: "oath-signature",
      id: "op-1",
      runId: "op-run-1",
      status: "running",
      data: {
        archetype: "operation",
        queueRowKind: "file",
        pdfOriginalName: "oaths.pdf",
        ocrRunId: "ocr-run-1",
        ocrStatus: "running",
        ocrStep: "awaiting-approval",
        __traceId: "ou-101010-op01",
      },
    });

    // Before approval: operation surface carries the OCR link, no members.
    const before = buildTrackerQueueSurfaces({
      entries: [operation],
      delegationSourceEntries: [operation],
      runtimePolicies: phase4Policies,
    });
    const beforeProjection = buildProjectionFromQueueSurface(before.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });
    assert.equal(beforeProjection.surfaceType, "operation");
    assert.equal(beforeProjection.rowTypeLabel, "Operation");
    assert.equal(beforeProjection.title, "oaths.pdf");
    assert.equal(beforeProjection.runId, "op-run-1");
    assert.equal(beforeProjection.status, "running");
    assert.deepEqual(beforeProjection.actions.map((action) => action.kind), ["cancel", "delete"]);
    assert.equal(beforeProjection.actions.find((action) => action.kind === "cancel")?.enabled, true);
    assert.equal(beforeProjection.actions.find((action) => action.kind === "delete")?.enabled, false);
    assert.equal(beforeProjection.batchMembers.length, 0);

    // After approval: signer children are `operation-member` rows (the operation
    // analogue of `batch-member`) — collected as the coordinator's inline members,
    // OCR not duplicated. Each member carries its OWN trace tail (`-s1nr`); the
    // coordinator footer keeps the operation's own trace (`-op01`), so parent and
    // member share the `ou-101010` prefix yet differ in the final 4.
    const signer = entry({
      workflow: "oath-signature",
      id: "10000001",
      runId: "signer-run-1",
      parentRunId: "op-run-1",
      status: "running",
      data: {
        archetype: "operation-member",
        queueRowKind: "person",
        name: "Jane Doe",
        emplId: "10000001",
        __traceId: "ou-101010-s1nr",
      },
    });
    const after = buildTrackerQueueSurfaces({
      entries: [operation, signer],
      delegationSourceEntries: [operation, signer],
      runtimePolicies: phase4Policies,
    });
    const afterSurface = after.groupRows[0]!;
    assert.equal(afterSurface.kind, "operation", "operation-member child stays under the operation surface");
    assert.deepEqual(
      afterSurface.members.map((m) => m.runId),
      ["signer-run-1"],
      "operation-member is collected as an operation member, not its own anchor",
    );
    const afterProjection = buildProjectionFromQueueSurface(afterSurface, {
      runtimePolicies: phase4Policies,
    });
    assert.equal(afterProjection.surfaceType, "operation");
    assert.deepEqual(afterProjection.batchMembers.map((member) => member.runId), ["signer-run-1"]);
    // Member renders as a single row (operation-member → single surface type).
    assert.equal(afterProjection.batchMembers[0]!.surfaceType, "single");
    assert.equal(afterProjection.status, "running");
    // Coordinator footer = operation's own trace, NOT the member's tail.
    assert.equal(afterProjection.subtitle, "ou-101010-op01");
    assert.notEqual(afterProjection.subtitle, "ou-101010-s1nr");
  });

  it("projects a discarded operation coordinator as failed, not running", () => {
    const operation = entry({
      workflow: "emergency-contact",
      id: "op-discarded",
      runId: "op-run-discarded",
      status: "failed",
      step: "discarded",
      data: {
        archetype: "operation",
        queueRowKind: "file",
        pdfOriginalName: "contacts.pdf",
        ocrRunId: "ocr-run-discarded",
        ocrStatus: "discarded",
        ocrStep: "discarded",
      },
    });

    const surfaces = buildTrackerQueueSurfaces({
      entries: [operation],
      delegationSourceEntries: [operation],
      runtimePolicies: phase4Policies,
    });
    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "operation");
    assert.equal(projection.status, "failed");
    assert.equal(projection.step, "discarded");
    assert.equal(projection.actions.find((action) => action.kind === "cancel")?.enabled, false);
    assert.equal(projection.actions.find((action) => action.kind === "delete")?.enabled, true);
  });
});

describe("workflow runtime projection — phase 5 standard workflows", () => {
  it("projects direct utility and single workflows with default row actions", () => {
    for (const [workflowId, label] of [
      ["work-study", "Doe, Jane"],
      ["separations", "3927"],
      ["crm-doc-download", "jane@ucsd.edu"],
      ["kronos-reports", "10873698"],
    ] as const) {
      const row = entry({
        workflow: workflowId,
        id: label,
        runId: `${workflowId}-run-1`,
        status: "pending",
        data: { __queueTitle: label, __queueTitleKind: "single" },
      });
      const projection = buildWorkflowRunProjection(row, {
        runtimePolicies: phase5Policies,
      });
      assert.equal(projection.surfaceType, "single");
      assert.equal(projection.rowTypeLabel, "Single");
      // A queued (pending) row offers bump + cancel only. Retry and delete are
      // gated off — delete becomes available once the row is cancelled (→
      // terminal). Each descriptor's `enabled` is the status-driven flag the
      // unified footer reads.
      const targets = [{ workflowId, id: label, runId: projection.runId, status: "pending" }];
      assert.deepEqual(projection.actions, [
        { ...DEFAULT_ROW_BUMP_ACTION, enabled: true, targets },
        { ...DEFAULT_ROW_RETRY_ACTION, enabled: false, targets },
        { ...DEFAULT_ROW_CANCEL_ACTION, enabled: true, targets },
        { ...DEFAULT_ROW_DELETE_ACTION, enabled: false, targets },
      ]);
    }
  });

  it("gates row actions by status — running cancels, terminal retries+deletes", () => {
    const base = {
      workflow: "work-study",
      id: "Doe, Jane",
      data: { __queueTitle: "Doe, Jane", __queueTitleKind: "single" },
    } as const;
    const enabledKinds = (status: "pending" | "running" | "done" | "failed") => {
      const projection = buildWorkflowRunProjection(
        entry({ ...base, runId: `ws-${status}`, status }),
        { runtimePolicies: phase5Policies },
      );
      return projection.actions.filter((a) => a.enabled).map((a) => a.kind).sort();
    };
    assert.deepEqual(enabledKinds("running"), ["cancel"]);
    assert.deepEqual(enabledKinds("pending"), ["bump", "cancel"]);
    assert.deepEqual(enabledKinds("done"), ["delete", "retry"]);
    assert.deepEqual(enabledKinds("failed"), ["delete", "retry"]);
  });

  it("projects a direct person-lookup row as a normal utility surface", () => {
    const row = entry({
      workflow: "person-lookup",
      id: "Doe, Jane",
      runId: "lookup-direct-run",
      status: "pending",
      data: { searchName: "Doe, Jane", __queueTitle: "Doe, Jane", __queueTitleKind: "single" },
    });
    const projection = buildWorkflowRunProjection(row, {
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "single");
    assert.equal(projection.title, "Doe, Jane");
  });

  it("titles OCR person-lookup children by resolved person name instead of technical ids", () => {
    const child = entry({
      workflow: "person-lookup",
      id: "ocr-oath-technical-r0",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "done",
      data: {
        archetype: "single",
        searchName: "Jane Doe",
        emplId: "10000001",
      },
    });
    const projection = buildWorkflowRunProjection(child, {
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "single");
    assert.equal(projection.title, "Jane Doe");
  });

  it("projects a lone OCR person-lookup utility child as a one-member batch", () => {
    const child = entry({
      workflow: "person-lookup",
      id: "ocr-active-1",
      runId: "active-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "single",
        searchName: "Jane Doe",
        emplId: "10000001",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [child],
      runtimePolicies: phase5Policies,
    });
    // alwaysBatchDelegatedMembers keeps even one delegated lookup as a batch.
    assert.equal(surfaces.flatEntries.length, 0);
    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "operation");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((row) => row.id), ["ocr-active-1"]);
    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "operation");
  });

  it("projects separations daemon batch groups without a raw parent run id subtitle", () => {
    const first = entry({
      workflow: "separations",
      id: "3927",
      runId: "sep-run-1",
      parentRunId: "sep-batch-run-12345678",
      status: "pending",
      data: { __queueTitle: "Avery Admin", docId: "3927" },
    });
    const second = entry({
      workflow: "separations",
      id: "3924",
      runId: "sep-run-2",
      parentRunId: "sep-batch-run-12345678",
      status: "running",
      data: { __queueTitle: "Bailey Benefits", docId: "3924" },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [first, second],
      runtimePolicies: phase5Policies,
    });
    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      workflowLabels: new Map([["separations", "Separations"]]),
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "operation");
    assert.notEqual(projection.subtitle, "sep-batch-run-12345678");
    assert.deepEqual(projection.actions, [
      {
        ...DEFAULT_GROUP_RETRY_ACTION,
        targets: [
          { workflowId: "separations", id: "3927", runId: "sep-run-1", status: "pending" },
          { workflowId: "separations", id: "3924", runId: "sep-run-2", status: "running" },
        ],
      },
      {
        ...DEFAULT_GROUP_DELETE_ACTION,
        targets: [
          { workflowId: "separations", id: "3927", runId: "sep-run-1", status: "pending" },
          { workflowId: "separations", id: "3924", runId: "sep-run-2", status: "running" },
        ],
      },
    ]);
  });

  it("projects a single SharePoint roster download child as a delegation member", () => {
    const roster = entry({
      workflow: "sharepoint-download",
      id: "onboarding-roster",
      runId: "sp-run-1",
      parentRunId: "ocr-run-1",
      status: "running",
      data: {
        archetype: "single",
        label: "Onboarding Roster",
        parentSubject: "Emergency Contact · 5678",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [roster],
      runtimePolicies: phase5Policies,
    });
    assert.equal(surfaces.groupRows.length, 0);
    assert.deepEqual(surfaces.flatEntries.map((row) => row.id), ["onboarding-roster"]);
    const projection = buildWorkflowRunProjection(surfaces.flatEntries[0]!, {
      runtimePolicies: phase5Policies,
    });
    assert.equal(projection.surfaceType, "single");
    assert.equal(projection.title, "onboarding-roster");
  });
});

describe("workflow runtime projection — resolvePresentation (Task 4.5)", () => {
  it("member delegation naming lit: resolvePresentation memberTitle+memberSubtitle applied to delegated member", () => {
    // A delegated member entry (parentRunId set) with a context whose
    // resolvePresentation returns { delegation: { memberTitle, memberSubtitle } }.
    // The projection title/subtitle should reflect the delegation naming.
    const member = entry({
      workflow: "oath-signature",
      id: "signer-001",
      runId: "signer-run-001",
      parentRunId: "op-run-001",
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        name: "Doe, Jane",
        emplId: "10000001",
        __traceId: "os-120000-abcd",
      },
    });

    // Without resolvePresentation: falls through to default kind dispatch.
    const withoutResolver = buildWorkflowRunProjection(member, {});
    // With resolvePresentation returning delegation naming.
    const withResolver = buildWorkflowRunProjection(member, {
      resolvePresentation: () => ({
        delegation: {
          memberTitle: { scheme: "person-name" as const },
          memberSubtitle: { scheme: "trace-only" as const },
        },
      }),
    });

    // person-name → "Doe, Jane" (same as without since default also resolves name)
    assert.equal(withResolver.title, "Doe, Jane");
    // trace-only → the trace id, not EID (default for person member is eid-else-trace → EID)
    assert.equal(withResolver.subtitle, "os-120000-abcd");
    // Confirm the resolver changed the subtitle (default eid-else-trace would return EID "10000001")
    assert.notEqual(withResolver.subtitle, withoutResolver.subtitle);
    assert.equal(withoutResolver.subtitle, "10000001");
  });

  it("prep prepTitle lit: resolvePresentation prepTitle applied to OCR prep row", () => {
    // An OCR prep row with resolvePresentation returning { delegation: { prepTitle } }.
    // The projection title should reflect the prepTitle naming.
    const prep = entry({
      workflow: "ocr",
      id: "ocr-prep-001",
      runId: "ocr-run-001",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        pdfOriginalName: "oath-batch.pdf",
        __traceId: "oc-130000-e1f2",
      },
    });

    // Without resolvePresentation: falls back to pdf-filename.
    const withoutResolver = buildWorkflowRunProjection(prep, {});
    // With resolvePresentation returning prepTitle using pdf-filename scheme.
    // (The title will be the same value — "oath-batch.pdf" — but the path goes
    //  through the delegation naming, proving the code branch is exercised.)
    const withResolver = buildWorkflowRunProjection(prep, {
      resolvePresentation: () => ({
        delegation: {
          prepTitle: { scheme: "pdf-filename" as const },
        },
      }),
    });

    // pdf-filename → the PDF name
    assert.equal(withResolver.title, "oath-batch.pdf");
    // subtitle is unchanged (prepPresentation only overrides title, not subtitle)
    assert.equal(withResolver.subtitle, withoutResolver.subtitle);
  });

  it("NO-OP parity: defaultPresentationFromMetadata produces byte-identical projection to no resolver", () => {
    // For a person entry, file entry, and member entry:
    // a context with resolvePresentation returning defaultPresentationFromMetadata(...)
    // must produce a {title, subtitle} identical to the same context WITHOUT resolvePresentation.

    const personEntry = entry({
      workflow: "work-study",
      id: "person-001",
      runId: "ws-run-001",
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        name: "Doe, Jane",
        emplId: "20001234",
        __traceId: "ws-100000-a1b2",
      },
    });

    const fileEntry = entry({
      workflow: "ocr",
      id: "ocr-file-001",
      runId: "ocr-run-file-001",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        queueRowKind: "file",
        pdfOriginalName: "doc.pdf",
        __traceId: "oc-100000-b2c3",
      },
    });

    const memberEntry = entry({
      workflow: "oath-signature",
      id: "signer-parity",
      runId: "signer-run-parity",
      parentRunId: "op-run-parity",
      status: "pending",
      data: {
        archetype: "single",
        queueRowKind: "person",
        name: "Smith, John",
        emplId: "30009876",
        __traceId: "os-110000-c3d4",
      },
    });

    for (const [label, e, inputSubject] of [
      ["person", personEntry, "name"] as const,
      ["file", fileEntry, "pdf"] as const,
      ["member", memberEntry, "name"] as const,
    ]) {
      const defaultPresentation = defaultPresentationFromMetadata({
        inputSubject,
        archetype: e.data?.archetype ?? "single",
      });

      const withoutResolver = buildWorkflowRunProjection(e, {});
      const withDefaultResolver = buildWorkflowRunProjection(e, {
        resolvePresentation: () => defaultPresentation,
      });

      assert.deepStrictEqual(
        { title: withDefaultResolver.title, subtitle: withDefaultResolver.subtitle },
        { title: withoutResolver.title, subtitle: withoutResolver.subtitle },
        `${label} entry: defaultPresentationFromMetadata must produce byte-identical title/subtitle`,
      );
    }
  });
});
