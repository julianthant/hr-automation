import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  rawOathRecordFromStub,
  approvedOathRecordsFromStub,
  prepareOperation,
  approveOperation,
  assertOperationConsistency,
  type DelegationRuntime,
  type GatedWorkflowSpec,
  type RowSnapshot,
  type StubOcrRecord,
} from "./_runtime/index.js";
import { OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY } from "../../src/workflows/oath-signature/workflow.js";

const REAL_TRACKER_DIR = ".tracker";
const FIXTURE_PDF = "tests/data/multiple-oath.pdf";

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
 * The gated `oath-signature` stub — mirrors the REAL config (same as the P2.9
 * star test) so the dashboard projection matches production: `inputSubject:"eid"`
 * (→ person kind), `code:"os"`, `archetype:"single"`, the real runtime policy
 * (`delegation.alwaysBatchDelegatedMembers`), and `initialData`/`getId`/
 * `operatorSubject` that stamp `emplId` so the person-kind footer subtitle
 * resolves to the EID. Gated at `transaction` — the stage a real signer parks at
 * before its UCPath write — so the test can hold/release the operation members.
 */
const oathSignatureStub: GatedWorkflowSpec = {
  name: "oath-signature",
  label: "Oath Signature",
  code: "os",
  stages: ["ucpath-auth", "transaction"],
  gatedStages: ["transaction"],
  archetype: "single",
  inputSubject: "eid",
  runtimePolicy: OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY,
  initialData: (input) => {
    const r = input as Record<string, unknown>;
    return {
      emplId: typeof r.emplId === "string" ? r.emplId : "",
      ...(typeof r.name === "string" ? { name: r.name } : {}),
    };
  },
  getId: (d) => d.emplId ?? "",
  getName: (d) => d.name ?? "",
  deriveItemId: (input) => input.id,
  operatorSubject: (input) => {
    const r = input as Record<string, unknown>;
    return { kind: "eid", label: typeof r.emplId === "string" ? r.emplId : input.id };
  },
};

/** PII-FREE synthetic records: fake names + UCPath-shaped (10######) EIDs. */
const STUB_RECORDS: StubOcrRecord[] = [
  { sourcePage: 1, rowIndex: 0, printedName: "Jane Doe", employeeId: "10000001", employeeSigned: true, dateSigned: "05/01/2026" },
  { sourcePage: 2, rowIndex: 0, printedName: "Richard Roe", employeeId: "10000002", employeeSigned: true, dateSigned: "05/01/2026" },
  { sourcePage: 3, rowIndex: 0, printedName: "Sam Stone", employeeId: "10000003", employeeSigned: true, dateSigned: "05/02/2026" },
];

const BY_EID: Record<string, { name: string }> = {
  "10000001": { name: "Jane Doe" },
  "10000002": { name: "Richard Roe" },
  "10000003": { name: "Sam Stone" },
};

/**
 * Full operation-coordinator lifecycle e2e — oath-signature from the RUN-MODAL
 * entry (`/api/ocr/prepare` with `targetWorkflow: "oath-signature"`) all the way
 * through operation coordinator → delegated OCR review → operator approve →
 * `operation-member` signer fan-out → completion. The OPERATION-COORDINATOR
 * superset of `ocr-oath-signature.test.ts` (which drives the bare approve
 * fan-out without a coordinator row).
 *
 * Seam: the REAL `buildOcrPrepareHandler` + `buildOcrApproveHandler` drive the
 * real operation-coordinator stamping / delegation / `operation-member` fan-out;
 * only the orchestrator's PDF/LLM/roster/SQLite IO is stubbed (see
 * `_runtime/operation.ts`).
 */
test("oath-signature operation: run-modal prepare → delegated OCR → approve fan-out → operation-member completion", async (t) => {
  const before = snapshotRealTracker();

  const rt = await createDelegationRuntime({
    // 2 racing oath-signature daemon instances so ≥2 signer children can hold
    // `transaction` concurrently (a single daemon's claim loop is serial).
    workflows: [{ workflow: oathSignatureStub, instances: 2 }],
    ocr: { formType: "oath" },
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  // ── Stage A — prepare / run modal ─────────────────────────────────────────
  // Hold every signer at `transaction` BEFORE the approve fan-out claims them.
  rt.holdAll("oath-signature", "transaction");

  // ≥2 signers so the batch / member surface is real.
  const records = STUB_RECORDS.slice(0, 2);
  const { operationRunId, ocrRunId, ocrSessionId } = await prepareOperation(rt, {
    targetWorkflow: "oath-signature",
    formType: "oath",
    fixturePath: FIXTURE_PDF,
    originalName: "multiple-oath.pdf",
    seededRecords: records.map(rawOathRecordFromStub),
  });

  const dash = rt.dashboard();

  // Operation coordinator row: exists, archetype "operation", file/pdf kind,
  // title = PDF filename, subtitle = trace id, denormalized OCR status present.
  const opRowA = dash.row("oath-signature", operationRunId);
  assert.equal(opRowA.archetype, "operation", "coordinator row archetype is operation");
  assert.equal(opRowA.parentRunId, null, "operation coordinator is the root (no parentRunId)");
  assert.equal(opRowA.data.queueRowKind, "file", "operation row is file-kind (pdf upload)");
  assert.equal(opRowA.title, "multiple-oath.pdf", "operation row title is the PDF filename");
  assert.equal(opRowA.subtitle, "<traceId>", "operation row subtitle is the trace id");
  assert.equal(opRowA.data.__traceId, "<traceId>", "operation row carries a (scrubbed) trace id");
  for (const f of ["ocrStatus", "ocrStep", "ocrRunId", "ocrSessionId"] as const) {
    assert.ok(opRowA.data[f], `operation row denormalizes data.${f}`);
  }
  assert.equal(opRowA.data.ocrRunId, ocrRunId, "operation row data.ocrRunId points at the delegated OCR run");
  assert.equal(opRowA.data.ocrSessionId, ocrSessionId, "operation row data.ocrSessionId points at the OCR session");
  // Trace prefix `os-` on the operation (operationTraceCode("oath-signature")).
  const opRawTrace = String(dash.timeline("oath-signature", operationRunId).at(-1)?.data?.__traceId);
  assert.match(opRawTrace, /^os-\d{6}-[a-z0-9]{4}$/, "operation row brands the os- operation trace code");

  // ── Stage B — awaiting approval ───────────────────────────────────────────
  // The OCR run is delegated under the operation; assert its review-row shape
  // only AFTER it has parked at awaiting-approval (the orchestrator emits its
  // snapshots in the prepare handler's background IIFE, so the rich file-kind
  // title / composed trace land asynchronously after the 202 returns).
  await rt.waitForEvent("ocr:awaiting-approval", { runId: ocrRunId });

  // Delegated OCR review row: under the operation, projects preview + needsReview,
  // file kind → PDF filename title, composes the operation's `os-` prefix.
  const ocrRowB = dash.row("ocr", ocrRunId);
  assert.equal(ocrRowB.parentRunId, operationRunId, "OCR review row is delegated under the operation run");
  assert.equal(ocrRowB.archetype, "preview", "OCR review row archetype is preview");
  assert.equal(ocrRowB.title, "multiple-oath.pdf", "OCR review row (file kind) title is the PDF filename");
  assert.equal(ocrRowB.data.queueRowKind, "file", "OCR review row is file-kind");
  assert.equal(ocrRowB.statusLabel, "awaiting review", "parked OCR review row shows the needsReview badge");
  // The delegated OCR row composes the operation's `os-` prefix (root trace-id propagation).
  const ocrRawTrace = String(dash.timeline("ocr", ocrRunId).at(-1)?.data?.__traceId);
  assert.match(ocrRawTrace, /^os-\d{6}-[a-z0-9]{4}$/, "delegated OCR row composes the os- operation prefix");
  assert.equal(
    ocrRawTrace.slice(0, ocrRawTrace.lastIndexOf("-")),
    opRawTrace.slice(0, opRawTrace.lastIndexOf("-")),
    "OCR review row shares the operation's exact os-<HHMMSS> prefix",
  );
  // The operation row's denormalized status reflects awaiting-approval (mirrored
  // via the prepare handler's onPhase) + the Open-OCR-review linkage fields.
  const opRowB = dash.row("oath-signature", operationRunId);
  assert.equal(opRowB.data.ocrStatus, "awaiting-review", "operation row denormalizes awaiting-review status");
  assert.equal(opRowB.data.ocrStep, "awaiting-approval", "operation row denormalizes the awaiting-approval step");
  assert.equal(opRowB.data.ocrRunId, ocrRunId, "operation row keeps the OCR routing link (ocrRunId)");
  assert.equal(opRowB.data.ocrSessionId, ocrSessionId, "operation row keeps the OCR routing link (ocrSessionId)");

  // Consistency after prepare/awaiting-approval: 0 members yet, OCR not terminal.
  assertOperationConsistency(dash, {
    operationWorkflow: "oath-signature",
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
    records: approvedOathRecordsFromStub(records),
    childWorkflow: "oath-signature",
  });
  assert.equal(children.length, 2, "approve fan-out enqueues exactly 2 signer children");
  const [c1, c2] = children;

  // The approve route's deterministic itemId shape: `ocr-oath-${ocrRunId}-r${index}`.
  for (let i = 0; i < children.length; i++) {
    assert.equal(
      children[i]!.itemId,
      `ocr-oath-${ocrRunId}-r${i}`,
      `signer ${i} itemId follows the oath approveTo.deriveItemId shape`,
    );
  }

  // Both signers reached the held `transaction` stage.
  await rt.waitForEvent("step:start", { step: "transaction", count: 2 });
  // The OCR run terminalizes `done` when the approve route writes its terminal
  // row. Unlike the bare-fan-out test, the OCR run here runs in-process inside
  // the real prepare handler (no daemon task / no SQLite queue entry / no
  // `run:terminal` log event), so poll the projected OCR row's status from JSONL.
  await waitForRow(rt, "ocr", ocrRunId, (row) => row.status === "done");

  // Every signer is an OPERATION-MEMBER under the coordinator, person kind,
  // title = resolved name, subtitle = EID-else-trace, os- trace prefix.
  for (const c of [c1!, c2!]) {
    const row = dash.row("oath-signature", c.runId);
    assert.equal(
      row.parentRunId,
      operationRunId,
      `signer ${c.itemId} parentRunId === the operation coordinator run`,
    );
    assert.equal(
      row.archetype,
      "operation-member",
      `signer ${c.itemId} is an operation-member (NOT a standalone batch-member)`,
    );
    const emplId = row.data.emplId;
    assert.ok(emplId && BY_EID[emplId], `signer ${c.itemId} carries a known EID (got ${emplId})`);
    assert.equal(row.title, BY_EID[emplId!]!.name, `signer ${c.itemId} title is the resolved name`);
    assert.equal(row.subtitle, emplId, `signer ${c.itemId} subtitle is the EID (person row with EID)`);
    // Member composes the operation's os- prefix (root trace-id propagation).
    const memberRawTrace = String(dash.timeline("oath-signature", c.runId).at(-1)?.data?.__traceId);
    assert.match(memberRawTrace, /^os-\d{6}-[a-z0-9]{4}$/, `signer ${c.itemId} composes the os- prefix`);
    assert.equal(
      memberRawTrace.slice(0, memberRawTrace.lastIndexOf("-")),
      opRawTrace.slice(0, opRawTrace.lastIndexOf("-")),
      `signer ${c.itemId} shares the operation's exact os-<HHMMSS> prefix`,
    );
  }

  // children() finds exactly the 2 signer runs under the coordinator.
  const kidsAfterApprove = await rt.children(operationRunId);
  const sigKids = kidsAfterApprove.filter((k) => k.workflow === "oath-signature");
  assert.equal(sigKids.length, 2, "exactly 2 oath-signature member children under the operation");
  assert.deepEqual(
    new Set(sigKids.map((k) => k.runId)),
    new Set([c1!.runId, c2!.runId]),
    "children() returns the 2 enqueued signer runs",
  );

  // The operation coordinator now summarizes its members (memberCount).
  const opAnchorC = dash.groupAnchor("oath-signature", operationRunId);
  assert.equal(opAnchorC.kind, "operation", "the coordinator surface is an operation card");
  assert.equal(opAnchorC.memberCount, 2, "operation coordinator summarizes its 2 signer members");

  // Consistency after approve: 2 members, OCR terminal done.
  assertOperationConsistency(dash, {
    operationWorkflow: "oath-signature",
    operationRunId,
    ocrRunId,
    expectedMembers: { "oath-signature": [c1!.runId, c2!.runId] },
    children: kidsAfterApprove,
    ocrTerminal: true,
  });

  // ── Stage D — completion ──────────────────────────────────────────────────
  // Held at `transaction`; release → each reaches done.
  rt.release(c1!.runId, "transaction");
  rt.release(c2!.runId, "transaction");
  await rt.waitForEvent("run:terminal", { runId: c1!.runId, occasion: "completed" });
  await rt.waitForEvent("run:terminal", { runId: c2!.runId, occasion: "completed" });
  await waitForQueue("oath-signature", rt.trackerDir, (st) =>
    [c1!.runId, c2!.runId].every((id) => st.done.some((i) => i.runId === id)),
  );

  // Each signer terminal done; OCR review row terminalized.
  assert.equal(dash.row("oath-signature", c1!.runId).statusLabel, "Done", "signer 1 done");
  assert.equal(dash.row("oath-signature", c2!.runId).statusLabel, "Done", "signer 2 done");
  assert.equal(dash.row("ocr", ocrRunId).status, "done", "OCR review row is terminal done");

  // Consistency after completion (re-run): members + OCR terminal still consistent.
  assertOperationConsistency(dash, {
    operationWorkflow: "oath-signature",
    operationRunId,
    ocrRunId,
    expectedMembers: { "oath-signature": [c1!.runId, c2!.runId] },
    children: await rt.children(operationRunId),
    ocrTerminal: true,
  });

  await rt.cleanup();

  // The real `.tracker/` is untouched; the temp dir is gone.
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
  assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
});
