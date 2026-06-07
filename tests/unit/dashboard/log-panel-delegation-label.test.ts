import { test } from "vitest";
import assert from "node:assert/strict";

import { deriveDelegationLabel } from "../../../src/dashboard/components/log-panel/LogPanel.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

const LABELS: Record<string, string> = {
  ocr: "OCR",
  "oath-signature": "Oath Signature",
  "person-lookup": "Person Lookup",
};
const label = (name: string): string => LABELS[name] ?? name;

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "person-lookup",
    timestamp: "2026-06-06T18:00:00.000Z",
    id: "item-1",
    runId: "run-1",
    status: "done",
    data: { archetype: "single" },
    ...overrides,
  } as TrackerEntry;
}

test("a root run (no parentRunId) reads Standalone", () => {
  const e = entry();
  assert.equal(deriveDelegationLabel(e, [e], label), "Standalone");
});

test("a delegated run reads 'from <Parent Workflow label>'", () => {
  const parent = entry({ workflow: "oath-signature", id: "oath-1", runId: "oath-run-1" });
  const child = entry({ runId: "pl-run-1", parentRunId: "oath-run-1" });
  assert.equal(deriveDelegationLabel(child, [parent, child], label), "from Oath Signature");
});

test("an OCR-delegated person-lookup reads 'from OCR'", () => {
  const ocr = entry({ workflow: "ocr", id: "ocr-1", runId: "ocr-run-1", data: { archetype: "preview" } });
  const pl = entry({ runId: "pl-run-2", parentRunId: "ocr-run-1" });
  assert.equal(deriveDelegationLabel(pl, [ocr, pl], label), "from OCR");
});

test("a delegated run whose parent row is absent falls back to 'Delegated'", () => {
  const child = entry({ runId: "pl-run-1", parentRunId: "missing-run" });
  assert.equal(deriveDelegationLabel(child, [child], label), "Delegated");
});
