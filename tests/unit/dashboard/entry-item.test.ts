import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EntryItem } from "../../../src/dashboard/components/queue-panel/EntryItem.js";
import {
  BatchFooterActions,
  selectEntriesForWorkflowAction,
} from "../../../src/dashboard/components/queue-panel/BatchFooterActions.js";
import { TooltipProvider } from "../../../src/dashboard/components/ui/tooltip.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";
import type { WorkflowActionDescriptor } from "../../../src/domain/workflow-runtime/types.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderEntry(entry: TrackerEntry): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(EntryItem, {
        entry,
        selected: false,
        onSelect: () => {},
        date: "2026-05-19",
        onDelete: () => {},
      }),
    ),
  );
}

test("delegated OCR needs-review rows keep normal retry delete and timer footer controls", () => {
  const html = renderEntry({
    workflow: "ocr",
    id: "ocr-oath-85507a76-r0",
    runId: "ocr-run-1",
    parentRunId: "oath-upload-run-1",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-19T12:54:08.000Z",
    firstLogTs: "2026-05-19T12:53:20.000Z",
    lastLogTs: "2026-05-19T12:54:08.000Z",
    data: {
      __name: "Oath · 6c8f",
      pdfOriginalName: "Xerox Scan_050420261004.pdf",
    },
    _hash: "needs-review-1",
  } as TrackerEntry);

  assert.match(html, /Needs review/);
  assert.match(html, /0m 48s/);
  assert.match(html, /aria-label="Retry this run"/);
  assert.match(html, /aria-label="Delete this entry permanently"/);
});

test("batch footer actions render retry and delete icon controls for grouped rows", () => {
  const html = renderToStaticMarkup(
    React.createElement(BatchFooterActions, {
      workflow: "eid-lookup",
      date: "2026-05-19",
      batchParentRunId: "ocr-run-1",
      memberEntries: [
        {
          workflow: "eid-lookup",
          id: "ocr-oath-run-r0",
          runId: "eid-run-0",
          parentRunId: "ocr-run-1",
          status: "failed",
          timestamp: "2026-05-19T12:54:08.000Z",
          _hash: "batch-0",
        } as TrackerEntry,
      ],
    }),
  );

  assert.match(html, /aria-label="Retry all 1 item in this batch"/);
  assert.match(html, /aria-label="Delete all entries in this batch"/);
});

test("batch footer actions select retry/delete targets from projection descriptors", () => {
  const entries = [
    {
      workflow: "eid-lookup",
      id: "hidden-outside-opened-projection",
      runId: "hidden-run",
      parentRunId: "batch-run",
      status: "failed",
      timestamp: "2026-05-19T12:54:08.000Z",
    },
    {
      workflow: "eid-lookup",
      id: "visible-member",
      runId: "visible-run",
      parentRunId: "batch-run",
      status: "failed",
      timestamp: "2026-05-19T12:54:08.000Z",
    },
  ] as TrackerEntry[];

  const actions: WorkflowActionDescriptor[] = [
    {
      kind: "retry",
      scope: "visible-view",
      source: "batch-view",
      label: "Retry visible rows",
      targets: [{ workflowId: "eid-lookup", id: "visible-member", runId: "visible-run" }],
      enabled: true,
    },
    {
      kind: "delete",
      scope: "visible-view",
      source: "batch-view",
      label: "Delete visible rows",
      targets: [{ workflowId: "eid-lookup", id: "visible-member", runId: "visible-run" }],
      enabled: true,
    },
  ];

  assert.deepEqual(
    selectEntriesForWorkflowAction(entries, actions, "retry").map((entry) => entry.id),
    ["visible-member"],
  );
  assert.deepEqual(
    selectEntriesForWorkflowAction(entries, actions, "delete").map((entry) => entry.id),
    ["visible-member"],
  );
});
