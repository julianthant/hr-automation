import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  rawEcRecordFromStub,
  approvedEcRecordsFromStub,
  prepareOperation,
  approveOperation,
  assertOperationConsistency,
  type DelegationRuntime,
  type GatedWorkflowSpec,
  type RowSnapshot,
  type StubEcOcrRecord,
} from "./_runtime/index.js";
import { EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY } from "../../src/workflows/emergency-contact/workflow.js";

const REAL_TRACKER_DIR = ".tracker";
const FIXTURE_PDF = "tests/data/emergency-contacts.pdf";

function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null;
  return readdirSync(REAL_TRACKER_DIR).sort();
}

async function waitForQueue(
  workflow: string,
  dir: string,
  pred: (st: Awaited<ReturnType<typeof readQueueStateIncludingTerminals>>) => boolean,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = await readQueueStateIncludingTerminals(workflow, dir);
    if (pred(st)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForQueue(${workflow}) timed out: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll the projected (JSONL) row for a run until a predicate holds — no sleeps. */
async function waitForRow(
  rt: DelegationRuntime,
  workflow: string,
  runId: string,
  pred: (row: RowSnapshot) => boolean,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = rt.dashboard().row(workflow, runId);
    if (pred(row)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForRow(${workflow}/${runId}) timed out: status=${row.status} step=${row.step}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The gated `emergency-contact` stub — mirrors the REAL config so the dashboard
 * projection matches production: `inputSubject:"name"` (→ person kind),
 * `code:"ec"`, `archetype:"batch"`, the real
 * `EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY` (DEFAULT delegation policy — NO
 * `alwaysBatchDelegatedMembers`, unlike oath-signature). The EC child input is
 * the NESTED `EmergencyContactRecord` (`{ employee:{name,employeeId},
 * emergencyContact:{...} }`, the shape `approveTo.deriveInput` produces), so
 * `getId`/`getName`/`deriveItemId`/`initialData` read the nested
 * `employee.{employeeId,name}`. `initialData` stamps `emplId`/`employeeName`
 * so the person-kind footer subtitle resolves to the EID and the title to the
 * employee name — exactly as the real EC workflow's `detailFields` populate.
 * Gated at `transaction` (after `ucpath-auth`), the stage where a real EC fill
 * parks before its UCPath Save — the stage we hold/release.
 *
 * Identical to the gated stub in `ocr-emergency-contact.test.ts` (the bare
 * approve fan-out test); reused verbatim here so the OPERATION-coordinator
 * lifecycle is asserted against the same faithful EC member shape.
 */
const emergencyContactStub: GatedWorkflowSpec = {
  name: "emergency-contact",
  label: "Emergency Contact",
  code: "ec",
  stages: ["ucpath-auth", "transaction"],
  gatedStages: ["transaction"],
  archetype: "batch",
  inputSubject: "name",
  runtimePolicy: EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY,
  initialData: (input) => {
    const r = input as Record<string, unknown>;
    const employee = (r.employee as Record<string, unknown> | undefined) ?? {};
    const emplId = typeof employee.employeeId === "string" ? employee.employeeId : "";
    const name = typeof employee.name === "string" ? employee.name : "";
    return {
      emplId,
      ...(name ? { employeeName: name, name } : {}),
    };
  },
  getId: (d) => d.emplId ?? "",
  getName: (d) => d.employeeName ?? d.name ?? "",
  deriveItemId: (input) => input.id,
  operatorSubject: (input) => {
    const r = input as Record<string, unknown>;
    const employee = (r.employee as Record<string, unknown> | undefined) ?? {};
    const name = typeof employee.name === "string" ? employee.name : "";
    const emplId = typeof employee.employeeId === "string" ? employee.employeeId : "";
    return { kind: "person", label: name || emplId || input.id };
  },
};

/**
 * PII-FREE synthetic EC records: fake names + UCPath-shaped (10######) EIDs +
 * fake emergency-contact data. The form-EID short-circuits EC's `matchRecord`
 * to `matched`; the nested shape feeds EC's `approveTo.deriveInput`.
 */
const STUB_RECORDS: StubEcOcrRecord[] = [
  {
    sourcePage: 1,
    employee: { name: "Jane Doe", employeeId: "10000001" },
    emergencyContact: {
      name: "John Doe",
      relationship: "Spouse",
      sameAddressAsEmployee: true,
      cellPhone: "(555) 010-0001",
    },
  },
  {
    sourcePage: 2,
    employee: { name: "Richard Roe", employeeId: "10000002" },
    emergencyContact: {
      name: "Mary Roe",
      relationship: "Mother",
      sameAddressAsEmployee: false,
      address: { street: "100 Fake St", city: "San Diego", state: "CA", zip: "92093" },
      cellPhone: "(555) 010-0002",
    },
  },
];

const BY_EID: Record<string, { name: string }> = {
  "10000001": { name: "Jane Doe" },
  "10000002": { name: "Richard Roe" },
};

/**
 * Full operation-coordinator lifecycle e2e — emergency-contact from the
 * RUN-MODAL entry (`/api/ocr/prepare` with `targetWorkflow: "emergency-contact"`)
 * all the way through operation coordinator → delegated OCR review → operator
 * approve → `operation-member` contact fan-out → completion. The
 * OPERATION-COORDINATOR superset of `ocr-emergency-contact.test.ts` (which drives
 * the bare approve fan-out under an arbitrary `parentRunId`, no coordinator row).
 * Mirrors `ocr-oath-signature-operation.test.ts` for a DIFFERENT operation
 * target: NESTED `EmergencyContactRecord` input, the DEFAULT delegation policy
 * (no `alwaysBatchDelegatedMembers`, so ≥2 members make the member surface real
 * via the count-≥2 path), and the `ec-` operation trace code.
 *
 * Seam: the REAL `buildOcrPrepareHandler` + `buildOcrApproveHandler` drive the
 * real operation-coordinator stamping / delegation / `operation-member` fan-out;
 * only the orchestrator's PDF/LLM/roster/SQLite IO is stubbed (see
 * `_runtime/operation.ts`).
 */
test("emergency-contact operation: run-modal prepare → delegated OCR → approve fan-out → operation-member completion", async (t) => {
  const before = snapshotRealTracker();

  const rt = await createDelegationRuntime({
    // 2 racing emergency-contact daemon instances so ≥2 contact children can hold
    // `transaction` concurrently (a single daemon's claim loop is serial).
    workflows: [{ workflow: emergencyContactStub, instances: 2 }],
    ocr: { formType: "emergency-contact" },
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  // ── Stage A — prepare / run modal ─────────────────────────────────────────
  // Hold every contact at `transaction` BEFORE the approve fan-out claims them.
  rt.holdAll("emergency-contact", "transaction");

  // ≥2 contacts so the batch / member surface is real (EC's DEFAULT delegation
  // policy — NO `alwaysBatchDelegatedMembers` — would NOT batch a lone member;
  // the count-≥2 path in buildTrackerQueueSurfaces makes the surface real).
  const records = STUB_RECORDS.slice(0, 2);
  const { operationRunId, ocrRunId, ocrSessionId } = await prepareOperation(rt, {
    targetWorkflow: "emergency-contact",
    formType: "emergency-contact",
    fixturePath: FIXTURE_PDF,
    originalName: "emergency-contacts.pdf",
    seededRecords: records.map(rawEcRecordFromStub),
  });

  const dash = rt.dashboard();

  // Operation coordinator row: exists, archetype "operation", file/pdf kind,
  // title = PDF filename, subtitle = trace id, denormalized OCR status present.
  const opRowA = dash.row("emergency-contact", operationRunId);
  assert.equal(opRowA.archetype, "operation", "coordinator row archetype is operation");
  assert.equal(opRowA.parentRunId, null, "operation coordinator is the root (no parentRunId)");
  assert.equal(opRowA.data.queueRowKind, "file", "operation row is file-kind (pdf upload)");
  assert.equal(opRowA.title, "emergency-contacts.pdf", "operation row title is the PDF filename");
  assert.equal(opRowA.subtitle, "<traceId>", "operation row subtitle is the trace id");
  assert.equal(opRowA.data.__traceId, "<traceId>", "operation row carries a (scrubbed) trace id");
  for (const f of ["ocrStatus", "ocrStep", "ocrRunId", "ocrSessionId"] as const) {
    assert.ok(opRowA.data[f], `operation row denormalizes data.${f}`);
  }
  assert.equal(opRowA.data.ocrRunId, ocrRunId, "operation row data.ocrRunId points at the delegated OCR run");
  assert.equal(opRowA.data.ocrSessionId, ocrSessionId, "operation row data.ocrSessionId points at the OCR session");
  // Trace prefix `ec-` on the operation (operationTraceCode("emergency-contact")).
  const opRawTrace = String(dash.timeline("emergency-contact", operationRunId).at(-1)?.data?.__traceId);
  assert.match(opRawTrace, /^ec-\d{6}-[a-z0-9]{4}$/, "operation row brands the ec- operation trace code");

  // ── Stage B — awaiting approval ───────────────────────────────────────────
  // The OCR run is delegated under the operation; assert its review-row shape
  // only AFTER it has parked at awaiting-approval (the orchestrator emits its
  // snapshots in the prepare handler's background IIFE, so the rich file-kind
  // title / composed trace land asynchronously after the 202 returns).
  await rt.waitForEvent("ocr:awaiting-approval", { runId: ocrRunId });

  // Delegated OCR review row: under the operation, projects preview + needsReview,
  // file kind → PDF filename title, composes the operation's `ec-` prefix.
  const ocrRowB = dash.row("ocr", ocrRunId);
  assert.equal(ocrRowB.parentRunId, operationRunId, "OCR review row is delegated under the operation run");
  assert.equal(ocrRowB.archetype, "preview", "OCR review row archetype is preview");
  assert.equal(ocrRowB.title, "emergency-contacts.pdf", "OCR review row (file kind) title is the PDF filename");
  assert.equal(ocrRowB.data.queueRowKind, "file", "OCR review row is file-kind");
  assert.equal(ocrRowB.statusLabel, "awaiting review", "parked OCR review row shows the needsReview badge");
  // The delegated OCR row composes the operation's `ec-` prefix (root trace-id propagation).
  const ocrRawTrace = String(dash.timeline("ocr", ocrRunId).at(-1)?.data?.__traceId);
  assert.match(ocrRawTrace, /^ec-\d{6}-[a-z0-9]{4}$/, "delegated OCR row composes the ec- operation prefix");
  assert.equal(
    ocrRawTrace.slice(0, ocrRawTrace.lastIndexOf("-")),
    opRawTrace.slice(0, opRawTrace.lastIndexOf("-")),
    "OCR review row shares the operation's exact ec-<HHMMSS> prefix",
  );
  // The operation row's denormalized status reflects awaiting-approval (mirrored
  // via the prepare handler's onPhase) + the Open-OCR-review linkage fields.
  const opRowB = dash.row("emergency-contact", operationRunId);
  assert.equal(opRowB.data.ocrStatus, "awaiting-review", "operation row denormalizes awaiting-review status");
  assert.equal(opRowB.data.ocrStep, "awaiting-approval", "operation row denormalizes the awaiting-approval step");
  assert.equal(opRowB.data.ocrRunId, ocrRunId, "operation row keeps the OCR routing link (ocrRunId)");
  assert.equal(opRowB.data.ocrSessionId, ocrSessionId, "operation row keeps the OCR routing link (ocrSessionId)");

  // Consistency after prepare/awaiting-approval: 0 members yet, OCR not terminal.
  assertOperationConsistency(dash, {
    operationWorkflow: "emergency-contact",
    operationRunId,
    ocrRunId,
    expectedMembers: {},
    children: await rt.children(operationRunId),
    ocrTerminal: false,
  });

  // ── Stage C — approve fan-out ─────────────────────────────────────────────
  const children = await approveOperation(rt, {
    ocrSessionId,
    ocrRunId,
    records: approvedEcRecordsFromStub(records),
    childWorkflow: "emergency-contact",
  });
  assert.equal(children.length, 2, "approve fan-out enqueues exactly 2 contact children");
  const [c1, c2] = children;

  // The approve route's deterministic itemId shape: `ocr-ec-${ocrRunId}-r${index}`.
  for (let i = 0; i < children.length; i++) {
    assert.equal(
      children[i]!.itemId,
      `ocr-ec-${ocrRunId}-r${i}`,
      `contact ${i} itemId follows the EC approveTo.deriveItemId shape`,
    );
  }

  // Both contacts reached the held `transaction` stage.
  await rt.waitForEvent("step:start", { step: "transaction", count: 2 });
  // The OCR run terminalizes `done` when the approve route writes its terminal
  // row. As in the oath-signature operation test, the OCR run here runs in-process
  // inside the real prepare handler (no daemon task / no SQLite queue entry / no
  // `run:terminal` log event), so poll the projected OCR row's status from JSONL.
  await waitForRow(rt, "ocr", ocrRunId, (row) => row.status === "done");

  // Every contact is an OPERATION-MEMBER under the coordinator, person kind,
  // title = resolved employee name, subtitle = EID-else-trace, ec- trace prefix.
  for (const c of [c1!, c2!]) {
    const row = dash.row("emergency-contact", c.runId);
    assert.equal(
      row.parentRunId,
      operationRunId,
      `contact ${c.itemId} parentRunId === the operation coordinator run`,
    );
    assert.equal(
      row.archetype,
      "operation-member",
      `contact ${c.itemId} is an operation-member (NOT a standalone batch-member)`,
    );
    const emplId = row.data.emplId;
    assert.ok(emplId && BY_EID[emplId], `contact ${c.itemId} carries a known EID (got ${emplId})`);
    assert.equal(row.title, BY_EID[emplId!]!.name, `contact ${c.itemId} title is the resolved employee name`);
    assert.equal(row.subtitle, emplId, `contact ${c.itemId} subtitle is the EID (person row with EID)`);
    // Member composes the operation's ec- prefix (root trace-id propagation).
    const memberRawTrace = String(dash.timeline("emergency-contact", c.runId).at(-1)?.data?.__traceId);
    assert.match(memberRawTrace, /^ec-\d{6}-[a-z0-9]{4}$/, `contact ${c.itemId} composes the ec- prefix`);
    assert.equal(
      memberRawTrace.slice(0, memberRawTrace.lastIndexOf("-")),
      opRawTrace.slice(0, opRawTrace.lastIndexOf("-")),
      `contact ${c.itemId} shares the operation's exact ec-<HHMMSS> prefix`,
    );
  }

  // children() finds exactly the 2 contact runs under the coordinator.
  const kidsAfterApprove = await rt.children(operationRunId);
  const ecKids = kidsAfterApprove.filter((k) => k.workflow === "emergency-contact");
  assert.equal(ecKids.length, 2, "exactly 2 emergency-contact member children under the operation");
  assert.deepEqual(
    new Set(ecKids.map((k) => k.runId)),
    new Set([c1!.runId, c2!.runId]),
    "children() returns the 2 enqueued contact runs",
  );

  // The operation coordinator now summarizes its members (memberCount).
  const opAnchorC = dash.groupAnchor("emergency-contact", operationRunId);
  assert.equal(opAnchorC.kind, "operation", "the coordinator surface is an operation card");
  assert.equal(opAnchorC.memberCount, 2, "operation coordinator summarizes its 2 contact members");

  // Consistency after approve: 2 members, OCR terminal done.
  assertOperationConsistency(dash, {
    operationWorkflow: "emergency-contact",
    operationRunId,
    ocrRunId,
    expectedMembers: { "emergency-contact": [c1!.runId, c2!.runId] },
    children: kidsAfterApprove,
    ocrTerminal: true,
  });

  // ── Stage D — completion ──────────────────────────────────────────────────
  // Held at `transaction`; release → each reaches done.
  rt.release(c1!.runId, "transaction");
  rt.release(c2!.runId, "transaction");
  await rt.waitForEvent("run:terminal", { runId: c1!.runId, occasion: "completed" });
  await rt.waitForEvent("run:terminal", { runId: c2!.runId, occasion: "completed" });
  await waitForQueue("emergency-contact", rt.trackerDir, (st) =>
    [c1!.runId, c2!.runId].every((id) => st.done.some((i) => i.runId === id)),
  );

  // Each contact terminal done; OCR review row terminalized.
  assert.equal(dash.row("emergency-contact", c1!.runId).statusLabel, "Done", "contact 1 done");
  assert.equal(dash.row("emergency-contact", c2!.runId).statusLabel, "Done", "contact 2 done");
  assert.equal(dash.row("ocr", ocrRunId).status, "done", "OCR review row is terminal done");

  // Consistency after completion (re-run): members + OCR terminal still consistent.
  assertOperationConsistency(dash, {
    operationWorkflow: "emergency-contact",
    operationRunId,
    ocrRunId,
    expectedMembers: { "emergency-contact": [c1!.runId, c2!.runId] },
    children: await rt.children(operationRunId),
    ocrTerminal: true,
  });

  await rt.cleanup();

  // The real `.tracker/` is untouched; the temp dir is gone.
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
  assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
});
