import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  readQueueStateIncludingTerminals,
  rawOathRecordFromStub,
  approvedOathRecordsFromStub,
  prepareOathUploadFull,
  buildGatedOathUploadStub,
  STUB_TICKET_NUMBER,
  type GatedWorkflowSpec,
  type RowSnapshot,
  type StubOcrRecord,
} from "./_runtime/index.js";
import { OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY } from "../../src/workflows/oath-signature/workflow.js";

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
 * Poll the REAL row projection until `pred` holds. Used to sync on the
 * IN-PROCESS OCR prep row (it has no SQLite queue task and emits no
 * `run:terminal` event), and on any row whose terminal state is written outside
 * a daemon's structured-log path.
 */
async function waitForRow(
  dash: { row: (w: string, r: string) => RowSnapshot },
  workflow: string,
  runId: string,
  pred: (row: RowSnapshot) => boolean,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = dash.row(workflow, runId);
    if (pred(row)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForRow(${workflow}/${runId}) timed out: ${JSON.stringify(row)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The gated `oath-signature` stub — mirrors the REAL config so the signer
 * projection matches production (`inputSubject:"eid"` → person kind, `code:"os"`,
 * `archetype:"single"`, the real `alwaysBatchDelegatedMembers` policy so even a
 * lone delegated signer renders as a 1-member batch surface). Same stub
 * `ocr-oath-upload.test.ts` (P2.12) uses. Gated at `transaction` so the test can
 * hold the signer row, then release it to `done` so the ticket's `wait-signatures`
 * sees a satisfied signer set.
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
 * A SINGLE PII-FREE synthetic oath record: a fake name + a fake UCPath-shaped
 * (10######) EID. `single-oath.pdf` → 1 signer record → 1 oath-signature signer
 * row that the born-at-upload ticket waits on.
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
 * The born-at-upload FULL-RUN lifecycle for **oath-upload**, driven from the
 * run-modal seam through the REAL daemon (no browser, temp tracker, no `.tracker/`
 * pollution).
 *
 * THIS IS STRUCTURALLY DIFFERENT from the operation-coordinator tests
 * (`ocr-oath-signature-operation` / `ocr-emergency-contact-operation`) and from
 * the P2.12 doc-fan-out test (`ocr-oath-upload`). oath-upload is NOT an operation
 * coordinator and the ticket is NOT born from the `approveDocumentTo` fan-out:
 *
 *  - A run-modal "full" upload (`targetWorkflow:"oath-upload"`) creates the
 *    oath-upload `single` TICKET task at `/api/ocr/prepare` (born at upload,
 *    option A), and DELEGATES the OCR prep UNDER the ticket (`parentRunId =
 *    ticketRunId`, the ticket is the ROOT). The OCR review composes the ticket's
 *    `ou-<HHMMSS>` trace PREFIX.
 *  - The ONE ticket row walks `wait-approval → wait-signatures → … → submit` as a
 *    SINGLE row (not a fan-out). On approve it learns its signer set from the
 *    OCR row's `fannedOutItemIds` (cross-process `subscribeToApproval`), waits on
 *    the signer rows, then files its OWN ServiceNow ticket — so the once-per-
 *    document `approveDocumentTo` ticket fan-out is SUPPRESSED (no spurious
 *    second ticket row).
 *
 * This is the gap NOT covered by P2.12 (which asserts the `approveDocumentTo`
 * ticket-row PROJECTION) nor by the `oath-upload-smoke`/`-extended` integration
 * tests (which assert the real handler / ticket-filing logic via escape hatches,
 * not the born-at-upload run-modal projection through the real daemon). The value
 * here is the SINGLE ticket row's projection "looking good" at EVERY step.
 */
test(
  "oath-upload born-at-upload full-run lifecycle: single ticket row stays correct at every step",
  async (t) => {
    const before = snapshotRealTracker();

    const ou = buildGatedOathUploadStub();
    const rt = await createDelegationRuntime({
      // The gated oath-upload TICKET daemon + the gated oath-signature SIGNER
      // daemon. A short idle window: the OCR run is delegated under the ticket and
      // the signer fan-out goes through the real approve route, whose
      // `ensureDaemonsAndEnqueue` wakes the daemon BEFORE committing the SQLite
      // task, so the first wake can miss; the keepalive re-poll then claims.
      workflows: [{ workflow: ou.workflow }, oathSignatureStub],
      ocr: { formType: "oath" },
      idleTimeoutMs: 1_000,
    });
    t.onTestFinished(() => rt.cleanup());

    // 1. Seed the single synthetic record + hold the signer at `transaction` and
    //    the ticket at `wait-signatures` BEFORE anything starts, so we can assert
    //    the held projections then drive each step deterministically.
    rt.stubOcr(STUB_RECORDS.map(rawOathRecordFromStub));
    rt.holdAll("oath-signature", "transaction");
    ou.holdWaitSignatures();

    // 2. Drive the REAL born-at-upload run-modal seam: create the ticket task +
    //    delegate the OCR prep under it. The gated ticket daemon claims the task
    //    and parks at `wait-approval`; the OCR orchestrator runs to its
    //    awaiting-approval park.
    const { ticketRunId, ticketItemId, ocrRunId, ocrSessionId } = await prepareOathUploadFull(rt, {
      fixturePath: FIXTURE_PDF,
      originalName: PDF_NAME,
      seededRecords: STUB_RECORDS.map(rawOathRecordFromStub),
    });
    await rt.waitForEvent("step:start", { step: "wait-approval", runId: ticketRunId });
    await rt.waitForEvent("ocr:awaiting-approval", { runId: ocrRunId });

    const dash = rt.dashboard();

    // ─── STEP: born (run-modal) + OCR prep delegated + awaiting approval ───────
    // The SINGLE ticket row: archetype single, kind file, ROOT (parentRunId
    // null), title = PDF filename, subtitle = trace id, `ou-` prefix.
    {
      const ticketRow = dash.row("oath-upload", ticketRunId);
      assert.notEqual(ticketRow.status, "missing", "born ticket row exists");
      assert.equal(ticketRow.archetype, "single", "ticket row archetype is single");
      assert.equal(ticketRow.data.queueRowKind, "file", "ticket row is file-kind (pdf input)");
      assert.equal(ticketRow.parentRunId, null, "ticket is the ROOT — no parentRunId");
      assert.equal(ticketRow.title, PDF_NAME, "ticket (file kind) title is the PDF filename");
      assert.equal(ticketRow.subtitle, "<traceId>", "ticket (file kind) subtitle is the trace id");
      assert.equal(ticketRow.data.__traceId, "<traceId>", "ticket carries a (scrubbed) trace id");
      assert.equal(ticketRow.itemId, ticketItemId, "ticket itemId is the session id");
      // The ticket is parked at its leading `wait-approval` step (the
      // born-at-upload signal: the ONE ticket row IS waiting for the OCR prep to
      // be approved — `ocr:awaiting-approval` is live, asserted on the OCR row's
      // needsReview badge below).
      assert.equal(ticketRow.step, "wait-approval", "ticket is parked at wait-approval");
      assert.equal(ticketRow.status, "running", "ticket is running while parked");
      // RAW `ou-` prefix off the timeline (snapshot scrubs to <traceId>).
      const rawTicketTrace = String(
        dash.timeline("oath-upload", ticketRunId).at(-1)?.data?.__traceId ?? "",
      );
      assert.match(rawTicketTrace, /^ou-\d{6}-[a-z0-9]{4}$/, "ticket trace brands `ou-`");

      // OCR prep DELEGATED under the ticket: parentRunId === ticketRunId, projects
      // `preview`, statusLabel `awaiting review` (needsReview), composes the
      // ticket's `ou-<HHMMSS>` prefix.
      const ocrRow = dash.row("ocr", ocrRunId);
      assert.notEqual(ocrRow.status, "missing", "OCR review row exists");
      assert.equal(ocrRow.parentRunId, ticketRunId, "OCR review delegated under the ticket");
      assert.equal(ocrRow.archetype, "preview", "OCR review row projects preview");
      assert.equal(ocrRow.statusLabel, "awaiting review", "parked OCR review shows needsReview badge");
      assert.equal(ocrRow.data.queueRowKind, "file", "OCR review is file-kind (pdf input)");
      assert.equal(ocrRow.title, PDF_NAME, "OCR review (file kind) title is the PDF filename");
      // The OCR prep COMPOSES the ticket's `ou-<HHMMSS>` prefix (VQ-1).
      const rawOcrTrace = String(dash.timeline("ocr", ocrRunId).at(-1)?.data?.__traceId ?? "");
      assert.match(rawOcrTrace, /^ou-\d{6}-[a-z0-9]{4}$/, "OCR review trace brands `ou-`");
      const ticketPrefix = rawTicketTrace.slice(0, "ou-HHMMSS".length);
      assert.ok(
        rawOcrTrace.startsWith(ticketPrefix),
        `OCR review composes the ticket's ${ticketPrefix} prefix (got ${rawOcrTrace})`,
      );

      // The OCR review is the ONE child of the ticket so far — no spurious rows.
      const kids = await rt.children(ticketRunId);
      const ocrKids = kids.filter((k) => k.workflow === "ocr");
      assert.equal(ocrKids.length, 1, "exactly 1 OCR review row under the ticket");
      assert.equal(ocrKids[0]!.runId, ocrRunId, "the OCR child is the delegated OCR run");
    }

    // 3. Operator APPROVES — drive the REAL approve fan-out onto the gated signer
    //    daemon. `operationWorkflow:"oath-upload"` suppresses the once-per-document
    //    `approveDocumentTo` ticket fan-out (the born ticket files it), so this
    //    fans out ONLY the per-record signer. The approve also wakes the ticket's
    //    `wait-approval` (emitApproved + the OCR row's fannedOutItemIds).
    const children = await rt.approveOcr({
      sessionId: ocrSessionId,
      runId: ocrRunId,
      records: approvedOathRecordsFromStub(STUB_RECORDS),
      childWorkflows: ["oath-signature"],
    });
    const signerChildren = children.filter((c) => c.workflow === "oath-signature");
    assert.equal(signerChildren.length, 1, "approve fan-out enqueues exactly 1 signer (not the ticket)");
    const signer = signerChildren[0]!;
    assert.equal(
      signer.itemId,
      `ocr-oath-${ocrRunId}-r0`,
      "signer itemId follows oath approveTo.deriveItemId",
    );

    // Both the signer and the ticket reached their next held stages.
    await rt.waitForEvent("step:start", { step: "transaction", count: 1 });
    await rt.waitForEvent("step:start", { step: "wait-signatures", runId: ticketRunId });
    // The OCR run completed. NOTE: the born-at-upload OCR prep runs IN-PROCESS via
    // the REAL `/api/ocr/prepare` `runOrchestrator` (fire-and-forget in the
    // dashboard process — NOT a daemon, exactly like production), so it has no
    // SQLite queue task and emits NO `run:terminal` log event. Sync on the OCR
    // tracker ROW reaching terminal `done` (the orchestrator writes it directly
    // on approve).
    await waitForRow(dash, "ocr", ocrRunId, (row) => row.status === "done");

    // ─── STEP: wait-signatures (ticket held, waiting on the signer) ───────────
    {
      // NO SPURIOUS TICKET FAN-OUT: the children of the ticket are ONLY the OCR
      // review + the ONE signer — never a second oath-upload ticket row.
      const kids = await rt.children(ticketRunId);
      const ticketKids = kids.filter((k) => k.workflow === "oath-upload");
      assert.equal(
        ticketKids.length,
        0,
        "NO spurious approveDocumentTo ticket fan-out child (a full run files its own ticket)",
      );
      // The full oath-upload run is exactly ONE oath-upload row total — the born
      // ticket itself, never a second.
      const ouQueue = await readQueueStateIncludingTerminals("oath-upload", rt.trackerDir);
      const ouRunIds = new Set(
        [...ouQueue.claimed, ...ouQueue.done, ...ouQueue.failed, ...ouQueue.queued].map((i) => i.runId),
      );
      assert.equal(ouQueue.failed.some((i) => i.runId === ticketRunId), false, "ticket not failed mid-flight");
      assert.deepEqual(
        [...ouRunIds],
        [ticketRunId],
        "exactly ONE oath-upload row exists (the born ticket) — no fan-out twin",
      );

      // The SAME single ticket row walks step→step (still archetype single, kind
      // file, ROOT, pdf title, `ou-` prefix — identity unchanged across steps).
      // The ONE ticket has advanced past wait-approval to wait-signatures — proof
      // it learned its signer set and is now waiting on the signer row (not a
      // fan-out twin).
      const ticketRow = dash.row("oath-upload", ticketRunId);
      assert.equal(ticketRow.archetype, "single", "ticket stays single at wait-signatures");
      assert.equal(ticketRow.parentRunId, null, "ticket stays ROOT at wait-signatures");
      assert.equal(ticketRow.data.queueRowKind, "file", "ticket stays file-kind at wait-signatures");
      assert.equal(ticketRow.title, PDF_NAME, "ticket title stays the PDF filename");
      assert.equal(ticketRow.step, "wait-signatures", "ticket is parked at wait-signatures");
      assert.equal(ticketRow.status, "running", "ticket is running while parked at wait-signatures");

      // The signer (the row the ticket waits on) is held at transaction — same
      // single ticket waits on it, NOT a fan-out twin.
      const signerRow = dash.row("oath-signature", signer.runId);
      assert.equal(signerRow.parentRunId, ticketRunId, "signer parentRunId === the ticket (delegating run)");
      assert.equal(signerRow.archetype, "batch-member", "signer renders as a batch-member");
      assert.equal(signerRow.title, "Jane Doe", "signer title is the resolved name");
      assert.equal(signerRow.subtitle, "10000001", "signer subtitle is the EID");
    }

    // 4. Release the SIGNER → it reaches done → the ticket's wait-signatures sees
    //    a satisfied signer set → release the ticket → it walks submit → done.
    rt.release(signer.runId, "transaction");
    await rt.waitForEvent("run:terminal", { runId: signer.runId, occasion: "completed" });
    await waitForQueue("oath-signature", rt.trackerDir, (st) =>
      st.done.some((i) => i.runId === signer.runId),
    );
    assert.equal(
      dash.row("oath-signature", signer.runId).statusLabel,
      "Done",
      "released signer reaches Done",
    );

    // Release the held ticket → it proceeds past wait-signatures through the
    // (stubbed) ServiceNow legs to submit → terminal done.
    ou.releaseWaitSignatures(ticketRunId);
    await rt.waitForEvent("run:terminal", { runId: ticketRunId, occasion: "completed" });
    await waitForQueue("oath-upload", rt.trackerDir, (st) =>
      st.done.some((i) => i.runId === ticketRunId),
    );

    // ─── STEP: submit / done (terminal) ───────────────────────────────────────
    {
      const ticketRow = dash.row("oath-upload", ticketRunId);
      // The SAME single ticket row reached terminal done — one row, walked the
      // whole lifecycle. Identity STILL intact: single, file, ROOT, pdf title,
      // trace id subtitle, `ou-` prefix.
      assert.equal(ticketRow.status, "done", "ticket reaches terminal done");
      assert.equal(ticketRow.statusLabel, "Done", "ticket shows Done");
      assert.equal(ticketRow.archetype, "single", "terminal ticket stays single");
      assert.equal(ticketRow.parentRunId, null, "terminal ticket stays ROOT");
      assert.equal(ticketRow.data.queueRowKind, "file", "terminal ticket stays file-kind");
      assert.equal(ticketRow.title, PDF_NAME, "terminal ticket title stays the PDF filename");
      assert.equal(ticketRow.subtitle, "<traceId>", "terminal ticket subtitle is the trace id");
      assert.equal(ticketRow.data.__traceId, "<traceId>", "terminal ticket carries the trace id");
      assert.equal(ticketRow.data.ticketNumber, STUB_TICKET_NUMBER, "ticket filed its OWN ServiceNow ticket #");
      assert.equal(ticketRow.data.status, "filed", "ticket denormalizes filed");
      assert.equal(
        ticketRow.data.signerCount,
        "1",
        "ticket waited on the 1 signer it learned from the approval (single row, not a fan-out)",
      );
      const rawTicketTrace = String(
        dash.timeline("oath-upload", ticketRunId).at(-1)?.data?.__traceId ?? "",
      );
      assert.match(rawTicketTrace, /^ou-\d{6}-[a-z0-9]{4}$/, "terminal ticket trace stays `ou-`");

      // The OCR review terminalized (done) when the operator approved.
      const ocrRow = dash.row("ocr", ocrRunId);
      assert.equal(ocrRow.status, "done", "OCR review row is terminal done after approval");
      assert.equal(ocrRow.archetype, "preview", "terminal OCR review stays preview");
      assert.equal(ocrRow.parentRunId, ticketRunId, "terminal OCR review stays delegated under the ticket");

      // FINAL no-spurious-fan-out check: the ticket's children are STILL exactly
      // the OCR review + the one signer — no second oath-upload ticket ever
      // appeared across the whole lifecycle.
      const kids = await rt.children(ticketRunId);
      assert.equal(
        kids.filter((k) => k.workflow === "oath-upload").length,
        0,
        "NO oath-upload child of the ticket at terminal (the born ticket IS the only ticket)",
      );
      assert.equal(
        kids.filter((k) => k.workflow === "ocr").length,
        1,
        "exactly 1 OCR review child at terminal",
      );
      assert.equal(
        kids.filter((k) => k.workflow === "oath-signature").length,
        1,
        "exactly 1 signer child at terminal",
      );
    }

    await rt.cleanup();

    // The real `.tracker/` is untouched; the temp dir is gone.
    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
    assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
  },
);
