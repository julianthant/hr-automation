/**
 * Render-level regression for the audit-verified defect: `applyDisambiguationStd`
 * (`src/services/ocr/forms/shared.ts`) stamps `warnings` + `matchConfidence` on a
 * low-confidence LLM-disambiguated record, but `OathRecordView`/`EcRecordView`
 * (the cards an operator actually approves from) never rendered either field —
 * so a low-confidence auto-match was invisible exactly where approval happens.
 *
 * These tests render the real components to static markup and assert the
 * warning text + confidence badge are present in the output.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OathRecordView } from "../../../../src/dashboard/components/ocr/OathRecordView.js";
import { EcRecordView } from "../../../../src/dashboard/components/ocr/EcRecordView.js";
import { VerifyRecordView } from "../../../../src/dashboard/components/ocr/VerifyRecordView.js";
import type {
  OathPreviewRecord,
  PreviewRecord,
  VerifyPreviewRecord,
} from "../../../../src/dashboard/components/ocr/types.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function lowConfidenceOathRecord(): OathPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Doe, Jane",
    employeeId: "10000001",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "04/23/2026",
    notes: [],
    matchState: "lookup-pending",
    matchSource: "llm",
    matchConfidence: 0.4,
    selected: true,
    warnings: ["LLM picked EID 10000001 but low confidence (0.40) — review"],
  };
}

function lowConfidenceEcRecord(): PreviewRecord {
  return {
    formKind: "emergency-contact",
    sourcePage: 1,
    employee: { name: "Lee, Jordan", employeeId: "10000002" },
    emergencyContact: {
      name: "Lee, Robin",
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
    matchState: "lookup-pending",
    matchSource: "llm",
    matchConfidence: 0.35,
    selected: true,
    warnings: ["LLM picked EID 10000002 but low confidence (0.35) — review"],
  };
}

describe("OathRecordView warnings + confidence", () => {
  it("renders the low-confidence warning and a confidence badge", () => {
    const html = renderToStaticMarkup(
      React.createElement(OathRecordView, { record: lowConfidenceOathRecord(), onChange: () => {} }),
    );
    assert.match(html, /low confidence \(0\.40\) — review/);
    assert.match(html, /Match confidence 40%/);
    // 0.4 lands in the "medium" tier (warning tone) per matchConfidenceTier.
    assert.match(html, /border-warning\/40/);
  });

  it("renders nothing extra for a confident, warning-free match", () => {
    const record = { ...lowConfidenceOathRecord(), matchState: "matched" as const, matchConfidence: 0.95, warnings: [] };
    const html = renderToStaticMarkup(
      React.createElement(OathRecordView, { record, onChange: () => {} }),
    );
    assert.match(html, /Match confidence 95%/);
    assert.match(html, /border-success\/40/);
    assert.doesNotMatch(html, /review/);
  });
});

describe("EcRecordView warnings + confidence", () => {
  it("renders the low-confidence warning and a confidence badge", () => {
    const html = renderToStaticMarkup(
      React.createElement(EcRecordView, { record: lowConfidenceEcRecord(), onChange: () => {} }),
    );
    assert.match(html, /low confidence \(0\.35\) — review/);
    assert.match(html, /Match confidence 35%/);
    assert.match(html, /border-destructive\/40/);
  });
});

describe("VerifyRecordView confidence (approved/read-only audit path)", () => {
  it("renders a confidence badge when matchConfidence is present", () => {
    const record: VerifyPreviewRecord = {
      formKind: "oath",
      sourcePage: 1,
      printedName: "Doe, Jane",
      employeeId: "10000001",
      name: "Doe, Jane",
      matchState: "lookup-pending",
      selected: true,
      warnings: ["LLM picked EID 10000001 but low confidence (0.40) — review"],
      matchConfidence: 0.4,
      checks: [],
    };
    const html = renderToStaticMarkup(React.createElement(VerifyRecordView, { record }));
    assert.match(html, /Match confidence 40%/);
    assert.match(html, /low confidence \(0\.40\) — review/);
  });

  it("renders no confidence badge when matchConfidence is absent (native verify run)", () => {
    const record: VerifyPreviewRecord = {
      formKind: "oath",
      sourcePage: 1,
      printedName: "Doe, Jane",
      employeeId: "10000001",
      name: "Doe, Jane",
      matchState: "resolved",
      selected: true,
      warnings: [],
      checks: [],
    };
    const html = renderToStaticMarkup(React.createElement(VerifyRecordView, { record }));
    assert.doesNotMatch(html, /Match confidence/);
  });
});
