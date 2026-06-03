import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  rawOathRecordFromStub,
  approvedOathRecordsFromStub,
  type GatedWorkflowSpec,
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

/**
 * The gated `oath-signature` stub — mirrors the REAL config so the dashboard
 * projection matches production: `inputSubject:"eid"` (→ person kind),
 * `code:"os"`, `archetype:"single"`, the real runtime policy (which sets
 * `delegation.alwaysBatchDelegatedMembers:true` so even one delegated signer
 * renders as a batch surface), and `initialData`/`getId`/`operatorSubject` that
 * stamp `emplId` so the person-kind footer subtitle resolves to the EID. Gated
 * at `transaction` (after `ucpath-auth`), exactly where a real signer parks
 * before its UCPath write — the stage we hold/cancel/release.
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

/**
 * P2.9 "star" test — OCR → oath-signature `approveTo` fan-out through the REAL
 * daemon (no browser, temp tracker root, no `.tracker/` pollution).
 *
 * Flow: stub OCR run (real `runOcrOrchestrator`, stubbed LLM/roster/eid-lookup)
 * → `ocr:awaiting-approval` → REAL `buildOcrApproveHandler` fan-out → 3 gated
 * oath-signature signer children → cancel one mid-hold → release siblings →
 * assert the dashboard projection invariant checklist.
 */
test("OCR → oath-signature approveTo fan-out: projection correct under hold/cancel/release", async (t) => {
  const before = snapshotRealTracker();

  const rt = await createDelegationRuntime({
    // 3 racing oath-signature daemon instances so all 3 signer children can
    // hold `transaction` concurrently (a single daemon's claim loop is serial).
    workflows: [{ workflow: oathSignatureStub, instances: 3 }],
    ocr: { formType: "oath" },
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  // 1. Seed synthetic records + hold every signer at `transaction` BEFORE approval.
  rt.stubOcr(STUB_RECORDS.map(rawOathRecordFromStub));
  rt.holdAll("oath-signature", "transaction");

  // 2. Enqueue the OCR run (registers the fixture PDF) + wait for the prep gate.
  const ocr = await rt.enqueueOcr({ fixturePath: FIXTURE_PDF, originalName: "multiple-oath.pdf" });
  await rt.waitForEvent("ocr:awaiting-approval", { runId: ocr.runId });

  // 3. Drive the REAL approve fan-out → 3 oath-signature signer children, each a
  // controllable daemon run under the OCR run (childParentRunId = ocrRunId).
  const children = await rt.approveOcr({
    sessionId: ocr.sessionId,
    runId: ocr.runId,
    records: approvedOathRecordsFromStub(STUB_RECORDS),
    childWorkflow: "oath-signature",
  });
  assert.equal(children.length, 3, "approve fan-out enqueues exactly 3 signer children");
  const [c1, c2, c3] = children;

  // 4. All 3 signer children reached the held `transaction` stage.
  await rt.waitForEvent("step:start", { step: "transaction", count: 3 });

  // 5. The OCR run completed (its subscribeToApproval woke on emitApproved).
  await rt.waitForEvent("run:terminal", { runId: ocr.runId, occasion: "completed" });

  // 6. Cancel child2 via the REAL control-layer cancel path.
  await rt.cancel(c2!.runId);
  await waitForQueue("oath-signature", rt.trackerDir, (st) =>
    st.failed.some((i) => i.runId === c2!.runId),
  );
  await rt.waitForEvent("run:terminal", { runId: c2!.runId, occasion: "cancelled" });

  // Siblings still held — NOT terminal.
  const midState = await readQueueStateIncludingTerminals("oath-signature", rt.trackerDir);
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
  await waitForQueue("oath-signature", rt.trackerDir, (st) =>
    [c1!.runId, c3!.runId].every((id) => st.done.some((i) => i.runId === id)),
  );

  // ─── Dashboard projection asserts (the invariant checklist) ───────────────
  const dash = rt.dashboard();

  // children() finds exactly the 3 signer runs under the OCR parent.
  const kids = await rt.children(ocr.runId);
  const sigKids = kids.filter((k) => k.workflow === "oath-signature");
  assert.equal(sigKids.length, 3, "exactly 3 oath-signature children under the OCR run");
  assert.deepEqual(
    new Set(sigKids.map((k) => k.runId)),
    new Set([c1!.runId, c2!.runId, c3!.runId]),
    "children() returns the 3 enqueued signer runs",
  );

  // Parent OCR row archetype is `preview`; the file kind → PDF filename title +
  // trace-id subtitle; `__traceId` is oath-branded `ou-…`.
  const ocrRow = dash.row("ocr", ocr.runId);
  assert.equal(ocrRow.archetype, "preview", "OCR parent row archetype is preview");
  assert.equal(ocrRow.title, "multiple-oath.pdf", "OCR (file kind) title is the PDF filename");
  assert.equal(ocrRow.subtitle, "<traceId>", "OCR (file kind) subtitle is the trace id");
  assert.equal(ocrRow.data.queueRowKind, "file", "OCR row is file-kind (pdf input)");
  assert.equal(ocrRow.data.__traceId, "<traceId>", "OCR row carries a (scrubbed) trace id");
  assert.equal(ocrRow.status, "done", "OCR row is terminal done after approval");

  // Every signer child: batch-member archetype, parentRunId === ocrRunId,
  // person title (resolved name), EID subtitle (eid→person, flat-row footer).
  const byEid: Record<string, { name: string }> = {
    "10000001": { name: "Jane Doe" },
    "10000002": { name: "Richard Roe" },
    "10000003": { name: "Sam Stone" },
  };
  for (const c of [c1!, c2!, c3!]) {
    const row = dash.row("oath-signature", c.runId);
    assert.equal(row.parentRunId, ocr.runId, `signer ${c.itemId} parentRunId === OCR runId`);
    assert.equal(row.archetype, "batch-member", `signer ${c.itemId} is a batch-member`);
    const emplId = row.data.emplId;
    assert.ok(emplId && byEid[emplId], `signer ${c.itemId} carries a known EID (got ${emplId})`);
    // Title-by-kind: person → resolved name.
    assert.equal(row.title, byEid[emplId!]!.name, `signer ${c.itemId} title is the resolved name`);
    // Subtitle rule: person row with an EID → the EID (NOT scrubbed — real EID).
    assert.equal(row.subtitle, emplId, `signer ${c.itemId} subtitle is the EID`);
    // Trace-id prefix propagation: child shares the OCR root's `ou-<HHMMSS>` prefix.
    assert.equal(row.data.__traceId, "<traceId>", `signer ${c.itemId} carries a (scrubbed) trace id`);
  }

  // Statuses: child2 cancelled; child1/child3 done.
  assert.equal(dash.row("oath-signature", c2!.runId).statusLabel, "Cancelled");
  assert.equal(dash.row("oath-signature", c2!.runId).status, "failed");
  assert.equal(dash.row("oath-signature", c2!.runId).step, "cancelled");
  assert.equal(dash.row("oath-signature", c1!.runId).statusLabel, "Done");
  assert.equal(dash.row("oath-signature", c3!.runId).statusLabel, "Done");

  // Surface / grouping: the oath-signature group anchor over the 3 signer
  // members (alwaysBatchDelegatedMembers → batch surface even for delegated
  // members), subtitle = trace id (anchor uses preferTraceIdSubtitle).
  const anchor = dash.groupAnchor("oath-signature", ocr.runId);
  assert.equal(anchor.memberCount, 3, "oath-signature group anchor has 3 members");
  assert.equal(anchor.kind, "batch", "delegated signer members render as a batch surface");
  assert.equal(anchor.subtitle, "<traceId>", "group anchor subtitle is the trace id");

  // No count drift: exactly 3 distinct signer runs surfaced (no orphan/double).
  assert.equal(new Set(sigKids.map((k) => k.runId)).size, 3, "no duplicate signer runs in projection");

  await rt.cleanup();

  // The real `.tracker/` is untouched; the temp dir is gone.
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
  assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
});
