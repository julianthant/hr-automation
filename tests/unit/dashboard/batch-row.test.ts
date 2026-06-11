import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonBatchRow } from "../../../src/dashboard/components/queue-panel/DaemonBatchRow.js";
import { orderBatchPreviewMembers } from "../../../src/dashboard/components/queue-panel/batch-row-variants.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";
import type { WorkflowRunProjection } from "../../../src/domain/workflow-runtime/types.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const DATE = "2026-06-04";

function row(partial: Partial<TrackerEntry> & { id: string }): TrackerEntry {
  return {
    workflow: "oath-signature",
    timestamp: "2026-06-04T09:05:00.000Z",
    status: "pending",
    _hash: partial.id,
    ...partial,
  } as TrackerEntry;
}

function member(id: string, status: TrackerEntry["status"], name: string): TrackerEntry {
  return row({
    id,
    runId: id,
    status,
    parentRunId: "batch-run-1",
    data: {
      archetype: "batch-member",
      queueRowKind: "person",
      name,
      emplId: `1001000${id.slice(-1)}`,
      __traceId: `os-090500-${id}`,
    },
  });
}

function projection(title: string, subtitle: string): WorkflowRunProjection {
  return {
    runId: "batch-run-1",
    workflowId: "oath-signature",
    itemId: "batch-run-1",
    title,
    subtitle,
    status: "running",
    surfaceType: "batch",
    rowTypeLabel: "Batch",
    actions: [],
    batchMembers: [],
  } as unknown as WorkflowRunProjection;
}

test("daemon batch row renders a dedicated queue affordance instead of an operation-style expander", () => {
  const html = renderToStaticMarkup(
    React.createElement(DaemonBatchRow, {
      workflow: "oath-signature",
      date: DATE,
      batchParentRunId: "batch-run-1",
      workflowLabel: "Oath Signature",
      projection: projection("Approved_Oath_Batch.pdf", "os-090500-7711"),
      memberEntries: [
        member("m1", "done", "Grace Liu"),
        member("m2", "running", "Ian Wong"),
        member("m3", "pending", "Nadia Haddad"),
        member("m4", "failed", "Owen Fischer"),
        member("m5", "pending", "Rosa Delgado"),
      ],
      isBatchQueueFocused: false,
      onEnterBatchQueue: () => {},
      onDeletedIds: () => {},
    }),
  );

  assert.doesNotMatch(html, /Open queue/);
  assert.doesNotMatch(html, />Queue preview</i);
  assert.doesNotMatch(html, />Status</);
  assert.match(html, /aria-label="1 done"/);
  assert.doesNotMatch(html, /queue rows/);
  assert.doesNotMatch(html, /more in the dedicated queue/);
  assert.doesNotMatch(html, /aria-expanded/);
  const ian = html.indexOf("Ian Wong");
  const nadia = html.indexOf("Nadia Haddad");
  const rosa = html.indexOf("Rosa Delgado");
  const owen = html.indexOf("Owen Fischer");
  assert.ok(ian >= 0 && nadia >= 0 && rosa >= 0 && owen >= 0);
  assert.ok(ian < nadia && nadia < rosa, "running member previews before queued members");
  assert.ok(rosa < owen, "queued members preview before failed fallback");
});

test("orderBatchPreviewMembers prioritizes running, then queued, then done", () => {
  const members = [
    member("m1", "done", "Grace Liu"),
    member("m2", "running", "Ian Wong"),
    member("m3", "pending", "Nadia Haddad"),
    member("m4", "failed", "Owen Fischer"),
    member("m5", "pending", "Rosa Delgado"),
  ];
  const ordered = orderBatchPreviewMembers(members);
  assert.deepEqual(
    ordered.map((m) => m.id),
    ["m2", "m3", "m5", "m4"],
  );
});

test("batch member counts treat skipped as done (terminal success), not queued", () => {
  // BM-4: the member count tally now uses the canonical aggregateBatchCounts,
  // which folds skipped → done. A skipped member is terminal (it will never
  // run), so counting it as pending work would spin a forever-incomplete header.
  const html = renderToStaticMarkup(
    React.createElement(DaemonBatchRow, {
      workflow: "oath-signature",
      date: DATE,
      batchParentRunId: "batch-run-skip",
      workflowLabel: "Oath Signature",
      projection: projection("Skip_Batch.pdf", "os-090500-7711"),
      memberEntries: [
        member("s1", "done", "Grace Liu"),
        member("s2", "skipped", "Ian Wong"),
      ],
      isBatchQueueFocused: false,
      onEnterBatchQueue: () => {},
      onDeletedIds: () => {},
    }),
  );

  // 2 done (1 real done + 1 skipped folded in), 0 queued.
  assert.match(html, /aria-label="2 done"/);
  assert.match(html, /aria-label="0 queued"/);
});

test("person batch anchor omits the identity header and opens from the whole row", () => {
  const html = renderToStaticMarkup(
    React.createElement(DaemonBatchRow, {
      workflow: "onboarding",
      date: DATE,
      batchParentRunId: "batch-run-2",
      workflowLabel: "Onboarding",
      projection: projection("", "ob-090500-7f31"),
      memberEntries: [
        member("p1", "done", "Grace Liu"),
        member("p2", "done", "Ian Wong"),
        member("p3", "running", "Nadia Haddad"),
        member("p4", "pending", "Owen Fischer"),
      ],
      isBatchQueueFocused: false,
      onEnterBatchQueue: () => {},
      onDeletedIds: () => {},
    }),
  );

  assert.doesNotMatch(html, /Open queue/);
  assert.doesNotMatch(html, /more in the dedicated queue/);
  assert.match(html, /aria-label="1 running"/);
  assert.doesNotMatch(html, /queue rows/);
  assert.match(html, /role="button"/);
  const nadia = html.indexOf("Nadia Haddad");
  const owen = html.indexOf("Owen Fischer");
  assert.ok(nadia >= 0 && owen >= 0 && nadia < owen, "preview lists running before queued");
});

test("daemon batch row renders the memberless pre-fan-out waiting strip with anchor footer identity", () => {
  const anchor = row({
    id: "batch-run-1",
    runId: "batch-run-1",
    status: "running",
    firstLogTs: "2026-06-04T09:05:00.000Z",
    data: {
      archetype: "batch",
      queueRowKind: "file",
      pdfOriginalName: "Oath_Packet_Batch.pdf",
      __traceId: "os-095000-7711",
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(DaemonBatchRow, {
      workflow: "oath-signature",
      date: DATE,
      batchParentRunId: "batch-run-1",
      workflowLabel: "Oath Signature",
      projection: projection("Oath_Packet_Batch.pdf", "os-095000-7711"),
      memberEntries: [],
      anchorEntry: anchor,
      isBatchQueueFocused: false,
      onEnterBatchQueue: () => {},
      onDeletedIds: () => {},
    }),
  );

  assert.doesNotMatch(html, /queue rows/);
  assert.match(html, /aria-label="0 done"/);
  assert.match(html, /no rows yet/);
  assert.match(html, /os-095000-7711/);
});
