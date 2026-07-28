import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CAPABILITY_SPECS,
  CAPABILITY_STATE_LABEL,
  capabilityDryRunPosture,
  capabilityMatrix,
  capabilityRow,
} from "@/components/dev/rebuild-demo/demo-capability-wire";
import { DEMO_WORKFLOWS, type DemoWorkflowId } from "@/components/dev/rebuild-demo/demo-wire";
import { graphFor } from "@/components/dev/rebuild-demo/demo-explorer-wire";

const IDS = Object.keys(DEMO_WORKFLOWS) as DemoWorkflowId[];

/* =========================================================================
 * The rule the page exists to keep: every cell is DERIVED, and every "no" is
 * EXPLAINED. A matrix that can drift from the descriptors is worse than no
 * matrix, because it is wrong silently.
 * ====================================================================== */

test("every workflow gets a row, and every row answers every capability once", () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.length, IDS.length);
  for (const row of matrix) {
    assert.deepEqual(
      row.cells.map((c) => c.key),
      CAPABILITY_SPECS.map((s) => s.key),
      `${row.workflowId}: cells are not the capability list, in order`,
    );
  }
});

test("EVERY absent capability carries a served reason — no cell is a bare no", () => {
  for (const row of capabilityMatrix()) {
    for (const cell of row.cells) {
      if (cell.state === "available") continue;
      assert.ok(cell.reason, `${row.workflowId}/${cell.key}: absent with no reason`);
      assert.ok(
        !cell.reason.startsWith("No reason served"),
        `${row.workflowId}/${cell.key}: the descriptor declares neither the capability nor why it is absent — add it to \`absences\` in demo-wire.ts`,
      );
    }
  }
});

test("an AVAILABLE capability says what it is — a column of bare ticks is not an answer", () => {
  for (const row of capabilityMatrix()) {
    for (const cell of row.cells) {
      if (cell.state !== "available") continue;
      assert.ok(cell.detail && cell.detail.length > 0, `${row.workflowId}/${cell.key}: available with no detail`);
    }
  }
});

/* =========================================================================
 * Derivation, not authorship — each cell traced back to the field it reads
 * ====================================================================== */

test("`dryRun` is exactly the descriptor's own dry-run flag", () => {
  for (const id of IDS) {
    const served = DEMO_WORKFLOWS[id].start?.flags.some((f) => f.key === "dryRun") ?? false;
    const cell = capabilityRow(id).cells.find((c) => c.key === "dryRun");
    assert.equal(cell?.state === "available", served, `${id}: the dry-run cell disagrees with the flag`);
  }
});

test("`roster`, `workers` and `presets` are exactly the descriptor's own choices", () => {
  const byKey: Record<string, string> = { roster: "rosterSource", workers: "workers", presets: "preset" };
  for (const id of IDS) {
    const choices = DEMO_WORKFLOWS[id].start?.choices ?? [];
    for (const [capability, choiceKey] of Object.entries(byKey)) {
      const served = choices.some((c) => c.key === choiceKey);
      const cell = capabilityRow(id).cells.find((c) => c.key === capability);
      assert.equal(cell?.state === "available", served, `${id}/${capability}: disagrees with the \`${choiceKey}\` choice`);
    }
  }
});

test("`multiFile` and `merge` are the upload method's own two booleans", () => {
  for (const id of IDS) {
    const upload = DEMO_WORKFLOWS[id].start?.methods.find((m) => m.kind === "upload");
    const cells = capabilityRow(id).cells;
    assert.equal(
      cells.find((c) => c.key === "multiFile")?.state === "available",
      upload?.multiFile === true,
      `${id}: multiFile disagrees with the upload method`,
    );
    assert.equal(
      cells.find((c) => c.key === "merge")?.state === "available",
      upload?.merge === true,
      `${id}: merge disagrees with the upload method`,
    );
  }
});

test("`systemWrite` is exactly the Explorer graph's write nodes — the matrix and the graph cannot disagree", () => {
  for (const id of IDS) {
    const graph = graphFor(id);
    assert.ok(graph, `${id}: no Explorer graph`);
    const writes = graph.nodes.some((n) => n.kind === "write");
    const cell = capabilityRow(id).cells.find((c) => c.key === "systemWrite");
    assert.equal(cell?.state === "available", writes, `${id}: the write cell disagrees with the graph`);
  }
});

test("`delegation` names real workflows", () => {
  for (const row of capabilityMatrix()) {
    const cell = row.cells.find((c) => c.key === "delegation");
    if (cell?.state !== "available") continue;
    for (const label of cell.detail!.split(" · ")) {
      assert.ok(
        Object.values(DEMO_WORKFLOWS).some((w) => w.label === label),
        `${row.workflowId}: delegates to "${label}", which is not a workflow`,
      );
    }
  }
});

/* =========================================================================
 * A workflow that cannot be started declines the START capabilities for the
 * ONE reason it already serves, rather than repeating it nine times.
 * ====================================================================== */

test("a non-startable workflow declines every start capability with its own notStartable reason", () => {
  const startDerived = ["startable", "dryRun", "roster", "workers", "presets", "capture", "duplicateCheck", "multiFile", "merge", "subSelections"];
  for (const id of IDS) {
    const ref = DEMO_WORKFLOWS[id];
    if (ref.start) continue;
    assert.ok(ref.notStartable, `${id}: not startable and does not say why`);
    for (const cell of capabilityRow(id).cells) {
      if (!startDerived.includes(cell.key)) continue;
      assert.equal(cell.state, "not-applicable", `${id}/${cell.key}: should be N/A on an unstartable workflow`);
      assert.equal(cell.reason, ref.notStartable, `${id}/${cell.key}: should carry the served notStartable reason`);
    }
  }
});

/* =========================================================================
 * Read-only: the page states, it never offers
 * ====================================================================== */

test("the three states are named, and `not-applicable` is not the same word as `not-built`", () => {
  assert.equal(CAPABILITY_STATE_LABEL.available, "Yes");
  assert.notEqual(CAPABILITY_STATE_LABEL["not-applicable"], CAPABILITY_STATE_LABEL["not-built"]);
});

test("both kinds of no are actually USED — a vocabulary only one half of which appears is a vocabulary of one", () => {
  const states = capabilityMatrix().flatMap((r) => r.cells.map((c) => c.state));
  assert.ok(states.includes("not-applicable"), "no capability is marked not-applicable");
  assert.ok(states.includes("not-built"), "no capability is marked not-built");
});

/* =========================================================================
 * The dry-run posture is the Explorer's, so the two surfaces agree
 * ====================================================================== */

test("the posture line reports the boundary the Explorer draws", () => {
  const onboarding = capabilityDryRunPosture("onboarding");
  assert.equal(onboarding, "stops before I-9 creation");
  assert.equal(
    capabilityDryRunPosture("person-lookup"),
    "writes nothing — every run is already a rehearsal",
  );
  for (const id of IDS) {
    assert.ok(capabilityDryRunPosture(id), `${id}: no posture reported`);
  }
});
