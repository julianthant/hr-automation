import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  resolveQueueRowStatus,
  getWorkflowStatusExtensions,
  registerWorkflowStatusExtensions,
  __resetWorkflowStatusExtensionsForTests,
  type StatusExtensionEntry,
} from "../../../src/domain/queue-row-status.js";
import { personLookupStatusExtensions } from "../../../src/domain/person-lookup-status.js";
import { ocrStatusExtensions } from "../../../src/tracker/dashboard/ocr-status.js";

function reRegister(): void {
  __resetWorkflowStatusExtensionsForTests();
  registerWorkflowStatusExtensions("person-lookup", personLookupStatusExtensions);
  registerWorkflowStatusExtensions("ocr", ocrStatusExtensions);
}

beforeEach(reRegister);

function entry(partial: Partial<StatusExtensionEntry>): StatusExtensionEntry {
  return {
    workflow: "person-lookup",
    status: "done",
    ...partial,
  };
}

describe("resolveQueueRowStatus — derivedStatus", () => {
  it("person-lookup done + activeStatus=not-found → notFound", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "not-found" } }),
      { isDone: true },
    );
    assert.equal(r.derivedStatus, "notFound");
  });

  it("person-lookup not-found but status=running → no derived status", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "running", data: { activeStatus: "not-found" } }),
      { isDone: false },
    );
    assert.equal(r.derivedStatus, null);
  });

  it("person-lookup done with a normal active status → no derived status", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "active" } }),
      { isDone: true },
    );
    assert.equal(r.derivedStatus, null);
  });

  it("delegated OCR running + awaiting-approval → needsReview", () => {
    const r = resolveQueueRowStatus(
      {
        workflow: "ocr",
        status: "running",
        step: "awaiting-approval",
        parentRunId: "parent-run-1",
        data: {},
      },
      { isDone: false },
    );
    assert.equal(r.derivedStatus, "needsReview");
  });

  it("standalone OCR awaiting-approval (no parentRunId) → no derived status", () => {
    const r = resolveQueueRowStatus(
      { workflow: "ocr", status: "running", step: "awaiting-approval", data: {} },
      { isDone: false },
    );
    assert.equal(r.derivedStatus, null);
  });

  it("OCR done (approved) → no derived status", () => {
    const r = resolveQueueRowStatus(
      { workflow: "ocr", status: "done", step: "done", parentRunId: "p", data: {} },
      { isDone: true },
    );
    assert.equal(r.derivedStatus, null);
  });

  it("workflow with no extensions → all null (default base behavior)", () => {
    const r = resolveQueueRowStatus(
      { workflow: "onboarding", status: "done", data: {} },
      { isDone: true },
    );
    assert.equal(r.derivedStatus, null);
    assert.equal(r.secondaryTag, null);
  });
});

describe("resolveQueueRowStatus — secondaryTag (person-lookup A/IA)", () => {
  it("activeStatus=inactive → IA / Inactive / warning classes", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "inactive" } }),
      { isDone: true },
    );
    assert.deepEqual(r.secondaryTag, {
      text: "IA",
      title: "Inactive",
      className: "bg-warning/12 text-warning border border-warning/30",
    });
  });

  it("activeStatus=active → A / Active / success classes", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "active" } }),
      { isDone: true },
    );
    assert.deepEqual(r.secondaryTag, {
      text: "A",
      title: "Active",
      className: "bg-success/12 text-success border border-success/30",
    });
  });

  it("activeStatus=non-hdh → A / Active (non-HDH dept) / success classes", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "non-hdh" } }),
      { isDone: true },
    );
    assert.deepEqual(r.secondaryTag, {
      text: "A",
      title: "Active (non-HDH dept)",
      className: "bg-success/12 text-success border border-success/30",
    });
  });

  it("legacy isActive=true + isDone (no activeStatus) → A / Active", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { isActive: "true" } }),
      { isDone: true },
    );
    assert.deepEqual(r.secondaryTag, {
      text: "A",
      title: "Active",
      className: "bg-success/12 text-success border border-success/30",
    });
  });

  it("legacy isActive=true but NOT done → no tag", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "running", data: { isActive: "true" } }),
      { isDone: false },
    );
    assert.equal(r.secondaryTag, null);
  });

  it("no activeStatus and no legacy active → no tag", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: {} }),
      { isDone: true },
    );
    assert.equal(r.secondaryTag, null);
  });

  it("not-found activeStatus → no secondary tag (only derived status)", () => {
    const r = resolveQueueRowStatus(
      entry({ workflow: "person-lookup", status: "done", data: { activeStatus: "not-found" } }),
      { isDone: true },
    );
    assert.equal(r.secondaryTag, null);
    assert.equal(r.derivedStatus, "notFound");
  });

  it("ocr workflow declares no secondaryTag", () => {
    assert.equal(getWorkflowStatusExtensions("ocr")?.secondaryTag, undefined);
  });
});
