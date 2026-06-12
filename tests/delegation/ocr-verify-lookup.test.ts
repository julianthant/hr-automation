import { test } from "vitest";
import { z } from "zod";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import {
  createDelegationRuntime,
  makeGatedWorkflow,
  createGateCoordinator,
  readQueueStateIncludingTerminals,
  rawVerifyRecordFromStub,
  type StubVerifyOcrRecord,
} from "./_runtime/index.js";
import { defineWorkflow } from "../../src/core/kernel/workflow.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../src/domain/workflow-runtime/default-policy.js";
import { PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY } from "../../src/workflows/person-lookup/workflow.js";
import type { RegisteredWorkflow } from "../../src/core/kernel/types.js";

const REAL_TRACKER_DIR = ".tracker";
const FIXTURE_PDF = "tests/data/detect-test.pdf";

function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null;
  return readdirSync(REAL_TRACKER_DIR).sort();
}

async function waitForQueue(
  workflow: string,
  dir: string,
  pred: (st: Awaited<ReturnType<typeof readQueueStateIncludingTerminals>>) => boolean,
  timeoutMs = 30_000,
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

// ─── Faithful stub daemons for the verify enrichment fan-out targets ─────────
//
// IMPORTANT (spike finding): `verify.enrichRecords` does
// `delegateToAllImpl({ child: personLookupWorkflow / i9LookupWorkflow, ... })`,
// and BOTH children are daemon-capable (in `WORKFLOW_LOADERS`). So
// `delegateToAllImpl` takes the DAEMON-DISPATCH path (`isDaemonCapable` is
// checked FIRST, before `fireAndForget`) — NOT the in-process path. The
// children are separate daemon runs the OCR worker waits on via the REAL
// `watchChildRuns` (SQLite task states). To run them faithfully without
// browsers (and without spawning real `tsx` daemon subprocesses, which crash in
// the harness), we register gated stub daemons under the SAME names so the
// verify fan-out's `ensureDaemonsAndEnqueue` REUSES these alive daemons. Their
// configs mirror production so the projection matches the truth — exactly the
// P2.9/P2.10 gated-stub pattern, applied to a delegateToAllImpl fan-out instead
// of an approveTo fan-out.

/** Tolerant person-lookup input schema — verify sends `{ name, includeCrmDates, keepNonHdh, taskGroupId, parentSubject? }` (no `id`). */
const PlInputSchema = z.object({ name: z.string().min(1) }).passthrough();
/** Tolerant i9-lookup input schema — verify sends `{ lastName, firstName, parentSubject? }`. */
const I9InputSchema = z.object({ lastName: z.string().min(1), firstName: z.string().min(1) }).passthrough();

/** i9-lookup's real runtime policy (delegated-only, always-batch). */
const I9_RUNTIME_POLICY = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: { titleSource: "person" as const },
  delegation: { ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation, alwaysBatchDelegatedMembers: true },
};

/**
 * A non-gated person-lookup stub daemon (mirrors `code:"pl"`, `inputSubject:"name"`,
 * `archetype:"single"`, the real `alwaysBatchDelegatedMembers` policy). Its
 * `searching` step runs straight through to `done`, stamping `searchName` so the
 * person-kind title resolves to the name.
 */
function makePlStub(): RegisteredWorkflow<z.infer<typeof PlInputSchema>, readonly string[]> {
  return defineWorkflow({
    name: "person-lookup",
    label: "Person Lookup",
    code: "pl",
    archetype: "single",
    inputSubject: "name",
    systems: [],
    authSteps: false,
    steps: ["searching"] as const,
    schema: PlInputSchema,
    runtimePolicy: PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY,
    initialData: (input) => ({ searchName: typeof input.name === "string" ? input.name : "" }),
    getId: (d) => d.searchName ?? "",
    getName: (d) => d.searchName ?? "",
    operatorSubject: (input) => ({
      kind: "person" as const,
      label: typeof input.name === "string" ? input.name : "",
    }),
    handler: async (ctx, input) => {
      await ctx.step("searching", async () => {
        const name = typeof (input as { name?: string }).name === "string" ? (input as { name: string }).name : "";
        ctx.updateData({ searchName: name });
      });
    },
  }) as unknown as RegisteredWorkflow<z.infer<typeof PlInputSchema>, readonly string[]>;
}

/**
 * A non-gated i9-lookup stub daemon (mirrors `code:"i9"`, `inputSubject:"name"`,
 * `archetype:"single"`, the real always-batch policy). Its `lookup` step runs
 * straight through to `done`. Title resolves from the `name` data field, which
 * the kernel seeds from the operator subject `${lastName}, ${firstName}`.
 */
function makeI9Stub(): RegisteredWorkflow<z.infer<typeof I9InputSchema>, readonly string[]> {
  return defineWorkflow({
    name: "i9-lookup",
    label: "I9 Lookup",
    code: "i9",
    archetype: "single",
    inputSubject: "name",
    systems: [],
    authSteps: false,
    steps: ["lookup"] as const,
    schema: I9InputSchema,
    runtimePolicy: I9_RUNTIME_POLICY,
    getId: (d) => d.id ?? "",
    getName: (d) => d.name ?? "",
    operatorSubject: (input) => {
      const r = input as { lastName?: string; firstName?: string };
      return { kind: "person" as const, label: `${r.lastName}, ${r.firstName}` };
    },
    handler: async (ctx) => {
      await ctx.step("lookup", async () => {});
    },
  }) as unknown as RegisteredWorkflow<z.infer<typeof I9InputSchema>, readonly string[]>;
}

/**
 * PII-FREE synthetic verify records (a MIXED oath + emergency-contact stack):
 *  - 2 oath records (one `officerSigned:false` → i9-lookup fires; one signed → no i9)
 *  - 1 emergency-contact record (no i9)
 * All carry a printed `name`, so person-lookup fans out for all THREE.
 * EIDs are blank on paper (verify looks them up via person-lookup).
 */
const VERIFY_RECORDS: StubVerifyOcrRecord[] = [
  { formKind: "oath", sourcePage: 1, printedName: "Doe, Jane A", employeeId: null, officerSigned: false },
  { formKind: "oath", sourcePage: 2, printedName: "Roe, Richard", employeeId: null, officerSigned: true },
  { formKind: "emergency-contact", sourcePage: 3, printedName: "Stone, Sam", employeeId: null },
];

/**
 * P2.11 — OCR `verify` → person-lookup + i9-lookup enrichment fan-out through
 * the REAL daemon (no browser, temp tracker root, no `.tracker/` pollution).
 *
 * verify is a READ-ONLY completeness report: NO `approveTo`/`approveDocumentTo`,
 * so there is NO approve fan-out (unlike P2.9/P2.10). Its delegation happens
 * inside the form spec's `enrichRecords` hook, which `delegateToAllImpl` +
 * `watchChildRuns` to person-lookup (every named record) and i9-lookup (oath
 * records with a blank authorized-official signature). The OCR root brands the
 * operation `vf-…` (`spec.traceCode`) and that prefix propagates to every child.
 *
 * Flow: stub verify OCR run (real `runOcrOrchestrator`, stubbed LLM, empty
 * roster — `rosterMode:"optional"`) → `enrichRecords` fan-out → 3 person-lookup
 * + 1 i9-lookup children complete on their gated stub daemons → verify reaches
 * `awaiting-approval` → assert the dashboard projection invariant checklist.
 */
test(
  "OCR verify → person-lookup + i9-lookup enrichment fan-out: projection correct",
  { timeout: 90_000 },
  async (t) => {
    const before = snapshotRealTracker();

    const rt = await createDelegationRuntime({
      // person-lookup + i9-lookup stub daemons mirror the real configs so the
      // verify fan-out reuses them (no real subprocess spawn). A short idle
      // window matters: `ensureDaemonsAndEnqueue` wakes the daemon BEFORE it
      // commits the SQLite tasks, so the first wake misses; the daemon's
      // keepalive re-poll (every `idleTimeoutMs`) then claims the committed
      // tasks. Keep it short so children claim promptly. The OCR daemon is busy
      // (processing) during enrichment, so its idle window doesn't apply.
      workflows: [makePlStub() as never, makeI9Stub() as never],
      ocr: { formType: "verify" },
      idleTimeoutMs: 1_000,
    });
    t.onTestFinished(() => rt.cleanup());

    // 1. Seed the verify-shaped raw records + an EMPTY roster (verify is
    //    rosterMode:"optional" — it matches names via person-lookup, not a roster).
    rt.stubOcr(VERIFY_RECORDS.map(rawVerifyRecordFromStub), []);

    // 2. Enqueue the OCR verify run (registers the fixture PDF).
    const ocr = await rt.enqueueOcr({ fixturePath: FIXTURE_PDF, originalName: "detect-test.pdf" });

    // 3. Wait for verify to finish enrichment + COMPLETE. verify BLOCKS on its
    //    children: the hook is awaited, so the OCR row stays `running` until
    //    person-lookup + i9-lookup finish — proving the enrichment fan-out
    //    resolved (NOT a hang) — then a STANDALONE verify run completes `done`
    //    at person-lookup (no awaiting-approval gate; approval ≡ delegation).
    await rt.waitForEvent("ocr:review-complete", { runId: ocr.runId, timeoutMs: 75_000 });

    // 4. All 4 enrichment children reached terminal `done` on their daemons.
    await waitForQueue("person-lookup", rt.trackerDir, (st) => st.done.length >= 3);
    await waitForQueue("i9-lookup", rt.trackerDir, (st) => st.done.length >= 1);

    // ─── children() finds exactly the enrichment fan-out (no orphans/dupes) ───
    const kids = await rt.children(ocr.runId);
    const plKids = kids.filter((k) => k.workflow === "person-lookup");
    const i9Kids = kids.filter((k) => k.workflow === "i9-lookup");
    assert.equal(plKids.length, 3, "3 person-lookup children (one per named record)");
    assert.equal(
      i9Kids.length,
      1,
      "1 i9-lookup child (only the oath record with officerSigned:false)",
    );
    assert.equal(kids.length, 4, "exactly 4 enrichment children under the OCR verify run");
    assert.equal(new Set(kids.map((k) => k.runId)).size, 4, "no duplicate child runs in projection");

    // itemIds match verify's deterministic scheme:
    //   person-lookup → ocr-verify-<runId>-r<idx>
    //   i9-lookup     → ocr-verify-i9-<runId>-r<idx>
    const expectedPlIds = new Set([0, 1, 2].map((i) => `ocr-verify-${ocr.runId}-r${i}`));
    assert.deepEqual(
      new Set(plKids.map((k) => k.itemId)),
      expectedPlIds,
      "person-lookup itemIds follow ocr-verify-<runId>-r<idx>",
    );
    // record 0 (Jane, oath, officerSigned:false) is the only i9 fan-out.
    assert.deepEqual(
      new Set(i9Kids.map((k) => k.itemId)),
      new Set([`ocr-verify-i9-${ocr.runId}-r0`]),
      "i9-lookup itemId is ocr-verify-i9-<runId>-r0 (the blank-signer oath record)",
    );

    const dash = rt.dashboard();

    // ─── OCR verify parent row ───────────────────────────────────────────────
    // archetype `preview`; file-kind title (PDF filename); subtitle = trace id;
    // `vf-…` trace id (verify brands `vf`). A STANDALONE verify run completes
    // terminal `done` after person-lookup — no approve fan-out, no awaiting-
    // approval gate (approval ≡ delegation); the operator reads the read-only
    // completeness card on the done row.
    const ocrRow = dash.row("ocr", ocr.runId);
    assert.equal(ocrRow.archetype, "preview", "OCR verify parent row archetype is preview");
    assert.equal(ocrRow.title, "detect-test.pdf", "OCR (file kind) title is the PDF filename");
    assert.equal(ocrRow.subtitle, "<traceId>", "OCR (file kind) subtitle is the trace id");
    assert.equal(ocrRow.data.queueRowKind, "file", "OCR row is file-kind (pdf input)");
    assert.equal(ocrRow.data.__traceId, "<traceId>", "OCR row carries a (scrubbed) trace id");
    assert.equal(ocrRow.status, "done", "standalone OCR verify row completes done after person-lookup");

    // ─── person-lookup children (name → person kind) ─────────────────────────
    const plTitleByItemId: Record<string, string> = {
      [`ocr-verify-${ocr.runId}-r0`]: "Doe, Jane A",
      [`ocr-verify-${ocr.runId}-r1`]: "Roe, Richard",
      [`ocr-verify-${ocr.runId}-r2`]: "Stone, Sam",
    };
    for (const c of plKids) {
      const row = dash.row("person-lookup", c.runId);
      assert.equal(row.parentRunId, ocr.runId, `pl ${c.itemId} parentRunId === OCR runId`);
      assert.equal(row.archetype, "single", `pl ${c.itemId} keeps its natural single archetype`);
      assert.equal(row.data.queueRowKind, "person", `pl ${c.itemId} is person-kind (name input)`);
      assert.equal(row.title, plTitleByItemId[c.itemId], `pl ${c.itemId} title is the resolved name`);
      // Subtitle rule: no EID present → the trace id (scrubbed).
      assert.equal(row.subtitle, "<traceId>", `pl ${c.itemId} subtitle is the trace id`);
      assert.equal(row.data.__traceId, "<traceId>", `pl ${c.itemId} carries a (scrubbed) trace id`);
      assert.equal(row.status, "done", `pl ${c.itemId} completed done`);
    }

    // ─── i9-lookup child (name → person kind) ────────────────────────────────
    const i9 = i9Kids[0]!;
    const i9Row = dash.row("i9-lookup", i9.runId);
    assert.equal(i9Row.parentRunId, ocr.runId, "i9 child parentRunId === OCR runId");
    assert.equal(i9Row.archetype, "single", "i9 child keeps its natural single archetype");
    assert.equal(i9Row.data.queueRowKind, "person", "i9 child is person-kind (name input)");
    // verify parses "Doe, Jane A" → lastName=Doe, first=Jane → title "Doe, Jane".
    assert.equal(i9Row.title, "Doe, Jane", "i9 child title is the parsed last, first name");
    assert.equal(i9Row.subtitle, "<traceId>", "i9 child subtitle is the trace id");
    assert.equal(i9Row.data.__traceId, "<traceId>", "i9 child carries a (scrubbed) trace id");
    assert.equal(i9Row.status, "done", "i9 child completed done");

    // ─── Group anchors (alwaysBatchDelegatedMembers → batch surface) ─────────
    const plAnchor = dash.groupAnchor("person-lookup", ocr.runId);
    assert.equal(plAnchor.memberCount, 3, "person-lookup group anchor has 3 members");
    assert.equal(plAnchor.kind, "batch", "delegated person-lookup members render as a batch surface");
    assert.equal(plAnchor.subtitle, "<traceId>", "pl group anchor subtitle is the trace id");

    const i9Anchor = dash.groupAnchor("i9-lookup", ocr.runId);
    assert.equal(i9Anchor.memberCount, 1, "i9-lookup group anchor has 1 member");
    assert.equal(
      i9Anchor.kind,
      "batch",
      "a lone delegated i9-lookup member still renders as a batch surface (alwaysBatchDelegatedMembers)",
    );
    assert.equal(i9Anchor.subtitle, "<traceId>", "i9 group anchor subtitle is the trace id");

    await rt.cleanup();

    // The real `.tracker/` is untouched; the temp dir is gone.
    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
    assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
  },
);

/**
 * P2.11 cancel invariant — cancelling the OCR verify PARENT while enrichment is
 * in flight drives it to a terminal cancelled state WITHOUT hanging, and the
 * row keeps its preview identity (file-kind title). Sync: hold person-lookup at
 * its `searching` stage so a child is parked mid-enrichment (the OCR worker is
 * blocked in `watchChildRuns`), then cancel the OCR parent via the REAL
 * control-layer cancel path. The cancel aborts the OCR run's `ctx.signal`; the
 * orchestrator's entry bridge trips the in-process prepare-abort flag, which
 * `raceOcrPrepWithDiscard` polls → the enrich await unblocks and rethrows → the
 * daemon maps it to a terminal `CancelledError` + `step:"cancelled"`. The
 * daemon-dispatched children are independent daemon runs (NOT in-process), so a
 * parent cancel does not propagate to them — the orphaned `enrichRecords`
 * promise keeps watching its own children; we assert only the PARENT invariant.
 */
test(
  "OCR verify → enrichment fan-out: cancelling the OCR parent mid-enrichment terminates cancelled (no hang)",
  { timeout: 60_000 },
  async (t) => {
    const before = snapshotRealTracker();
    const coordinator = createGateCoordinator();

    // A GATED person-lookup stub so a child parks at `searching` until released
    // or cancelled — lets us land the OCR parent's cancel WHILE enrichment is
    // in flight (the OCR worker is blocked awaiting the child via watchChildRuns).
    const gatedPl = makeGatedWorkflow(
      {
        name: "person-lookup",
        label: "Person Lookup",
        code: "pl",
        stages: ["searching"],
        gatedStages: ["searching"],
        archetype: "single",
        inputSubject: "name",
        runtimePolicy: PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY,
        initialData: (input) => ({ searchName: typeof input.name === "string" ? input.name : "" }),
        getId: (d) => d.searchName ?? "",
        getName: (d) => d.searchName ?? "",
      },
      coordinator,
    );
    const gatedPlTolerant = {
      ...gatedPl,
      config: { ...gatedPl.config, schema: PlInputSchema },
    } as unknown as typeof gatedPl;

    // i9-lookup stub (ungated — never reached on the cancel path since
    // person-lookup is held before i9's fan-out fires; registered so its
    // daemon is reused rather than spawned if the timing ever changes).
    const i9 = makeGatedWorkflow(
      { name: "i9-lookup", label: "I9 Lookup", code: "i9", stages: ["lookup"], gatedStages: [], archetype: "single", inputSubject: "name", runtimePolicy: I9_RUNTIME_POLICY },
      coordinator,
    );
    const i9Tolerant = { ...i9, config: { ...i9.config, schema: I9InputSchema } } as unknown as typeof i9;

    const rt = await createDelegationRuntime({
      workflows: [gatedPlTolerant as never, i9Tolerant as never],
      ocr: { formType: "verify" },
      idleTimeoutMs: 1_000,
    });
    t.onTestFinished(() => rt.cleanup());

    // Hold every person-lookup child at `searching` BEFORE the run starts.
    // NOTE: arm the LOCAL coordinator — the gated stubs above were pre-wrapped
    // with it (to override their schema), so `rt.holdAll` (which arms the
    // runtime's own coordinator) never reaches them. This hold silently
    // no-opped before 2026-06-11; the test passed only because the sequential
    // i9 dispatch left enough wall-clock for the cancel to land mid-run.
    coordinator.holdAll("person-lookup", "searching");

    const cancelRecords: StubVerifyOcrRecord[] = [
      { formKind: "oath", sourcePage: 1, printedName: "Doe, Jane A", employeeId: null, officerSigned: false },
      { formKind: "emergency-contact", sourcePage: 2, printedName: "Stone, Sam", employeeId: null },
    ];
    rt.stubOcr(cancelRecords.map(rawVerifyRecordFromStub), []);

    const ocr = await rt.enqueueOcr({ fixturePath: FIXTURE_PDF, originalName: "detect-test.pdf" });

    // A person-lookup child reached the held `searching` stage → enrichment is
    // in flight and the OCR worker is blocked in watchChildRuns.
    await rt.waitForEvent("step:start", { step: "searching", count: 1, timeoutMs: 40_000 });

    // Cancel the OCR parent via the REAL control-layer cancel path.
    await rt.cancel(ocr.runId);

    // The OCR verify run reaches a terminal cancelled state (does NOT hang in
    // watchChildRuns forever).
    await rt.waitForEvent("run:terminal", { runId: ocr.runId, occasion: "cancelled", timeoutMs: 30_000 });
    await waitForQueue("ocr", rt.trackerDir, (st) => st.failed.some((i) => i.runId === ocr.runId));

    // Cancelled OCR row keeps its preview identity (file-kind title), status
    // failed + cancelled step (the universal cancelled override).
    const ocrRow = rt.dashboard().row("ocr", ocr.runId);
    assert.equal(ocrRow.status, "failed", "cancelled OCR run is status failed");
    assert.equal(ocrRow.statusLabel, "Cancelled", "cancelled OCR run shows the Cancelled label");
    assert.equal(ocrRow.step, "cancelled", "cancelled OCR run step is cancelled");
    assert.equal(ocrRow.archetype, "preview", "cancelled OCR run keeps its preview archetype");
    assert.equal(ocrRow.title, "detect-test.pdf", "cancelled OCR run keeps its file-kind title");

    await rt.cleanup();
    assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
    assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
  },
);
