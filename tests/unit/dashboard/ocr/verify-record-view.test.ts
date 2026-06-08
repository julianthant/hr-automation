import { describe, it } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VerifyRecordView } from "../../../../src/dashboard/components/ocr/VerifyRecordView.js";
import type { VerifyPreviewRecord } from "../../../../src/dashboard/components/ocr/types.js";
import {
  deriveLookupInProgress,
  deriveOcrRecordLookupTracker,
  type OcrRecordLookupTracker,
} from "../../../../src/dashboard/components/ocr/lookup-status.js";
import type { TaskDependencyChild } from "../../../../src/dashboard/components/hooks/useTaskDependencies.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function verifyRecord(checks: VerifyPreviewRecord["checks"]): VerifyPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 1,
    printedName: "Doe, Jane",
    employeeId: "10000001",
    name: "Doe, Jane",
    paperEmploymentDate: "06/01/2026",
    paperDateSigned: "06/02/2026",
    employeeSigned: true,
    officerSigned: true,
    matchState: "lookup-running",
    selected: true,
    warnings: [],
    checks,
  };
}

function personLookupChild(status: string): TaskDependencyChild {
  return {
    workflow: "person-lookup",
    itemId: "ocr-verify-run-r0",
    runId: "child-run",
    status,
    metadata: { recordIndex: 0, lookupKind: "verify" },
    traceId: "ou-101010-abcd",
  };
}

describe("VerifyRecordView lookup loading text", () => {
  it("shows lookup progress instead of not found for lookup-backed missing checks", () => {
    const lookupTracker: OcrRecordLookupTracker = {
      phase: "running",
      label: "Person lookup running",
      traceId: "ou-101010-abcd",
      inProgress: true,
      enrichmentInProgress: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(VerifyRecordView, {
        record: verifyRecord([
          {
            key: "activeStatus",
            label: "Active Status",
            onPaper: false,
            paperValue: null,
            foundValue: null,
            source: "ucpath",
            status: "missing",
          },
        ]),
        lookupTracker,
      }),
    );

    assert.match(html, /Person lookup running/);
    assert.doesNotMatch(html, /not found/i);
  });

  it("shows in-progress for officialSigner during initial verify enrichment", () => {
    const lookupTracker = deriveOcrRecordLookupTracker({
      record: verifyRecord([
        {
          key: "officialSigner",
          label: "Authorized Official Signer",
          onPaper: false,
          paperValue: null,
          foundValue: null,
          source: "i9",
          status: "missing",
        },
      ]),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [personLookupChild("done")],
    });

    assert.equal(deriveLookupInProgress(lookupTracker, "officialSigner"), true);

    const html = renderToStaticMarkup(
      React.createElement(VerifyRecordView, {
        record: verifyRecord([
          {
            key: "officialSigner",
            label: "Authorized Official Signer",
            onPaper: false,
            paperValue: null,
            foundValue: null,
            source: "i9",
            status: "missing",
          },
        ]),
        lookupTracker,
      }),
    );

    assert.match(html, /I-9 lookup running/);
    assert.doesNotMatch(html, /Person lookup completed/);
    assert.doesNotMatch(html, /not found/i);
  });

  it("shows not found for officialSigner after enrichment completes", () => {
    const lookupTracker = deriveOcrRecordLookupTracker({
      record: verifyRecord([
        {
          key: "officialSigner",
          label: "Authorized Official Signer",
          onPaper: false,
          paperValue: null,
          foundValue: null,
          source: "i9",
          status: "missing",
        },
      ]),
      originalIndex: 0,
      entryStatus: "done",
      entryStep: "person-lookup",
      dependencyChildren: [personLookupChild("done")],
    });

    assert.equal(deriveLookupInProgress(lookupTracker, "officialSigner"), false);

    const html = renderToStaticMarkup(
      React.createElement(VerifyRecordView, {
        record: verifyRecord([
          {
            key: "officialSigner",
            label: "Authorized Official Signer",
            onPaper: false,
            paperValue: null,
            foundValue: null,
            source: "i9",
            status: "missing",
          },
        ]),
        lookupTracker,
      }),
    );

    assert.match(html, /not found/i);
    assert.doesNotMatch(html, /Person lookup/);
  });
});
