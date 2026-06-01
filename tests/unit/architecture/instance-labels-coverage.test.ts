/**
 * Every registered workflow must have an `INSTANCE_LABELS` entry so its
 * session-drawer instance is recognized (resolves to a workflow, not
 * `null`) and round-trips through `workflowNameFromInstance`. Without an
 * entry a workflow still launches a session row, but it shows up unlabeled
 * (`workflow: null`) — the "shows up but isn't hooked in" failure mode.
 *
 * Importing the workflow barrels below registers each `defineWorkflow` into
 * the kernel registry (side effect), so `getAll()` is the authoritative,
 * exact set — no fragile source parsing of `name:`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

// Side-effect registration of every workflow. Keep in sync with new workflows;
// the guard below fails loudly if a registered workflow lacks a label, but a
// missing import here would silently shrink the checked set — so this list
// mirrors src/tracker/dashboard/workflows.ts plus old-kronos-reports.
import "../../../src/workflows/crm-doc-download/index.js";
import "../../../src/workflows/emergency-contact/index.js";
import "../../../src/workflows/oath-signature/index.js";
import "../../../src/workflows/oath-upload/index.js";
import "../../../src/workflows/onboarding/index.js";
import "../../../src/workflows/ocr/index.js";
import "../../../src/workflows/person-lookup/index.js";
import "../../../src/workflows/separations/index.js";
import "../../../src/workflows/sharepoint-download/index.js";
import "../../../src/workflows/work-study/index.js";
import "../../../src/workflows/old-kronos-reports/index.js";

import { getAll } from "../../../src/core/kernel/registry.js";
import { INSTANCE_LABELS, workflowNameFromInstance } from "../../../src/tracker/session-events.js";

test("every registered workflow has an INSTANCE_LABELS entry", () => {
  const missing = getAll()
    .map((wf) => wf.name)
    .filter((name) => !Object.prototype.hasOwnProperty.call(INSTANCE_LABELS, name));
  assert.deepEqual(
    missing,
    [],
    `These registered workflows have no INSTANCE_LABELS entry, so their session ` +
      `rows resolve to workflow:null (unlabeled in the terminal drawer). Add an ` +
      `entry in src/tracker/session-events.ts: ${missing.join(", ")}`,
  );
});

test("INSTANCE_LABELS round-trips name ↔ label via workflowNameFromInstance", () => {
  for (const [name, label] of Object.entries(INSTANCE_LABELS)) {
    assert.equal(
      workflowNameFromInstance(`${label} 1`),
      name,
      `"${label} 1" must resolve back to "${name}"`,
    );
  }
});
