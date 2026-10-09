import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineWorkflow } from "../../../src/core/index.js";
import { buildHttpPendingData } from "../../../src/core/daemon/enqueue-dispatch.js";
import { personLookupWorkflow } from "../../../src/workflows/person-lookup/workflow.js";
import { separationsWorkflow } from "../../../src/workflows/separations/workflow.js";
import { emergencyContactWorkflow } from "../../../src/workflows/emergency-contact/workflow.js";

test("buildHttpPendingData: EID lookup HTTP enqueue seeds normalized display data", () => {
  const data = buildHttpPendingData(personLookupWorkflow, { name: "zun, haki tuwom" });

  assert.equal(data.name, "zun, haki tuwom");
  assert.equal(data.searchName, "Zun, Haki Tuwom");
  assert.equal(data.__name, "Zun, Haki Tuwom");
  assert.equal(data.__id, "Zun, Haki Tuwom");
  assert.equal(data.__subject, "Zun, Haki Tuwom");
});

test("buildHttpPendingData: person-lookup HTTP enqueue uses person/EID title without workflow prefix", () => {
  const byName = buildHttpPendingData(personLookupWorkflow, { name: "aafav, maczzd" });
  const byEid = buildHttpPendingData(personLookupWorkflow, { emplId: "10090187" });

  assert.equal(byName.__subject, "Aafav, Maczzd");
  assert.equal(byName.__queueTitle, "Aafav, Maczzd");
  assert.equal(byName.__name, "Aafav, Maczzd");
  assert.equal(byEid.__subject, "EID 10090187");
  assert.equal(byEid.__queueTitle, "EID 10090187");
  assert.equal(byEid.__name, "10090187");
});

test("buildHttpPendingData preserves workflow queue title metadata", () => {
  const wf = defineWorkflow({
    name: "queue-title-http-test",
    systems: [],
    steps: ["done"] as const,
    schema: z.object({ name: z.string() }),
    queueTitle: { kind: "single" },
    operatorSubject: (input) => ({ kind: "person", label: input.name }),
    handler: async () => {},
  });

  const data = buildHttpPendingData(wf, { name: "Person 905" });

  assert.equal(data.__queueTitle, "Person 905");
  assert.equal(data.__queueTitleKind, "single");
});

test("buildHttpPendingData stamps a single separation enqueue as a single row", () => {
  const data = buildHttpPendingData(separationsWorkflow, { docId: "4025" });

  assert.equal(data.docId, "4025");
  // Operator subject is JUST the input value — the "Separation" workflow-name
  // prefix was removed 2026-07-01 (titles show what the row is about, not the
  // workflow). See src/domain/operator-subject.ts.
  assert.equal(data.__subject, "4025");
  assert.equal(data.archetype, "single");
});

test("buildHttpPendingData honors direct input-run batch row-shape hint", () => {
  const data = buildHttpPendingData(
    personLookupWorkflow,
    { name: "Person 905", __runtimeOptions: { rowShape: "operation-member" } },
    "input-run-batch-1",
  );

  assert.equal(data.searchName, "Person 905");
  assert.equal(data.archetype, "operation-member");
});

test("buildHttpPendingData: emergency-contact OCR fan-out seeds employeeName for member preview", () => {
  const data = buildHttpPendingData(emergencyContactWorkflow, {
    sourcePage: 2,
    employee: {
      name: "Aidetupa Ueguba",
      employeeId: "10090216",
    },
    emergencyContact: {
      name: "Sane Gozobu",
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
  });

  assert.equal(data.employeeName, "Aidetupa Ueguba");
  assert.equal(data.emplId, "10090216");
  assert.equal(data.__name, "Aidetupa Ueguba");
  assert.equal(data.contactName, "Sane Gozobu");
});

test("personLookupWorkflow exposes the stable itemId deriver for HTTP enqueue", () => {
  assert.equal(
    personLookupWorkflow.config.deriveItemId?.({ name: "zun, haki tuwom" }),
    "Zun, Haki Tuwom",
  );
});
