import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  rawEcRecordFromStub,
  approvedEcRecordsFromStub,
  type GatedWorkflowSpec,
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

/**
 * The gated `emergency-contact` stub — mirrors the REAL config so the dashboard
 * projection matches production: `inputSubject:"name"` (→ person kind),
 * `code:"ec"`, `archetype:"operation"`, the real
 * `EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY` (default delegation policy — NO
 * `alwaysOperationDelegatedMembers`, unlike oath-signature). The EC child input is
 * the nested `EmergencyContactRecord` (the shape `approveTo.deriveInput`
 * produces), so `getId`/`getName`/`deriveItemId`/`initialData` read the nested
 * `employee.{employeeId,name}`. `initialData` stamps `emplId`/`employeeName` so
 * the person-kind footer subtitle resolves to the EID and the title to the
 * employee name — exactly as the real EC workflow's `detailFields` populate.
 * Gated at `transaction` (after `ucpath-auth`), the stage where a real EC fill
 * parks before its UCPath Save — the stage we hold/cancel/release.
 */
const emergencyContactStub: GatedWorkflowSpec = {
  name: "emergency-contact",
  label: "Emergency Contact",
  code: "ec",
  stages: ["ucpath-auth", "transaction"],
  gatedStages: ["transaction"],
  archetype: "operation",
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
  {
    sourcePage: 3,
    employee: { name: "Sam Stone", employeeId: "10000003" },
    emergencyContact: {
      name: "Pat Stone",
      relationship: "Sibling",
      sameAddressAsEmployee: true,
      homePhone: "(555) 010-0003",
    },
  },
];

/**
 * P2.10 — OCR → emergency-contact `approveTo` fan-out through the REAL daemon
 * (no browser, temp tracker root, no `.tracker/` pollution). Same shape as the
 * P2.9 oath-signature star test, for a DIFFERENT form type (nested
 * `EmergencyContactRecord` input, default delegation policy, `ec-` trace code).
 *
 * Flow: stub OCR run (real `runOcrOrchestrator`, stubbed LLM/roster/eid-lookup)
 * → `ocr:awaiting-approval` → REAL `buildOcrApproveHandler` fan-out → 3 gated
 * emergency-contact children → cancel one mid-hold → release siblings → assert
 * the dashboard projection invariant checklist.
 */
test("OCR → emergency-contact approveTo fan-out: projection correct under hold/cancel/release", async (t) => {
  const before = snapshotRealTracker();

  const rt = await createDelegationRuntime({
    // 3 racing emergency-contact daemon instances so all 3 children can hold
    // `transaction` concurrently (a single daemon's claim loop is serial).
    workflows: [{ workflow: emergencyContactStub, instances: 3 }],
    ocr: { formType: "emergency-contact" },
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  // 1. Seed synthetic EC records (raw, verbatim) + hold every child at
  // `transaction` BEFORE approval.
  rt.stubOcr(STUB_RECORDS.map(rawEcRecordFromStub));
  rt.holdAll("emergency-contact", "transaction");

  // 2. Enqueue the OCR run DELEGATED (registers the fixture PDF) + wait for the
  // awaiting-approval park. Approve REQUIRES a delegated run since 2026-06-11
  // (standalone approve is rejected 400 — approval ≡ delegation).
  const PARENT_RUN = "op-parent-star-ec";
  const ocr = await rt.enqueueOcr({
    fixturePath: FIXTURE_PDF,
    originalName: "emergency-contacts.pdf",
    parentRunId: PARENT_RUN,
  });
  await rt.waitForEvent("ocr:awaiting-approval", { runId: ocr.runId });

  // 3. Drive the REAL approve fan-out → 3 emergency-contact children, each a
  // controllable daemon run under the delegating run (childParentRunId =
  // parentRunId; EC's `canFanOut` EID gate passes — all stub records carry
  // valid 10###### EIDs).
  const children = await rt.approveOcr({
    sessionId: ocr.sessionId,
    runId: ocr.runId,
    records: approvedEcRecordsFromStub(STUB_RECORDS),
    childWorkflow: "emergency-contact",
  });
  assert.equal(children.length, 3, "approve fan-out enqueues exactly 3 emergency-contact children");
  const [c1, c2, c3] = children;

  // The approve route's deterministic itemId shape: `ocr-ec-${ocrRunId}-r${index}`.
  for (let i = 0; i < children.length; i++) {
    assert.equal(
      children[i]!.itemId,
      `ocr-ec-${ocr.runId}-r${i}`,
      `child ${i} itemId follows the EC approveTo.deriveItemId shape`,
    );
  }

  // 4. All 3 children reached the held `transaction` stage.
  await rt.waitForEvent("step:start", { step: "transaction", count: 3 });

  // 5. The OCR run completed (its subscribeToApproval woke on emitApproved).
  await rt.waitForEvent("run:terminal", { runId: ocr.runId, occasion: "completed" });

  // 6. Cancel child2 via the REAL control-layer cancel path.
  await rt.cancel(c2!.runId);
  await waitForQueue("emergency-contact", rt.trackerDir, (st) =>
    st.failed.some((i) => i.runId === c2!.runId),
  );
  await rt.waitForEvent("run:terminal", { runId: c2!.runId, occasion: "cancelled" });

  // Siblings still held — NOT terminal.
  const midState = await readQueueStateIncludingTerminals("emergency-contact", rt.trackerDir);
  assert.equal(
    midState.done.some((i) => i.runId === c1!.runId || i.runId === c3!.runId),
    false,
    "siblings must NOT be done while still held",
  );
  assert.equal(
    midState.failed.some((i) => i.runId === c1!.runId || i.runId === c3!.runId),
    false,
    "siblings must NOT be failed by the cancel of child2",
  );

  // 7. Release child1 + child3 → both reach done.
  rt.release(c1!.runId, "transaction");
  rt.release(c3!.runId, "transaction");
  await rt.waitForEvent("run:terminal", { runId: c1!.runId, occasion: "completed" });
  await rt.waitForEvent("run:terminal", { runId: c3!.runId, occasion: "completed" });
  await waitForQueue("emergency-contact", rt.trackerDir, (st) =>
    [c1!.runId, c3!.runId].every((id) => st.done.some((i) => i.runId === id)),
  );

  // ─── Dashboard projection asserts (the invariant checklist) ───────────────
  const dash = rt.dashboard();

  // children() finds exactly the 3 EC runs under the OCR parent.
  const kids = await rt.children(PARENT_RUN);
  const ecKids = kids.filter((k) => k.workflow === "emergency-contact");
  assert.equal(ecKids.length, 3, "exactly 3 emergency-contact children under the OCR run");
  assert.deepEqual(
    new Set(ecKids.map((k) => k.runId)),
    new Set([c1!.runId, c2!.runId, c3!.runId]),
    "children() returns the 3 enqueued EC runs",
  );

  // Parent OCR row archetype is `preview`; the file kind → PDF filename title +
  // trace-id subtitle; `__traceId` uses the EC form spec's `ec-` trace code.
  const ocrRow = dash.row("ocr", ocr.runId);
  assert.equal(ocrRow.archetype, "preview", "OCR parent row archetype is preview");
  assert.equal(ocrRow.title, "emergency-contacts.pdf", "OCR (file kind) title is the PDF filename");
  assert.equal(ocrRow.subtitle, "<traceId>", "OCR (file kind) subtitle is the trace id");
  assert.equal(ocrRow.data.queueRowKind, "file", "OCR row is file-kind (pdf input)");
  assert.equal(ocrRow.data.__traceId, "<traceId>", "OCR row carries a (scrubbed) trace id");
  assert.equal(ocrRow.status, "done", "OCR row is terminal done after approval");
  // With NO operation intent this run brands the OCR default `oc-` (E2E-007:
  // the spec-level `ec` code was removed — only a real emergency-contact
  // OPERATION derives `ec` via operationTraceCode, so standalone preps never
  // grep-collide with operations).
  const rawOcrTraceId = dash.timeline("ocr", ocr.runId).at(-1)?.data?.__traceId;
  assert.match(
    String(rawOcrTraceId),
    /^oc-\d{6}-[a-z0-9]{4}$/,
    "OCR root (no operation intent) brands the default `oc-` code",
  );

  // Every EC child: batch-member archetype, parentRunId === the delegating run, person
  // title (resolved employee name), EID subtitle (name→person, flat-row footer).
  const byEid: Record<string, { name: string }> = {
    "10000001": { name: "Jane Doe" },
    "10000002": { name: "Richard Roe" },
    "10000003": { name: "Sam Stone" },
  };
  for (const c of [c1!, c2!, c3!]) {
    const row = dash.row("emergency-contact", c.runId);
    assert.equal(row.parentRunId, PARENT_RUN, `EC child ${c.itemId} parentRunId === the delegating run`);
    assert.equal(row.archetype, "operation-member", `EC child ${c.itemId} is a batch-member`);
    const emplId = row.data.emplId;
    assert.ok(emplId && byEid[emplId], `EC child ${c.itemId} carries a known EID (got ${emplId})`);
    // Title-by-kind: person → resolved employee name.
    assert.equal(row.title, byEid[emplId!]!.name, `EC child ${c.itemId} title is the resolved name`);
    // Subtitle rule: person row with an EID → the EID (NOT scrubbed — real EID).
    assert.equal(row.subtitle, emplId, `EC child ${c.itemId} subtitle is the EID`);
    // Trace-id prefix propagation: child shares the OCR root's `ec-<HHMMSS>` prefix.
    assert.equal(row.data.__traceId, "<traceId>", `EC child ${c.itemId} carries a (scrubbed) trace id`);
    // Child trace id keeps the ROOT's `oc-` prefix (root trace-id propagation).
    const childTraceId = dash.timeline("emergency-contact", c.runId).at(-1)?.data?.__traceId;
    assert.match(
      String(childTraceId),
      /^oc-\d{6}-[a-z0-9]{4}$/,
      `EC child ${c.itemId} trace id shares the OCR root's oc- prefix`,
    );
  }

  // Statuses: child2 cancelled; child1/child3 done.
  assert.equal(dash.row("emergency-contact", c2!.runId).statusLabel, "Cancelled");
  assert.equal(dash.row("emergency-contact", c2!.runId).status, "failed");
  assert.equal(dash.row("emergency-contact", c2!.runId).step, "cancelled");
  assert.equal(dash.row("emergency-contact", c1!.runId).statusLabel, "Done");
  assert.equal(dash.row("emergency-contact", c3!.runId).statusLabel, "Done");

  // Surface / grouping: the emergency-contact group anchor over the 3 members.
  // EC uses the DEFAULT delegation policy (no `alwaysOperationDelegatedMembers`),
  // but 3 delegated members under one parentRunId still form a batch surface
  // (the count-≥2 path in buildTrackerQueueSurfaces). Subtitle = trace id (the
  // anchor path uses preferTraceIdSubtitle).
  const anchor = dash.groupAnchor("emergency-contact", PARENT_RUN);
  assert.equal(anchor.memberCount, 3, "emergency-contact group anchor has 3 members");
  assert.equal(anchor.kind, "operation", "delegated EC members render as an operation surface");
  assert.equal(anchor.subtitle, "<traceId>", "group anchor subtitle is the trace id");

  // No count drift: exactly 3 distinct EC child runs surfaced (no orphan/double).
  assert.equal(new Set(ecKids.map((k) => k.runId)).size, 3, "no duplicate EC child runs in projection");

  // The records come from the stub override regardless of which PDF renders
  // (registerOcrPdf falls back to a synthetic one-pager when the real fixture
  // can't render headlessly — e.g. CI's headless environment). usedFixture is
  // therefore environment-dependent and NOT asserted; every projection above
  // holds identically for the synthetic fallback.

  await rt.cleanup();

  // The real `.tracker/` is untouched; the temp dir is gone.
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
  assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
});
