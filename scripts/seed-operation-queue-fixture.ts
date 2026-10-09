/**
 * Seed a synthetic OPERATION-QUEUE fixture (separations 3-doc input run) into an
 * isolated tracker dir for headless dashboard verification with `playwright-cli`.
 *
 * Produces ONE real `operation` coordinator row + three `operation-member` children
 * (matching `enqueue-dispatch.ts` multi-input-run shape), plus daemon session
 * lifecycle events attributed to the coordinator's workflow instance.
 *
 * Usage:
 *   tsx scripts/seed-operation-queue-fixture.ts [trackerDir]
 *   (default: generated/.dashboard-preview/tracker — gitignored)
 *
 * Then:
 *   npm run build:dashboard
 *   HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3939
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildTraceId, tracePrefix } from "../src/domain/queue-trace-id.js";
import { buildOperatorSubject, operatorSubjectData } from "../src/domain/operator-subject.js";
import {
  appendLogEntry,
  emitTrackerRow,
  type StampedData,
} from "../src/tracker/jsonl-io.js";
import {
  emitWorkflowStart,
  emitSessionCreate,
  emitBrowserLaunch,
  emitAuthStart,
  emitAuthComplete,
  emitItemStart,
  emitIdleSignal,
  emitDaemonPhase,
  emitSessionEvent,
} from "../src/tracker/session-events.js";
import { logsDir, rowsDir, sessionsDir } from "../src/tracker/paths.js";

const dir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(rowsDir(dir), { recursive: true });
mkdirSync(logsDir(dir), { recursive: true });
mkdirSync(sessionsDir(dir), { recursive: true });

const WORKFLOW = "separations";
const INSTANCE = "Separation 1";
const SESSION_ID = "1";
const DOC_IDS = ["4361", "4362", "4363"] as const;

const baseAt = new Date();
const iso = (offsetMs: number): string => new Date(baseAt.getTime() + offsetMs).toISOString();

const operationCoordinatorRunId = randomUUID();
const coordinatorItemId = `input-run-${operationCoordinatorRunId.slice(0, 8)}`;
const coordinatorTraceId = buildTraceId({
  code: "se",
  runId: operationCoordinatorRunId,
  at: baseAt,
});
const sharedTracePrefix = tracePrefix(coordinatorTraceId);

const memberRunIds = DOC_IDS.map(() => randomUUID());

function memberData(docId: string, memberRunId: string, status: "pending" | "running"): StampedData {
  const subject = buildOperatorSubject({ kind: "document", value: docId, prefix: "Separation" });
  return {
    archetype: "operation-member",
    queueRowKind: "person",
    docId,
    __id: docId,
    __traceId: buildTraceId({ code: "se", runId: memberRunId, at: baseAt, rootPrefix: sharedTracePrefix }),
    batchDisplayOrdinal: "1",
    instance: INSTANCE,
    ...operatorSubjectData(subject),
  };
}

// ── Coordinator row (real operation anchor — NOT a synthetic batch) ────────
emitTrackerRow(
  {
    workflow: WORKFLOW,
    timestamp: iso(0),
    id: coordinatorItemId,
    runId: operationCoordinatorRunId,
    status: "running",
    data: {
      // Mirror enqueue-dispatch.ts `coordinatorData` exactly: an operation
      // coordinator row carries NO `data.instance` (the daemon runs the member
      // items, each of which carries the real instance). Stamping instance here
      // would let `resolveInstanceForRun` resolve directly and skip the
      // child-entry supplement, which is what surfaces member item_start events
      // on the coordinator timeline.
      archetype: "operation",
      queueRowKind: "person",
      __id: coordinatorItemId,
      __traceId: coordinatorTraceId,
      batchDisplayOrdinal: "1",
    },
  },
  dir,
);

// ── Member rows (operation-member, shared parentRunId) ─────────────────────
DOC_IDS.forEach((docId, index) => {
  const runId = memberRunIds[index]!;
  const status = index === 0 ? "running" : "pending";
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: iso(100 + index * 50),
      id: docId,
      runId,
      parentRunId: operationCoordinatorRunId,
      status,
      ...(index === 0 ? { step: "kuali-extraction" } : {}),
      data: memberData(docId, runId, status),
      input: { docId },
    },
    dir,
  );
});

// ── Session lifecycle (batch-scope — no runId; coordinator aggregates these) ─
emitWorkflowStart(INSTANCE, dir);
emitSessionCreate(INSTANCE, SESSION_ID, dir);

const systems: Array<{ id: string; label: string }> = [
  { id: "kuali", label: "Kuali" },
  { id: "new-kronos", label: "Kronos" },
  { id: "ucpath", label: "UCPath" },
];

let t = 200;
for (const sys of systems) {
  emitBrowserLaunch(INSTANCE, SESSION_ID, sys.id, sys.label, dir);
  emitAuthStart(INSTANCE, sys.id, sys.label, dir);
  emitAuthComplete(INSTANCE, sys.id, sys.label, dir);
  const duoRequestId = `${INSTANCE}-${sys.id}-${baseAt.getTime() + t}`;
  emitSessionEvent(
    {
      type: "duo_request",
      workflowInstance: INSTANCE,
      sessionId: SESSION_ID,
      browserId: sys.id,
      system: sys.label,
      duoRequestId,
    },
    dir,
  );
  emitSessionEvent(
    {
      type: "duo_complete",
      workflowInstance: INSTANCE,
      sessionId: SESSION_ID,
      browserId: sys.id,
      system: sys.label,
      duoRequestId,
    },
    dir,
  );
  t += 40;
}

emitIdleSignal(INSTANCE, dir, "ucpath", "touch");
emitDaemonPhase(INSTANCE, "idle", dir);

// Per-item direct event on the in-flight member (NOT batch-scope).
emitItemStart(
  INSTANCE,
  DOC_IDS[0]!,
  dir,
  memberRunIds[0]!,
  buildTraceId({ code: "se", runId: memberRunIds[0]!, at: baseAt, rootPrefix: sharedTracePrefix }),
);

// ── Sparse per-run logs ──────────────────────────────────────────────────────
appendLogEntry(
  {
    workflow: WORKFLOW,
    itemId: coordinatorItemId,
    runId: operationCoordinatorRunId,
    level: "step",
    message: "Operation input run — 3 documents queued",
    ts: iso(150),
  },
  dir,
);

appendLogEntry(
  {
    workflow: WORKFLOW,
    itemId: DOC_IDS[0]!,
    runId: memberRunIds[0]!,
    level: "step",
    message: "Phase: kuali-extraction",
    ts: iso(400),
  },
  dir,
);

// eslint-disable-next-line no-console
console.log(
  `[seed-operation-queue-fixture] seeded → ${dir}\n` +
    `  coordinator: ${coordinatorItemId} runId=${operationCoordinatorRunId.slice(0, 8)}… trace=${coordinatorTraceId}\n` +
    `  members: ${DOC_IDS.join(", ")} parentRunId=${operationCoordinatorRunId.slice(0, 8)}…\n` +
    `  session: ${INSTANCE} (workflow_start.pid=${process.pid}). Kill this process when done.`,
);

setInterval(() => {}, 1 << 30);
