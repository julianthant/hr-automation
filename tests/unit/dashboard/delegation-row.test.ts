import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DelegationRow } from "../../../src/dashboard/components/ocr/DelegationRow.js";
import { buildQueueProjectionRows } from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";
import { TooltipProvider } from "../../../src/dashboard/components/ui/tooltip.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderDelegationRow(
  parent: TrackerEntry,
  delegatedEntries: TrackerEntry[],
  workflow: string,
  workflowLabel: string,
): string {
  const rows = buildQueueProjectionRows({
    entries: [parent, ...delegatedEntries],
    delegationSourceEntries: delegatedEntries,
    workflow,
    workflowLabel,
  });
  const row = rows.groupRows[0];
  assert.ok(row, "expected an preview group row");
  if (row.surface.kind !== "preview") throw new Error("expected preview surface");
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(DelegationRow, {
        parent: row.surface.parent,
        delegatedEntries: row.surface.members,
        projection: row.projection,
        isOperationQueueFocused: false,
        onEnterOperationQueue: () => {},
        date: "2026-05-19",
        onDelete: () => {},
      }),
    ),
  );
}

test("prep-only preview card shows duration and row retry/delete footer", () => {
  // New approval contract (2026-05-25): the OCR row stays status="running"
  // step="awaiting-approval" until operator approves. While running, the
  // batch timer is live; while live, the rendered label uses useElapsed
  // (computed against `now`). Test asserts only the static affordances —
  // retry/delete footer + a numeric duration somewhere in the output.
  const html = renderDelegationRow(
    {
      workflow: "ocr",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "ocr-session",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: { mode: "prepare", archetype: "preview", formType: "oath" },
    } as TrackerEntry,
    [],
    "ocr",
    "OCR",
  );

  // Live duration tick (running state). formatSeconds rolls up past 1h/24h,
  // so accept "Nm Ss", "Nh Mm", "Nd Hh", or a bare unit.
  assert.match(html, /\d+[dhms]( \d+[hms])?/);
  assert.match(html, /aria-label="Retry this run"/);
  assert.match(html, /aria-label="Delete this (entry|run) permanently"/);
});

test("single-signer approved batch card shows duration and child row retry/delete footer", () => {
  const html = renderDelegationRow(
    {
      workflow: "ocr",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "prep",
      runId: "parent-901e",
      status: "done",
      step: "approved",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: {
        mode: "prepare",
        archetype: "preview",
        pdfOriginalName: "test.pdf",
        __name: "Oath · 901e",
      },
    } as TrackerEntry,
    [
      {
        workflow: "emergency-contact",
        timestamp: "2026-05-19T12:55:00.000Z",
        id: "10874100",
        runId: "kernel-1",
        parentRunId: "parent-901e",
        status: "failed",
        firstLogTs: "2026-05-19T12:55:00.000Z",
        lastLogTs: "2026-05-19T12:56:00.000Z",
        data: { archetype: "operation-member", emplId: "10874100", name: "Correa Dinora" },
      } as TrackerEntry,
    ],
    "ocr",
    "OCR",
  );

  assert.match(html, /\d+[dhms]( \d+[hms])?/);
  assert.match(html, /aria-label="Retry this run"/);
  assert.match(html, /aria-label="Delete this (entry|run) permanently"/);
});

test("running single-signer child shows uniform cancel footer op", () => {
  const html = renderDelegationRow(
    {
      workflow: "ocr",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "prep",
      runId: "parent-901e",
      status: "done",
      step: "approved",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: { mode: "prepare", archetype: "preview", __name: "Oath · 901e" },
    } as TrackerEntry,
    [
      {
        workflow: "emergency-contact",
        timestamp: "2026-05-19T12:55:00.000Z",
        id: "10874100",
        runId: "kernel-1",
        parentRunId: "parent-901e",
        status: "running",
        firstLogTs: "2026-05-19T12:55:00.000Z",
        data: { archetype: "operation-member", emplId: "10874100", name: "Correa Dinora" },
      } as TrackerEntry,
    ],
    "ocr",
    "OCR",
  );

  // Footers are uniform and status-gated by projection actions. A running
  // single delegated child should expose the same cancel affordance as an
  // ordinary running row, not only terminal retry/delete buttons.
  assert.match(html, /\d+[dhms]( \d+[hms])?/);
  assert.match(html, /aria-label="Stop running item"/);
  assert.doesNotMatch(html, /aria-label="Retry this run"/);
  assert.doesNotMatch(html, /aria-label="Delete this (entry|run) permanently"/);
});
