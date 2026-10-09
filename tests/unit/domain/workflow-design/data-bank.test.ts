/**
 * Unit tests for the Data Bank assembly — the pure seam that turns mined
 * fragments into the editor's palette + per-workflow graphs. Covers id dedupe +
 * field-level merge, deterministic ordering, system-metadata-wins, workflow op
 * genericization (no per-run data flow leaks into the shared palette), and the
 * orphan-coverage diagnostic.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  assembleDataBank,
  findOrphanOperationIds,
  genericizeOperation,
  mergeSystemOperations,
  type DataBankOperation,
  type WorkflowDataBank,
} from "../../../../src/domain/workflow-design/data-bank.js";

function op(partial: Partial<DataBankOperation> & Pick<DataBankOperation, "id" | "kind" | "system" | "label">): DataBankOperation {
  return partial;
}

describe("mergeSystemOperations", () => {
  test("dedupes by id with field-level merge + tag union", () => {
    const cats = mergeSystemOperations([
      op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "Fill EID", role: "textbox", tags: ["eid"] }),
      op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "Fill EID", accessibleName: "EID*", tags: ["id"] }),
    ]);
    assert.equal(cats.length, 1);
    assert.equal(cats[0].operations.length, 1);
    const merged = cats[0].operations[0];
    assert.equal(merged.role, "textbox"); // kept from first
    assert.equal(merged.accessibleName, "EID*"); // filled from second
    assert.deepEqual([...merged.tags!].sort(), ["eid", "id"]); // unioned
  });

  test("system op label wins over workflow op label when both carry different non-empty values", () => {
    // Regression for mergeOp priority inversion: system ops come FIRST in the input
    // array, so they become `prev`. A workflow op with a different (possibly shorter)
    // label must NOT replace the richer system-catalog label.
    const cats = mergeSystemOperations([
      op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "System Label", role: "textbox" }),
      op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "Workflow Label" }),
    ]);
    assert.equal(cats.length, 1);
    assert.equal(cats[0].operations.length, 1);
    const merged = cats[0].operations[0];
    assert.equal(merged.label, "System Label"); // prev (system) wins
    assert.equal(merged.role, "textbox"); // prev-only field is preserved
  });

  test("does not let an empty/undefined later field erase an earlier value", () => {
    const cats = mergeSystemOperations([
      op({ id: "x.a#click", kind: "click", system: "x", label: "A", accessibleName: "Real" }),
      op({ id: "x.a#click", kind: "click", system: "x", label: "A", accessibleName: "" }),
    ]);
    assert.equal(cats[0].operations[0].accessibleName, "Real");
  });

  test("orders systems by systemOrder then alpha; ops by id", () => {
    const cats = mergeSystemOperations(
      [
        op({ id: "zsys.b#click", kind: "click", system: "zsys", label: "B" }),
        op({ id: "ucpath.b#click", kind: "click", system: "ucpath", label: "B" }),
        op({ id: "ucpath.a#click", kind: "click", system: "ucpath", label: "A" }),
        op({ id: "kuali.a#click", kind: "click", system: "kuali", label: "A" }),
      ],
      { systemOrder: ["ucpath", "kuali"] },
    );
    assert.deepEqual(cats.map((c) => c.system), ["ucpath", "kuali", "zsys"]);
    assert.deepEqual(cats[0].operations.map((o) => o.id), ["ucpath.a#click", "ucpath.b#click"]);
  });
});

describe("genericizeOperation", () => {
  test("strips per-run data flow but keeps url + provenance", () => {
    const g = genericizeOperation(
      op({
        id: "kuali.eid#fill",
        kind: "fill",
        system: "kuali",
        label: "Fill EID",
        inputVar: "{eid}",
        outputVar: "{x}",
        literalValue: "lit",
        url: "https://x",
        verified: "2026-01-01",
      }),
    );
    assert.equal(g.inputVar, undefined);
    assert.equal(g.outputVar, undefined);
    assert.equal(g.literalValue, undefined);
    assert.equal(g.url, "https://x");
    assert.equal(g.verified, "2026-01-01");
  });
});

describe("assembleDataBank", () => {
  const workflow: WorkflowDataBank = {
    workflow: "separations",
    systems: ["kuali"],
    steps: [
      {
        step: "extract",
        label: "Extract",
        operations: [
          // references a system op (richer metadata should win)
          op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "Fill EID", inputVar: "{eid}" }),
          // an op no system catalog defines (orphan → added genericized)
          op({ id: "kuali.newField#fill", kind: "fill", system: "kuali", label: "Fill New", inputVar: "{n}" }),
        ],
      },
    ],
  };

  test("system metadata wins over a workflow op of the same id; data flow never leaks", () => {
    const bank = assembleDataBank({
      generatedAt: "2026-06-25T00:00:00.000Z",
      systemOps: [op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "Fill EID", role: "textbox", accessibleName: "EID*" })],
      workflows: [workflow],
    });
    const kuali = bank.systems.find((s) => s.system === "kuali")!;
    const eid = kuali.operations.find((o) => o.id === "kuali.eid#fill")!;
    assert.equal(eid.role, "textbox"); // system metadata preserved
    assert.equal(eid.accessibleName, "EID*");
    assert.equal(eid.inputVar, undefined); // workflow {eid} did NOT leak into palette
  });

  test("a workflow op with no system entry is added to the palette (genericized)", () => {
    const bank = assembleDataBank({
      generatedAt: "t",
      systemOps: [],
      workflows: [workflow],
    });
    const kuali = bank.systems.find((s) => s.system === "kuali")!;
    const orphan = kuali.operations.find((o) => o.id === "kuali.newField#fill")!;
    assert.ok(orphan, "orphan op present in palette");
    assert.equal(orphan.inputVar, undefined);
    // and it is NOT an orphan once added to the palette
    assert.deepEqual(findOrphanOperationIds(bank), []);
  });

  test("findOrphanOperationIds flags referenced ids absent from every catalog", () => {
    const bank = {
      schemaVersion: 1 as const,
      generatedAt: "t",
      systems: [{ system: "kuali", label: "Kuali", operations: [op({ id: "kuali.eid#fill", kind: "fill", system: "kuali", label: "x" })] }],
      workflows: [
        {
          workflow: "w",
          systems: ["kuali"],
          steps: [{ step: "s", label: "S", operations: [op({ id: "kuali.gone#click", kind: "click", system: "kuali", label: "y" })] }],
        },
      ],
    };
    assert.deepEqual(findOrphanOperationIds(bank), ["kuali.gone#click"]);
  });

  test("workflows are sorted by name; schemaVersion + generatedAt carried", () => {
    const bank = assembleDataBank({
      generatedAt: "STAMP",
      systemOps: [],
      workflows: [
        { workflow: "zeta", systems: [], steps: [] },
        { workflow: "alpha", systems: [], steps: [] },
      ],
    });
    assert.deepEqual(bank.workflows.map((w) => w.workflow), ["alpha", "zeta"]);
    assert.equal(bank.schemaVersion, 1);
    assert.equal(bank.generatedAt, "STAMP");
  });
});
