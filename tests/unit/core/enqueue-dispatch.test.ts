import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineWorkflow } from "../../../src/core/index.js";
import { buildHttpPendingData } from "../../../src/core/daemon/enqueue-dispatch.js";
import { personLookupWorkflow } from "../../../src/workflows/person-lookup/workflow.js";
import { separationsWorkflow } from "../../../src/workflows/separations/workflow.js";
import { emergencyContactWorkflow } from "../../../src/workflows/emergency-contact/workflow.js";

test("buildHttpPendingData: EID lookup HTTP enqueue seeds normalized display data", () => {
  const data = buildHttpPendingData(personLookupWorkflow, { name: "zaw, hein thant" });

  assert.equal(data.name, "zaw, hein thant");
  assert.equal(data.searchName, "Zaw, Hein Thant");
  assert.equal(data.__name, "Zaw, Hein Thant");
  assert.equal(data.__id, "Zaw, Hein Thant");
  assert.equal(data.__subject, "Zaw, Hein Thant");
});

test("buildHttpPendingData: person-lookup HTTP enqueue uses person/EID title without workflow prefix", () => {
  const byName = buildHttpPendingData(personLookupWorkflow, { name: "agook, martha" });
  const byEid = buildHttpPendingData(personLookupWorkflow, { emplId: "10733938" });

  assert.equal(byName.__subject, "Agook, Martha");
  assert.equal(byName.__queueTitle, "Agook, Martha");
  assert.equal(byName.__name, "Agook, Martha");
  assert.equal(byEid.__subject, "EID 10733938");
  assert.equal(byEid.__queueTitle, "EID 10733938");
  assert.equal(byEid.__name, "10733938");
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

  const data = buildHttpPendingData(wf, { name: "Doe, Jane" });

  assert.equal(data.__queueTitle, "Doe, Jane");
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
    { name: "Doe, Jane", __runtimeOptions: { rowShape: "operation-member" } },
    "input-run-batch-1",
  );

  assert.equal(data.searchName, "Doe, Jane");
  assert.equal(data.archetype, "operation-member");
});

test("buildHttpPendingData: emergency-contact OCR fan-out seeds employeeName for member preview", () => {
  const data = buildHttpPendingData(emergencyContactWorkflow, {
    sourcePage: 2,
    employee: {
      name: "Akitsugu Uchida",
      employeeId: "10794813",
    },
    emergencyContact: {
      name: "Sara Garcia",
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
  });

  assert.equal(data.employeeName, "Akitsugu Uchida");
  assert.equal(data.emplId, "10794813");
  assert.equal(data.__name, "Akitsugu Uchida");
  assert.equal(data.contactName, "Sara Garcia");
});

test("personLookupWorkflow exposes the stable itemId deriver for HTTP enqueue", () => {
  assert.equal(
    personLookupWorkflow.config.deriveItemId?.({ name: "zaw, hein thant" }),
    "Zaw, Hein Thant",
  );
});
