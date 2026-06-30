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
import { OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY } from "../../src/workflows/oath-upload/workflow.js";

const REAL_TRACKER_DIR = ".tracker";
const FIXTURE_PDF = "tests/data/single-oath.pdf";
const PDF_NAME = "single-oath.pdf";

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
 * The gated `oath-signature` stub — mirrors the REAL config so the signer
 * projection matches production (`inputSubject:"eid"` → person kind, `code:"os"`,
 * `archetype:"single"`, the real `alwaysOperationDelegatedMembers` policy so even a
 * lone delegated signer renders as a 1-member batch surface). Same stub P2.9
 * uses. Gated at `transaction` so we can hold/cancel/release the signer row.
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

/**
 * The gated `oath-upload` stub — mirrors the REAL oath-upload config so the
 * once-per-document ticket row's projection matches production:
 * `inputSubject:"pdf"` (→ FILE kind → title = PDF filename, subtitle = trace id),
 * `code:"ou"`, `archetype:"single"`, the real
 * `OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY`. The ticket input is the `OathUploadInput`
 * the oath form's `approveDocumentTo.deriveInput` produces (`pdfFileId`,
 * `pdfOriginalName`, `signerItemIds`, `mode:"full"`, `rosterMode:"download"`), so
 * `getName`/`initialData` surface `pdfOriginalName` (file-kind title) and `getId`
 * the `sessionId`. Gated at `wait-signatures` (the real first step, where the
 * ticket parks waiting on the signer rows) so we can hold/cancel/release it.
 *
 * This is the PROJECTION of the doc fan-out — NOT the real ticket-filing logic.
 * That stays covered by the kept `oath-upload-smoke`/`oath-upload-extended`
 * integration tests (a gated stub files no ServiceNow ticket).
 */
const oathUploadStub: GatedWorkflowSpec = {
  name: "oath-upload",
  label: "Oath Upload",
  code: "ou",
  stages: ["wait-signatures", "submit"],
  gatedStages: ["wait-signatures"],
  archetype: "single",
  inputSubject: "pdf",
  runtimePolicy: OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY,
  initialData: (input) => {
    const r = input as Record<string, unknown>;
    return {
      pdfOriginalName: typeof r.pdfOriginalName === "string" ? r.pdfOriginalName : "",
      ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
      ...(Array.isArray(r.signerItemIds)
        ? { signerItemIds: JSON.stringify(r.signerItemIds) }
        : {}),
    };
  },
  getId: (d) => d.sessionId ?? "",
  getName: (d) => d.pdfOriginalName ?? "",
  deriveItemId: (input) => input.id,
  operatorSubject: (input) => {
    const r = input as Record<string, unknown>;
    return {
      kind: "pdf",
      label: typeof r.pdfOriginalName === "string" ? r.pdfOriginalName : input.id,
    };
  },
};

/**
 * A SINGLE PII-FREE synthetic oath record: a fake name + a fake UCPath-shaped
 * (10######) EID. `single-oath.pdf` → 1 signer record → 1 oath-signature signer
 * row + 1 oath-upload ticket row.
 */
const STUB_RECORDS: StubOcrRecord[] = [
  {
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Jane Doe",
    employeeId: "10000001",
    employeeSigned: true,
    dateSigned: "05/01/2026",
  },
];

/**
 * P2.12 — OCR (oath form) → oath-upload `approveDocumentTo` ONCE-PER-DOCUMENT
 * fan-out through the REAL daemon (no browser, temp tracker root, no `.tracker/`
 * pollution). The LAST Phase-2 delegation test.
 *
 * Approving an oath OCR run fans out to TWO different daemons:
 *  - `approveTo` (per-record) → 1 oath-signature signer row
 *    (itemId `ocr-oath-${ocrRunId}-r0`). Covered fully by P2.9; asserted here too.
 *  - `approveDocumentTo` (once-per-document) → 1 oath-upload TICKET row
 *    (itemId `ocr-oath-upload-${ocrRunId}`), whose input carries `signerItemIds`
 *    = the signer itemIds actually enqueued, `pdfFileId`, `pdfOriginalName`,
 *    `mode:"full"`, `rosterMode:"download"`. THE CORE P2.12 ASSERTION.
 *
 * Both children parent under the OCR run and share the `ou-` trace prefix. This
 * test asserts the DASHBOARD PROJECTION of that doc fan-out (the ticket row + its
 * coexistence with the signer row under the OCR card), plus a cancel-at-stage
 * invariant — NOT the real ticket-filing logic.
 */
test(
  "OCR → oath-upload approveDocumentTo once-per-document fan-out: projection correct",
  async (t) => {
    const before = snapshotRealTracker();

    const rt = await createDelegationRuntime({
      // BOTH fan-out targets get a gated daemon (1 signer + 1 ticket → 1 instance
      // each is enough; they're DIFFERENT workflows). A short idle window: the
      // doc fan-out goes through the real route, whose `ensureDaemonsAndEnqueue`
      // wakes the daemon BEFORE committing the SQLite task, so the first wake can
      // miss; the keepalive re-poll then claims promptly (the P2.11 gotcha).
      workflows: [oathSignatureStub, oathUploadStub],
      ocr: { formType: "oath" },
      idleTimeoutMs: 1_000,
    });
    t.onTestFinished(() => rt.cleanup());

    // 1. Seed the single synthetic record + hold BOTH children at their gated
    //    stages BEFORE approval (signer at `transaction`, ticket at
    //    `wait-signatures`) so we can assert the held projection then cancel.
    rt.stubOcr(STUB_RECORDS.map(rawOathRecordFromStub));
    rt.holdAll("oath-signature", "transaction");
    rt.holdAll("oath-upload", "wait-signatures");

    // 2. Enqueue the OCR run DELEGATED (registers the fixture PDF) + wait for
    // the awaiting-approval park. Approve REQUIRES a delegated run since
    // 2026-06-11 (standalone approve is rejected 400 — approval ≡ delegation).
    // No operationWorkflow is stamped, so the spec's `approveDocumentTo`
    // branch (the P2.12 subject) still fires on approve.
    const PARENT_RUN = "op-parent-star-oathup";
    const ocr = await rt.enqueueOcr({
      fixturePath: FIXTURE_PDF,
      originalName: PDF_NAME,
      parentRunId: PARENT_RUN,
    });
    // The records come from the stub override regardless of which PDF renders
    // (registerOcrPdf falls back to a synthetic one-pager when the real fixture
    // can't render headlessly — e.g. CI's headless environment). usedFixture is
    // therefore environment-dependent and NOT asserted; every projection below
    // holds identically for the synthetic fallback.
    await rt.waitForEvent("ocr:awaiting-approval", { runId: ocr.runId });

    // 3. Drive the REAL approve fan-out onto BOTH gated daemons via the new
    //    MULTI-TARGET `childWorkflows`. The real route fans out the per-record
    //    signer (approveTo) AND the once-per-document ticket (approveDocumentTo);
    //    both are claimed as controllable child runs under the OCR run.
    const children = await rt.approveOcr({
      sessionId: ocr.sessionId,
      runId: ocr.runId,
      records: approvedOathRecordsFromStub(STUB_RECORDS),
      childWorkflows: ["oath-signature", "oath-upload"],
    });
    const signerChildren = children.filter((c) => c.workflow === "oath-signature");
    const ticketChildren = children.filter((c) => c.workflow === "oath-upload");
    assert.equal(signerChildren.length, 1, "approve fan-out enqueues exactly 1 signer child");
    assert.equal(ticketChildren.length, 1, "approve fan-out enqueues exactly 1 ticket child");
    const signer = signerChildren[0]!;
    const ticket = ticketChildren[0]!;

    // Deterministic itemId schemes (the core identity assertions):
    //   signer → ocr-oath-${ocrRunId}-r0
    //   ticket → ocr-oath-upload-${ocrRunId}
    assert.equal(
      signer.itemId,
      `ocr-oath-${ocr.runId}-r0`,
      "signer itemId follows oath approveTo.deriveItemId",
    );
    assert.equal(
      ticket.itemId,
      `ocr-oath-upload-${ocr.runId}`,
      "ticket itemId follows oath approveDocumentTo.deriveItemId",
    );

    // 4. Both children reached their held gated stages (proves both daemons
    //    claimed their committed tasks — the doc fan-out + per-record fan-out
    //    both landed).
    await rt.waitForEvent("step:start", { step: "transaction", count: 1 });
    await rt.waitForEvent("step:start", { step: "wait-signatures", count: 1 });

    // 5. The OCR run completed (its subscribeToApproval woke on emitApproved).
    await rt.waitForEvent("run:terminal", { runId: ocr.runId, occasion: "completed" });

    // ─── Core projection asserts BEFORE any cancel (both rows held) ───────────
    const dash = rt.dashboard();

    // children() finds the approve fan-out under the OCR parent. The OCR
    // orchestrator's eid-lookup pipeline also nests a synthetic `person-lookup`
    // outcome row under the run (harness noise, same as P2.9/P2.10) — scope the
    // doc-fan-out assertions to the two approve targets.
    const kids = await rt.children(PARENT_RUN);
    const signerKids = kids.filter((k) => k.workflow === "oath-signature");
    const ticketKids = kids.filter((k) => k.workflow === "oath-upload");
    assert.equal(signerKids.length, 1, "exactly 1 oath-signature signer child under the OCR run");
    assert.equal(ticketKids.length, 1, "exactly 1 oath-upload ticket child under the OCR run");
    assert.equal(
      new Set([...signerKids, ...ticketKids].map((k) => k.runId)).size,
      2,
      "signer + ticket are 2 distinct runs (no orphan/double-count)",
    );
    assert.equal(signerKids[0]!.runId, signer.runId, "children() returns the enqueued signer run");
    assert.equal(ticketKids[0]!.runId, ticket.runId, "children() returns the enqueued ticket run");

    // ── Parent OCR row: preview, file-kind title (PDF filename), trace-id
    //    subtitle, `ou-…` trace, terminal done after approve. ──
    const ocrRow = dash.row("ocr", ocr.runId);
    assert.equal(ocrRow.archetype, "preview", "OCR parent row archetype is preview");
    assert.equal(ocrRow.title, PDF_NAME, "OCR (file kind) title is the PDF filename");
    assert.equal(ocrRow.subtitle, "<traceId>", "OCR (file kind) subtitle is the trace id");
    assert.equal(ocrRow.data.queueRowKind, "file", "OCR row is file-kind (pdf input)");
    assert.equal(ocrRow.data.__traceId, "<traceId>", "OCR row carries a (scrubbed) trace id");
    assert.equal(ocrRow.status, "done", "OCR row is terminal done after approval");

    // ── oath-signature signer row (1): real archetype is a batch-member
    //    (alwaysOperationDelegatedMembers → a lone delegated signer renders as a
    //    1-member batch surface), parentRunId === ocrRunId, person/eid
    //    title+subtitle, `ou-` prefix. ──
    const signerRow = dash.row("oath-signature", signer.runId);
    assert.equal(signerRow.parentRunId, PARENT_RUN, "signer parentRunId === the delegating run");
    assert.equal(signerRow.archetype, "operation-member", "signer row is a batch-member");
    assert.equal(signerRow.data.emplId, "10000001", "signer carries the synthetic EID");
    assert.equal(signerRow.title, "Jane Doe", "signer title is the resolved name");
    assert.equal(signerRow.subtitle, "10000001", "signer subtitle is the EID");
    assert.equal(signerRow.data.__traceId, "<traceId>", "signer carries a (scrubbed) trace id");

    // ── oath-upload TICKET row (1) — THE CORE P2.12 ASSERTION: file-kind
    //    (title = PDF filename, subtitle = trace id), parentRunId === ocrRunId,
    //    `ou-` prefix, deterministic itemId, and its input carries
    //    signerItemIds = [the signer itemId]. ──
    const ticketRow = dash.row("oath-upload", ticket.runId);
    assert.equal(ticketRow.parentRunId, PARENT_RUN, "ticket parentRunId === the delegating run");
    assert.equal(ticketRow.data.queueRowKind, "file", "ticket row is file-kind (pdf input)");
    assert.equal(ticketRow.title, PDF_NAME, "ticket (file kind) title is the PDF filename");
    assert.equal(ticketRow.subtitle, "<traceId>", "ticket (file kind) subtitle is the trace id");
    assert.equal(ticketRow.data.__traceId, "<traceId>", "ticket carries a (scrubbed) trace id");
    // The doc fan-out hands the ticket the signer itemIds it must wait on.
    assert.deepEqual(
      JSON.parse(ticketRow.data.signerItemIds ?? "[]"),
      [signer.itemId],
      "ticket input carries signerItemIds = [the signer itemId]",
    );

    // ── Trace-id propagation: OCR root + signer + ticket all share the
    //    root's `oc-<HHMMSS>` prefix. With NO operation intent (this test
    //    seeds no operationWorkflow) the root brands the OCR default `oc-`
    //    (E2E-007: spec-level ou/ec codes were removed — operation codes come
    //    only from operationTraceCode); descendants still compose the root's
    //    prefix with their own runId4 tails. ──
    const ocrTraceId = String(dash.timeline("ocr", ocr.runId).at(-1)?.data?.__traceId ?? "");
    const signerTraceId = String(
      dash.timeline("oath-signature", signer.runId).at(-1)?.data?.__traceId ?? "",
    );
    const ticketTraceId = String(
      dash.timeline("oath-upload", ticket.runId).at(-1)?.data?.__traceId ?? "",
    );
    const ocPrefix = /^oc-\d{6}-[a-z0-9]{4}$/;
    assert.match(ocrTraceId, ocPrefix, "OCR root (no operation intent) brands the default `oc-` code");
    assert.match(signerTraceId, ocPrefix, "signer trace id shares the root's `oc-` prefix");
    assert.match(ticketTraceId, ocPrefix, "ticket trace id shares the root's `oc-` prefix");
    const sharedPrefix = ocrTraceId.slice(0, "oc-HHMMSS".length);
    assert.ok(
      signerTraceId.startsWith(sharedPrefix) && ticketTraceId.startsWith(sharedPrefix),
      `signer + ticket share the OCR root's oc-<HHMMSS> prefix (${sharedPrefix})`,
    );

    // ── Surface/grouping: both children project sensibly under the OCR card.
    //    The signer is a lone delegated member → a 1-member operation anchor.
    const signerAnchor = dash.groupAnchor("oath-signature", PARENT_RUN);
    assert.equal(signerAnchor.memberCount, 1, "oath-signature anchor has 1 signer member");
    assert.equal(
      signerAnchor.kind,
      "operation",
      "a lone delegated signer renders as an operation surface (alwaysOperationDelegatedMembers)",
    );
    assert.equal(signerAnchor.subtitle, "<traceId>", "signer anchor subtitle is the trace id");

    // ─── Cancel-at-stage → terminal (the held ticket; signer unaffected) ──────
    // Cancel the held oath-upload TICKET via the REAL control-layer cancel path.
    await rt.cancel(ticket.runId);
    await waitForQueue("oath-upload", rt.trackerDir, (st) =>
      st.failed.some((i) => i.runId === ticket.runId),
    );
    await rt.waitForEvent("run:terminal", { runId: ticket.runId, occasion: "cancelled" });

    // Cancelled ticket row: failed + Cancelled + step cancelled; never stuck.
    const cancelledTicket = rt.dashboard().row("oath-upload", ticket.runId);
    assert.equal(cancelledTicket.status, "failed", "cancelled ticket is status failed");
    assert.equal(cancelledTicket.statusLabel, "Cancelled", "cancelled ticket shows the Cancelled label");
    assert.equal(cancelledTicket.step, "cancelled", "cancelled ticket step is cancelled");

    // The OTHER child (signer) is UNAFFECTED — still held, NOT terminal.
    const signerMid = await readQueueStateIncludingTerminals("oath-signature", rt.trackerDir);
    assert.equal(
      signerMid.done.some((i) => i.runId === signer.runId),
      false,
      "signer must NOT be done while still held",
    );
    assert.equal(
      signerMid.failed.some((i) => i.runId === signer.runId),
      false,
      "signer must NOT be failed by the cancel of the ticket",
    );

    // Release the signer → it reaches done (proving the cancel was isolated).
    rt.release(signer.runId, "transaction");
    await rt.waitForEvent("run:terminal", { runId: signer.runId, occasion: "completed" });
    await waitForQueue("oath-signature", rt.trackerDir, (st) =>
      st.done.some((i) => i.runId === signer.runId),
    );
    assert.equal(
      rt.dashboard().row("oath-signature", signer.runId).statusLabel,
      "Done",
      "released signer reaches Done after the ticket cancel",
    );

    await rt.cleanup();

    // The real `.tracker/` is untouched; the temp dir is gone.
    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
    assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
  },
);
