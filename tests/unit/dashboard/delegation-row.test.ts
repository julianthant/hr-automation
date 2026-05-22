import { test } from "node:test";
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
  assert.ok(row, "expected an approval-delegation group row");
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(DelegationRow, {
        parent: row.surface.parent,
        delegatedEntries: row.surface.members,
        projection: row.projection,
        isBatchQueueFocused: false,
        onEnterBatchQueue: () => {},
        date: "2026-05-19",
        onDelete: () => {},
      }),
    ),
  );
}

test("prep-only approval-delegation card shows duration and row retry/delete footer", () => {
  const html = renderDelegationRow(
    {
      workflow: "ocr",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "ocr-session",
      runId: "ocr-run-1",
      status: "done",
      step: "awaiting-approval",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: { mode: "prepare", archetype: "batch-parent", formType: "oath" },
    } as TrackerEntry,
    [],
    "ocr",
    "OCR",
  );

  assert.match(html, /0m 48s/);
  assert.match(html, /aria-label="Retry this run"/);
  assert.match(html, /aria-label="Delete this (entry|run) permanently"/);
});

test("single-signer approved batch card shows duration and child row retry/delete footer", () => {
  const html = renderDelegationRow(
    {
      workflow: "oath-signature",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "prep",
      runId: "parent-901e",
      status: "done",
      step: "approved",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: {
        mode: "prepare",
        archetype: "batch-parent",
        pdfOriginalName: "test.pdf",
        __name: "Oath · 901e",
      },
    } as TrackerEntry,
    [
      {
        workflow: "oath-signature",
        timestamp: "2026-05-19T12:55:00.000Z",
        id: "10874100",
        runId: "kernel-1",
        parentRunId: "parent-901e",
        status: "failed",
        firstLogTs: "2026-05-19T12:55:00.000Z",
        lastLogTs: "2026-05-19T12:56:00.000Z",
        data: { archetype: "delegate-child", emplId: "10874100", name: "Correa Dinora" },
      } as TrackerEntry,
    ],
    "oath-signature",
    "Oath Signature",
  );

  assert.match(html, /\d+m \d+s/);
  assert.match(html, /aria-label="Retry this run"/);
  assert.match(html, /aria-label="Delete this (entry|run) permanently"/);
});

test("running single-signer child keeps duration without premature retry/delete icons", () => {
  const html = renderDelegationRow(
    {
      workflow: "oath-signature",
      timestamp: "2026-05-19T12:54:08.000Z",
      id: "prep",
      runId: "parent-901e",
      status: "done",
      step: "approved",
      firstLogTs: "2026-05-19T12:53:20.000Z",
      lastLogTs: "2026-05-19T12:54:08.000Z",
      data: { mode: "prepare", archetype: "batch-parent", __name: "Oath · 901e" },
    } as TrackerEntry,
    [
      {
        workflow: "oath-signature",
        timestamp: "2026-05-19T12:55:00.000Z",
        id: "10874100",
        runId: "kernel-1",
        parentRunId: "parent-901e",
        status: "running",
        firstLogTs: "2026-05-19T12:55:00.000Z",
        data: { archetype: "delegate-child", emplId: "10874100", name: "Correa Dinora" },
      } as TrackerEntry,
    ],
    "oath-signature",
    "Oath Signature",
  );

  assert.match(html, /\d+m \d+s|\d+s/);
  assert.doesNotMatch(html, /aria-label="Retry this run"/);
  assert.doesNotMatch(html, /aria-label="Delete this (entry|run) permanently"/);
});
