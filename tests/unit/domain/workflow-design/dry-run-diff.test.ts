/**
 * Unit tests for the dry-run diff classifier — the pure seam behind the Workflow
 * Editor's "Dry run" overlay. Covers gate detection (control op), op-level skip
 * (live-only notes), step-level skip, partial steps, the verbatim boundary note,
 * the "No dry-run boundary" negative, and a loose smoke check against the real
 * assembled bank so future mining phrasing drift surfaces here.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  deriveWorkflowDryRunDiff,
  type DryRunStepDiff,
} from "../../../../src/domain/workflow-design/dry-run-diff.js";
import type {
  WorkflowDataBank,
  DataBankOperation,
  DataBankStep,
} from "../../../../src/domain/workflow-design/data-bank.js";

function op(p: Partial<DataBankOperation> & Pick<DataBankOperation, "id" | "kind" | "system" | "label">): DataBankOperation {
  return p;
}
function step(p: Partial<DataBankStep> & Pick<DataBankStep, "step" | "label">): DataBankStep {
  return { operations: [], ...p };
}
function bank(p: Partial<WorkflowDataBank> & Pick<WorkflowDataBank, "workflow">): WorkflowDataBank {
  return { systems: [], steps: [], ...p };
}

describe("deriveWorkflowDryRunDiff — gate detection", () => {
  test("a control op that branches on dryRun marks its step as the gate", () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({
        workflow: "oath-signature",
        steps: [
          step({ step: "navigation", label: "Navigate", operations: [op({ id: "ucpath.go#navigate", kind: "navigate", system: "ucpath", label: "Open profile" })] }),
          step({
            step: "save",
            label: "Save oath",
            operations: [
              op({ id: "control.dryRun#control", kind: "control", system: "control", label: "Gate: skip Save if dryRun mode", summary: "If dryRun: call beforeCommit (screenshot), skip Save." }),
              op({ id: "ucpath.save#click", kind: "click", system: "ucpath", label: "Click Save" }),
            ],
          }),
        ],
        notes: ["Dry-run boundary: dryRun skips the Save click; proof is captured."],
      }),
    );
    assert.equal(diff.hasDryRun, true);
    assert.equal(diff.gateStep, "save");
    assert.equal(diff.steps.save?.effect, "gate");
    assert.equal(diff.steps.save?.opEffects["control.dryRun#control"], "gate");
    // The reason prefers the gate op summary.
    assert.match(diff.steps.save!.reason!, /beforeCommit/);
    // Non-gate steps are not in the diff.
    assert.equal(diff.steps.navigation, undefined);
  });

  test("gate id/label-only (no summary) is still detected", () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({
        workflow: "onbase",
        steps: [step({ step: "import", label: "Import", operations: [op({ id: "control.dryRunBranch#control", kind: "control", system: "control", label: "Branch: dry run — screenshot and return without importing" })] })],
      }),
    );
    assert.equal(diff.steps.import?.effect, "gate");
  });

  test("a control op unrelated to dryRun is not a gate", () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({ workflow: "x", steps: [step({ step: "fanout", label: "Fan out", operations: [op({ id: "control.delegate#control", kind: "control", system: "control", label: "Delegate to OCR" })] })] }),
    );
    assert.equal(diff.hasDryRun, false);
    assert.deepEqual(diff.steps, {});
  });

  test("a control op that only MENTIONS dryRun in its prose (not its id) is NOT the gate", () => {
    // The EC duplicate-guard / modal-mask ops run on the `!dryRun` branch and
    // mention it in their summary/note — they are skip-candidates, not the gate.
    const diff = deriveWorkflowDryRunDiff(
      bank({
        workflow: "ec",
        steps: [step({
          step: "navigation",
          label: "Navigate + duplicate guard",
          operations: [
            op({ id: "control.duplicateGuard#control", kind: "control", system: "control", label: "Duplicate guard", summary: "fuzzy match → demote existing primary (if !dryRun) + re-navigate" }),
            op({ id: "ucpath.modalMask#click", kind: "control", system: "ucpath", label: "Dismiss modal mask (pre-demote, fuzzy + !dryRun path)", note: "Only on fuzzy match + !dryRun." }),
          ],
        })],
      }),
    );
    // No gate: the guard's id isn't a dryRun slug; the mask op is a live-only skip.
    assert.equal(diff.gateStep, undefined);
    assert.equal(diff.steps.navigation?.effect, "partial");
    assert.equal(diff.steps.navigation?.opEffects["control.duplicateGuard#control"], undefined);
    assert.equal(diff.steps.navigation?.opEffects["ucpath.modalMask#click"], "skip");
  });
});

describe("deriveWorkflowDryRunDiff — op-level skip", () => {
  const skipNotes = [
    "Only on fuzzy match + !dryRun.",
    "Live runs only (dry-run terminal exits before this).",
    "On dryRun, save is skipped entirely.",
  ];
  for (const note of skipNotes) {
    test(`op note "${note.slice(0, 28)}…" marks the op skipped`, () => {
      const diff = deriveWorkflowDryRunDiff(
        bank({ workflow: "ec", steps: [step({ step: "demote", label: "Demote", operations: [op({ id: "ucpath.demote#click", kind: "click", system: "ucpath", label: "Uncheck primary", note })] })] }),
      );
      assert.equal(diff.steps.demote?.opEffects["ucpath.demote#click"], "skip");
    });
  }

  test("a step with SOME skipped ops is `partial`, not `skip`", () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({
        workflow: "ec",
        steps: [
          step({
            step: "navigation",
            label: "Navigate + duplicate guard",
            operations: [
              op({ id: "ucpath.search#fill", kind: "fill", system: "ucpath", label: "Fill EID" }),
              op({ id: "ucpath.demote#click", kind: "click", system: "ucpath", label: "Demote existing", note: "Only on fuzzy match + !dryRun." }),
            ],
          }),
        ],
      }),
    );
    assert.equal(diff.steps.navigation?.effect, "partial");
    assert.equal(diff.steps.navigation?.opEffects["ucpath.search#fill"], undefined);
    assert.equal(diff.steps.navigation?.opEffects["ucpath.demote#click"], "skip");
  });
});

describe("deriveWorkflowDryRunDiff — step-level skip", () => {
  test('a step note "Skipped on: dryRun …" marks the whole step skipped', () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({ workflow: "sep", steps: [step({ step: "job-summary", label: "Fill Job Summary", note: "Skipped on: dryRun (no Kuali write), no fillable data, or Transactions-only preset." })] }),
    );
    assert.equal(diff.steps["job-summary"]?.effect, "skip");
    assert.match(diff.steps["job-summary"]!.reason!, /no Kuali write/);
  });

  test("gate wins over a step-skip note on the same step", () => {
    const diff = deriveWorkflowDryRunDiff(
      bank({
        workflow: "ec",
        steps: [step({
          step: "save",
          label: "Save",
          note: "On dryRun, save is skipped entirely and status is set to 'Dry Run Complete'.",
          operations: [op({ id: "control.dryRunGate#control", kind: "control", system: "control", label: "Dry-run gate: skip save on dryRun=true" })],
        })],
      }),
    );
    assert.equal(diff.steps.save?.effect, "gate");
    assert.equal(diff.gateStep, "save");
  });
});

describe("deriveWorkflowDryRunDiff — boundary note", () => {
  test("strips the label prefix to the verbatim boundary text", () => {
    const diff = deriveWorkflowDryRunDiff(bank({ workflow: "x", notes: ["Dry-run boundary: the transaction step skips ONLY clickSaveAndSubmit."] }));
    assert.equal(diff.hasDryRun, true);
    assert.equal(diff.boundary, "the transaction step skips ONLY clickSaveAndSubmit.");
  });

  test("uppercase + em-dash variant is accepted", () => {
    const diff = deriveWorkflowDryRunDiff(bank({ workflow: "x", notes: ["DRY-RUN BOUNDARY: record.dryRun=true → fill executes, save returns early."] }));
    assert.equal(diff.boundary, "record.dryRun=true → fill executes, save returns early.");
  });

  test('"No dry-run boundary" with no other signal → hasDryRun false', () => {
    const diff = deriveWorkflowDryRunDiff(bank({ workflow: "sharepoint", notes: ["No dry-run boundary: this workflow always executes a real download."] }));
    assert.equal(diff.hasDryRun, false);
    assert.equal(diff.boundary, undefined);
  });

  test("boundary note present but no per-step signal still flags hasDryRun (prose-only, e.g. separations)", () => {
    const diff = deriveWorkflowDryRunDiff(bank({ workflow: "sep", notes: ["Dry-run boundary: after date reconciliation, before Kuali write-backs. UCPath submit and Kuali save are skipped."] }));
    assert.equal(diff.hasDryRun, true);
    assert.equal(diff.gateStep, undefined); // no structural control op
    assert.ok(diff.boundary);
  });
});

describe("deriveWorkflowDryRunDiff — empties", () => {
  test("undefined bank → no dry run", () => {
    assert.deepEqual(deriveWorkflowDryRunDiff(undefined), { hasDryRun: false, steps: {} });
  });
  test("a workflow with no dry-run signal at all → hasDryRun false", () => {
    const diff = deriveWorkflowDryRunDiff(bank({ workflow: "x", steps: [step({ step: "a", label: "A", operations: [op({ id: "s.b#click", kind: "click", system: "s", label: "Click" })] })] }));
    assert.equal(diff.hasDryRun, false);
  });
});

// ── Smoke check against the REAL assembled bank. Loose by design: it asserts the
//    classification verdict (has/has-not dry run), NOT exact phrasing, so a mining
//    re-run that rewords a note only breaks this if it breaks classification. ─────
describe("deriveWorkflowDryRunDiff — real assembled bank", () => {
  const indexUrl = new URL("../../../../config/workflow-design/data-bank/index.json", import.meta.url);
  const realBank = JSON.parse(readFileSync(fileURLToPath(indexUrl), "utf8")) as { workflows: WorkflowDataBank[] };
  const find = (w: string): WorkflowDataBank | undefined => realBank.workflows.find((x) => x.workflow === w);

  for (const w of ["separations", "onboarding", "oath-signature", "oath-upload", "emergency-contact", "onbase"]) {
    test(`${w} is classified as having a dry-run mode with a boundary`, () => {
      const diff = deriveWorkflowDryRunDiff(find(w));
      assert.equal(diff.hasDryRun, true, `${w} should have a dry run`);
      assert.ok(diff.boundary, `${w} should expose a verbatim boundary`);
    });
  }

  test("sharepoint-download has no dry-run mode", () => {
    const diff = deriveWorkflowDryRunDiff(find("sharepoint-download"));
    assert.equal(diff.hasDryRun, false);
  });

  test("the 5 control-gate workflows expose a structural gateStep", () => {
    for (const w of ["onboarding", "oath-signature", "oath-upload", "emergency-contact", "onbase"]) {
      const diff = deriveWorkflowDryRunDiff(find(w));
      assert.ok(diff.gateStep, `${w} should have a structural gate step`);
    }
  });
});

// Type-only: keep the exported diff shape stable for the canvas overlay.
const _shape: DryRunStepDiff = { step: "x", effect: "gate", opEffects: {} };
void _shape;
