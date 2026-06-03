import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, type UUID } from "node:crypto";

import { Session } from "../../../src/core/kernel/session.js";
import { runWorkflowDaemon } from "../../../src/core/daemon/daemon.js";
import { clear } from "../../../src/core/kernel/registry.js";
import {
  enqueueItems,
  readQueueStateIncludingTerminals,
} from "../../../src/core/daemon/queue.js";
import { findAliveDaemons, invalidateAliveDaemonsCache } from "../../../src/core/daemon/registry.js";
import { _resetRunRegistryForTests } from "../../../src/core/run-registry.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { buildCancelRunningHandler } from "../../../src/control/ops/cancel.js";
import { logFilePath, rowFilePath, rowsDir, logsDir } from "../../../src/tracker/paths.js";
import { dateLocal, parseWorkflowDateFilename } from "../../../src/tracker/jsonl.js";
import { buildOcrApproveHandler } from "../../../src/tracker/dashboard/ocr/approve.js";
import { _resetApprovalSignalRegistryForTests } from "../../../src/services/ocr/approval-signal.js";
import type { RegisteredWorkflow } from "../../../src/core/kernel/types.js";
import type { OcrInput } from "../../../src/workflows/ocr/schema.js";

import {
  createGateCoordinator,
  makeGatedWorkflow,
  type GateCoordinator,
  type GatedInput,
  type GatedWorkflowSpec,
} from "./scenario-handler.js";
import {
  makeStubOcrWorkflow,
  registerOcrPdf,
  type StubOcrConfig,
  type StubOcrRecord,
  type StubOcrState,
  type StubRosterRow,
} from "./ocr-stub.js";
import {
  snapshotRow,
  snapshotGroupAnchor,
  readRowTimeline,
  type RowSnapshot,
  type GroupAnchorSnapshot,
} from "./snapshot-row.js";

/** A registered workflow the harness can drive a daemon for. */
export type DelegationWorkflow = RegisteredWorkflow<GatedInput, readonly string[]>;

/**
 * A workflow registration with an explicit daemon-instance count. A single
 * daemon processes ONE run at a time (serial claim loop), so to hold N children
 * of the SAME workflow concurrently the harness must run N daemon instances
 * that race to claim through SQLite — mirroring how a real workflow scales its
 * daemon pool. `instances` defaults to 1.
 */
export interface WorkflowRegistration {
  workflow: DelegationWorkflow | GatedWorkflowSpec;
  /** Number of racing daemon instances for this workflow. Default 1. */
  instances?: number;
}

/** Fake `Session.launch` — no browsers, used by every harness daemon. */
function stubLaunch(): typeof Session.launch {
  return (async () =>
    Session.forTesting({
      systems: [],
      browsers: new Map(),
      readyPromises: new Map(),
    })) as unknown as typeof Session.launch;
}

export interface EnqueueOpts {
  /** Pre-assign the run id (else a fresh UUID). */
  runId?: string;
  /** Stamp `tasks.parent_run_id` so the row renders as a delegated child. */
  parentRunId?: string;
  /** Pre-assign the item id (else `deriveItemId(input)` or the input `id`). */
  itemId?: string;
  /**
   * Render the enqueued row as a delegated **batch member** (count badge +
   * member preview under the parent anchor). Stamps
   * `__runtimeOptions.rowShape = "batch-member"` on the input — exactly what
   * the real `approveTo` fan-out (`withBatchMemberRuntimeOptions`) does. Use
   * with `parentRunId` to model the OCR→oath-signature independent-child star
   * case. Without it, a `parentRunId`-enqueued row keeps the workflow's own
   * archetype (`single`) plus delegated scope.
   */
  renderAs?: "batch";
}

export interface WaitForEventOpts {
  /** Scope to one run (the primary match key). */
  runId?: string;
  /** Filter by `step` (for `step:start` / `step:done`). */
  step?: string;
  /** Filter by `occasion` (for `run:terminal`: completed/failed/cancelled). */
  occasion?: string;
  /** Filter by `childWorkflow` (for `delegation:children-spawned`). */
  childWorkflow?: string;
  /** Resolve only once N matching lines have appeared. Default 1. */
  count?: number;
  timeoutMs?: number;
}

/** One structured log line read from a `logs/<workflow>-<date>.jsonl` file. */
interface LogLine {
  workflow?: string;
  runId?: string;
  itemId?: string;
  event?: string;
  step?: string;
  occasion?: string;
  childWorkflow?: string;
  count?: number;
}

export interface DashboardView {
  /** Per-row projection — exactly what the React queue panel would render. */
  row(workflow: string, runId: string): RowSnapshot;
  /** Group-card projection for a batch/preview anchor (by parent run id). */
  groupAnchor(workflow: string, parentRunId: string): GroupAnchorSnapshot;
  /** Raw tracker entries for one run — assert on the full step sequence. */
  timeline(workflow: string, runId: string): ReturnType<typeof readRowTimeline>;
}

export interface CreateDelegationRuntimeOpts {
  /**
   * Workflows to register + start a daemon for. Either pre-built (via
   * `makeGatedWorkflow`), a `GatedWorkflowSpec` the runtime builds with its own
   * coordinator, or a `WorkflowRegistration` carrying an `instances` count for
   * concurrent-child fan-out (N racing daemons).
   */
  workflows: ReadonlyArray<DelegationWorkflow | GatedWorkflowSpec | WorkflowRegistration>;
  /** Reserved for OCR scenarios (P2.9) — a PDF the OCR seam will register. */
  pdf?: string;
  /**
   * Register a thin test-only `"ocr"` workflow + daemon driving the REAL
   * `runOcrOrchestrator` with stubbed LLM/roster/eid-lookup (no browser, no LLM,
   * no SQLite deps). When present, the runtime exposes `stubOcr` / `enqueueOcr`
   * / `approveOcr` for the OCR → `approveTo` fan-out star test (P2.9). The
   * daemon starts at construction (like every other workflow daemon), so the
   * test sets records via `stubOcr` BEFORE `enqueueOcr`.
   */
  ocr?: StubOcrConfig;
  /** Daemon idle window. Keep small so daemons spin down promptly. */
  idleTimeoutMs?: number;
}

/** One OCR child run enqueued onto its gated daemon by `approveOcr`. */
export interface ApprovedChild {
  itemId: string;
  runId: string;
}

export interface EnqueueOcrOpts {
  /** Path to the fixture PDF to register (falls back to a synthetic one-pager). */
  fixturePath: string;
  /** Original filename the OCR file/title resolves to. Defaults to basename. */
  originalName?: string;
  /** Pre-assign the OCR run id (else a fresh UUID). */
  runId?: string;
  /** Pre-assign the OCR session id (the OCR row `id`). Else a fresh id. */
  sessionId?: string;
  /** Stamp `parentRunId` (delegated OCR — rare; standalone OCR omits it). */
  parentRunId?: string;
}

export interface EnqueueOcrResult {
  sessionId: string;
  runId: string;
  /** True when the real fixture rendered; false when the synthetic fallback was used. */
  usedFixture: boolean;
}

export interface ApproveOcrOpts {
  sessionId: string;
  runId: string;
  /** The approved records (selected + EID) the operator would submit. */
  records: Array<Record<string, unknown>>;
  /**
   * The gated child daemon to fan out onto (the `approveTo.workflow`, e.g.
   * `"oath-signature"`). The real approve route resolves the per-record itemIds
   * + inputs via the form spec; the override enqueues each onto this daemon.
   */
  childWorkflow: string;
}

export interface DelegationRuntime {
  /** Temp tracker dir for this runtime — removed by `cleanup()`. */
  trackerDir: string;
  /** The registered workflows, keyed by name. */
  workflows: Map<string, DelegationWorkflow>;

  /** Enqueue one item for `workflow`. Returns the assigned `runId`. */
  enqueue(
    workflow: DelegationWorkflow | string,
    input?: Partial<GatedInput> & { id?: string },
    opts?: EnqueueOpts,
  ): Promise<{ runId: string; itemId: string }>;

  /**
   * Tail `logs/<workflow>-<date>.jsonl` across all daemons and resolve once the
   * named structured `event` (P1.6) has appeared `count` times (filtered by
   * `runId`/`step`/`occasion`/`childWorkflow`). No sleeps — pure log tailing.
   */
  waitForEvent(event: string, opts?: WaitForEventOpts): Promise<void>;

  /** Mark every run of `workflow` reaching `stage` as held until released. */
  holdAll(workflow: DelegationWorkflow | string, stage: string): void;
  /** Release a specific held stage for one run (lets it reach `done`). */
  release(runId: string, stage: string): void;

  /** Cancel a run through the REAL control-layer cancel path. */
  cancel(runId: string): Promise<void>;

  /** Child runs of `parentRunId` (by `tasks.parent_run_id` / JSONL parentRunId). */
  children(parentRunId: string): Promise<Array<{ workflow: string; runId: string; itemId: string }>>;

  /** REAL projection over the temp tracker (salvaged snapshot-row). */
  dashboard(): DashboardView;

  /** Stop all daemons + closeStateDbForTests + rm temp dir. Idempotent. */
  cleanup(): Promise<void>;

  /**
   * Seed the synthetic OCR records (+ optional roster) the stub
   * `runOcrOrchestrator` pipeline returns. Call BEFORE `enqueueOcr`. Records are
   * PII-FREE — fake names + fake 5+-digit (UCPath-shaped) EIDs. When `roster` is
   * omitted, a roster row is derived per record (EID short-circuit → matched).
   * Requires `ocr` in the runtime opts.
   */
  stubOcr(records: ReadonlyArray<StubOcrRecord>, roster?: ReadonlyArray<StubRosterRow>): void;

  /**
   * Register a renderable PDF in the temp tracker file store and enqueue an OCR
   * run on the stub `"ocr"` daemon. Returns the assigned `sessionId` + `runId`
   * (sync on `ocr:awaiting-approval` via `waitForEvent`). Requires `ocr` opts.
   */
  enqueueOcr(opts: EnqueueOcrOpts): Promise<EnqueueOcrResult>;

  /**
   * Drive the REAL approve fan-out (`buildOcrApproveHandler`) for an OCR run:
   * the real `approveTo.deriveInput/deriveItemId/canFanOut`, trace-prefix
   * propagation, `childParentRunId`, and terminal OCR row all run, with the
   * child enqueue redirected onto `childWorkflow`'s gated daemon via
   * `rt.enqueue(..., { renderAs: "batch" })`. Resolves with the enqueued child
   * runs once the approve route's background dispatch completes.
   */
  approveOcr(opts: ApproveOcrOpts): Promise<ApprovedChild[]>;
}

/** Internal per-workflow daemon handle. */
interface DaemonHandle {
  workflow: string;
  port: number;
  runPromise: Promise<void>;
}

async function waitForDaemons(
  workflow: string,
  dir: string,
  count: number,
  timeoutMs = 8000,
): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    invalidateAliveDaemonsCache(workflow, dir);
    const alive = await findAliveDaemons(workflow, dir);
    if (alive.length >= count) return alive.slice(0, count).map((d) => d.port);
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `daemon '${workflow}' only registered ${alive.length}/${count} within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every workflow that has written a logs/ file under `dir`. */
function listLogWorkflows(dir: string): string[] {
  const ldir = logsDir(dir);
  if (!existsSync(ldir)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(ldir)) {
    const parsed = parseWorkflowDateFilename(file);
    if (parsed) names.add(parsed.workflow);
  }
  return [...names];
}

function readLogLines(workflow: string, dir: string): LogLine[] {
  const path = logFilePath(workflow, dateLocal(), dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogLine;
      } catch {
        return {} as LogLine;
      }
    });
}

/**
 * Build a Tier-1 delegation runtime: one real daemon per workflow against a
 * temp tracker root, with no browser (every daemon uses `stubLaunch()`). All
 * tracker JSONL, SQLite state, and daemon lockfiles land under `trackerDir` —
 * the real `.tracker/` is never touched.
 */
export async function createDelegationRuntime(
  opts: CreateDelegationRuntimeOpts,
): Promise<DelegationRuntime> {
  const trackerDir = mkdtempSync(join(tmpdir(), "hrauto-delegation-"));
  // Fresh registry + run-registry so a prior test's workflows / in-flight runs
  // don't leak into this runtime.
  clear();
  _resetRunRegistryForTests();
  // OCR approval signaling is process-local — reset the registry so an OCR
  // run from a prior runtime can't wake (or block) this one's subscriber.
  _resetApprovalSignalRegistryForTests();

  const coordinator = createGateCoordinator();

  // Register every workflow (build gated stubs from specs as needed) + record
  // its requested daemon-instance count.
  const workflows = new Map<string, DelegationWorkflow>();
  const instanceCounts = new Map<string, number>();
  for (const entry of opts.workflows) {
    const reg: WorkflowRegistration =
      "workflow" in entry ? entry : { workflow: entry };
    const wf =
      "config" in reg.workflow
        ? reg.workflow
        : makeGatedWorkflow(reg.workflow, coordinator);
    workflows.set(wf.config.name, wf);
    instanceCounts.set(wf.config.name, Math.max(1, reg.instances ?? 1));
  }

  // OCR stub: a thin test-only `"ocr"` daemon driving the REAL orchestrator with
  // stubbed LLM/roster/eid-lookup. Its records are seeded post-construction via
  // `stubOcr`, so the holder is shared with the workflow handler closure.
  const ocrState: StubOcrState = { records: [], roster: [] };
  if (opts.ocr) {
    const ocrWf = makeStubOcrWorkflow(ocrState, opts.ocr) as unknown as DelegationWorkflow;
    workflows.set(ocrWf.config.name, ocrWf);
    instanceCounts.set(ocrWf.config.name, 1);
  }

  // Start `instances` daemon(s) per workflow against the SAME temp trackerDir
  // (shared state.db; each daemon gets its own port + lockfile and races to
  // claim through SQLite). A single daemon's claim loop is serial — holding N
  // children of one workflow concurrently requires N racing daemons. Enqueue
  // happens later, so idle daemons wait for a wake/claim.
  const daemons: DaemonHandle[] = [];
  for (const wf of workflows.values()) {
    const count = instanceCounts.get(wf.config.name)!;
    const runPromises = Array.from({ length: count }, () =>
      runWorkflowDaemon(wf, {
        trackerDir,
        sessionLaunchFn: stubLaunch(),
        idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
        heartbeatIntervalMs: 40,
        commandPollIntervalMs: 40,
        lockHealIntervalMs: 100,
      }),
    );
    const ports = await waitForDaemons(wf.config.name, trackerDir, count);
    for (let i = 0; i < count; i++) {
      daemons.push({ workflow: wf.config.name, port: ports[i]!, runPromise: runPromises[i]! });
    }
  }

  const resolveWf = (workflow: DelegationWorkflow | string): DelegationWorkflow => {
    const name = typeof workflow === "string" ? workflow : workflow.config.name;
    const wf = workflows.get(name);
    if (!wf) throw new Error(`workflow '${name}' is not registered with this runtime`);
    return wf;
  };

  // ── enqueue ──────────────────────────────────────────────────────────────
  const enqueue: DelegationRuntime["enqueue"] = async (workflow, input, enqueueOpts) => {
    const wf = resolveWf(workflow);
    const item: GatedInput = {
      id: enqueueOpts?.itemId ?? input?.id ?? `item-${randomUUID().slice(0, 8)}`,
      ...(input ?? {}),
      // Mirror `withBatchMemberRuntimeOptions` — the real approve fan-out stamps
      // this so the daemon's pre-emit derives a `batch-member` archetype.
      ...(enqueueOpts?.renderAs === "batch"
        ? { __runtimeOptions: { rowShape: "batch-member" } }
        : {}),
    } as GatedInput;
    const runId = (enqueueOpts?.runId ?? randomUUID()) as UUID;
    const [enqueued] = await enqueueItems<GatedInput>(
      wf.config.name,
      [item],
      (d) => d.id,
      trackerDir,
      [runId],
      enqueueOpts?.parentRunId ? [enqueueOpts.parentRunId] : undefined,
    );
    // Wake every daemon instance of this workflow so one claims promptly
    // instead of waiting out the idle window. Best-effort — a missed wake just
    // means the next idle tick claims.
    await Promise.all(
      daemons
        .filter((d) => d.workflow === wf.config.name)
        .map((d) =>
          fetch(`http://127.0.0.1:${d.port}/wake`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).catch(() => undefined),
        ),
    );
    return { runId, itemId: enqueued!.id };
  };

  // ── waitForEvent ─────────────────────────────────────────────────────────
  const waitForEvent: DelegationRuntime["waitForEvent"] = (event, waitOpts) => {
    const want = waitOpts?.count ?? 1;
    const timeoutMs = waitOpts?.timeoutMs ?? 10_000;
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        let matches = 0;
        for (const name of listLogWorkflows(trackerDir)) {
          for (const line of readLogLines(name, trackerDir)) {
            if (line.event !== event) continue;
            if (waitOpts?.runId && line.runId !== waitOpts.runId) continue;
            if (waitOpts?.step && line.step !== waitOpts.step) continue;
            if (waitOpts?.occasion && line.occasion !== waitOpts.occasion) continue;
            if (waitOpts?.childWorkflow && line.childWorkflow !== waitOpts.childWorkflow) continue;
            matches++;
          }
        }
        if (matches >= want) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              `waitForEvent("${event}"${
                waitOpts ? " " + JSON.stringify(waitOpts) : ""
              }) timed out after ${timeoutMs}ms (saw ${matches}/${want})`,
            ),
          );
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  };

  // ── hold / release ───────────────────────────────────────────────────────
  const holdAll: DelegationRuntime["holdAll"] = (workflow, stage) => {
    coordinator.holdAll(resolveWf(workflow).config.name, stage);
  };
  const release: DelegationRuntime["release"] = (runId, stage) => {
    coordinator.release(runId, stage);
  };

  // ── cancel (REAL control-layer path) ─────────────────────────────────────
  // Drives the same handler the dashboard cancel button reaches:
  // `buildCancelRunningHandler` resolves the running task in SQLite (at this
  // temp trackerDir), flips it to cancel_requested, and enqueues a `cancel_task`
  // worker command. The owning daemon's poller picks it up → `requestCancel` →
  // `runRegistry.cancel(runId)` aborts the per-run AbortController → the held
  // stage's `ctx.signal` rejects → the stepper remaps it to a cancelled
  // terminal row.
  const cancel: DelegationRuntime["cancel"] = async (runId) => {
    // Find which workflow owns this run by scanning the latest row's workflow.
    const owner = findRunOwner(runId);
    if (!owner) {
      throw new Error(`cancel: no tracker row found for runId=${runId}`);
    }
    const r = await buildCancelRunningHandler(trackerDir)({
      workflow: owner,
      id: itemIdForRun(owner, runId) ?? runId,
      runId,
    });
    if (!r.ok) {
      throw new Error(`cancel(${runId}) rejected by control layer: ${r.error}`);
    }
  };

  const findRunOwner = (runId: string): string | undefined => {
    for (const name of listRowWorkflows()) {
      const rows = readTrackerRows(name);
      if (rows.some((row) => row.runId === runId)) return name;
    }
    return undefined;
  };

  const itemIdForRun = (workflow: string, runId: string): string | undefined => {
    for (const row of readTrackerRows(workflow)) {
      if (row.runId === runId) return row.id;
    }
    return undefined;
  };

  const readTrackerRows = (workflow: string): Array<{ id: string; runId?: string; parentRunId?: string }> => {
    const path = rowFilePath(workflow, dateLocal(), trackerDir);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; runId?: string; parentRunId?: string });
  };

  // Every workflow that has written a rows/ file — includes in-process
  // delegated children whose workflow isn't a registered daemon here.
  const listRowWorkflows = (): string[] => {
    const dir = rowsDir(trackerDir);
    if (!existsSync(dir)) return [];
    const names = new Set<string>();
    for (const file of readdirSync(dir)) {
      const parsed = parseWorkflowDateFilename(file);
      if (parsed) names.add(parsed.workflow);
    }
    return [...names];
  };

  // ── children ─────────────────────────────────────────────────────────────
  const children: DelegationRuntime["children"] = async (parentRunId) => {
    const out: Array<{ workflow: string; runId: string; itemId: string }> = [];
    const seen = new Set<string>();
    for (const name of listRowWorkflows()) {
      for (const row of readTrackerRows(name)) {
        if (row.parentRunId === parentRunId && row.runId && !seen.has(row.runId)) {
          seen.add(row.runId);
          out.push({ workflow: name, runId: row.runId, itemId: row.id });
        }
      }
    }
    return out;
  };

  // ── dashboard ────────────────────────────────────────────────────────────
  const dashboard: DelegationRuntime["dashboard"] = () => ({
    row: (workflow, runId) =>
      snapshotRow({ trackerDir, workflow, runId, workflowLabel: resolveLabel(workflow) }),
    groupAnchor: (workflow, parentRunId) =>
      snapshotGroupAnchor({ trackerDir, workflow, parentRunId, workflowLabel: resolveLabel(workflow) }),
    timeline: (workflow, runId) => readRowTimeline({ trackerDir, workflow, runId }),
  });
  const resolveLabel = (workflow: string): string =>
    workflows.get(workflow)?.config.label ?? workflow;

  // ── stubOcr / enqueueOcr / approveOcr (P2.9 seam) ────────────────────────
  const requireOcr = (method: string): void => {
    if (!opts.ocr) {
      throw new Error(
        `${method} requires the runtime to be created with the \`ocr\` option ` +
          `(createDelegationRuntime({ workflows, ocr: { formType } })).`,
      );
    }
  };

  // Seed the synthetic records the stub orchestrator returns. When the test
  // omits a roster, derive one row per record (EID→matched short-circuit) so the
  // oath form spec's `matchRecord` reaches `matched` without a live person-lookup.
  const stubOcr: DelegationRuntime["stubOcr"] = (records, roster) => {
    requireOcr("stubOcr");
    ocrState.records = records.map((r) => ({ ...r }));
    ocrState.roster = roster
      ? roster.map((r) => ({ ...r }))
      : records.map((r) => ({ eid: r.employeeId, name: r.printedName }));
  };

  const enqueueOcr: DelegationRuntime["enqueueOcr"] = async (enqueueOcrOpts) => {
    requireOcr("enqueueOcr");
    const originalName =
      enqueueOcrOpts.originalName ??
      enqueueOcrOpts.fixturePath.split("/").pop() ??
      "oaths.pdf";
    const { pdfFileId, pdfPath, usedFixture } = await registerOcrPdf({
      trackerDir,
      fixturePath: enqueueOcrOpts.fixturePath,
      originalName,
    });
    const sessionId = enqueueOcrOpts.sessionId ?? `ocr-sess-${randomUUID().slice(0, 8)}`;
    const runId = (enqueueOcrOpts.runId ?? randomUUID()) as UUID;
    const ocrInput: OcrInput = {
      pdfPath,
      pdfOriginalName: originalName,
      pdfFileId,
      formType: opts.ocr!.formType ?? "oath",
      sessionId,
      rosterPath: join(trackerDir, "uploads", "roster.xlsx"),
      rosterMode: "existing",
      ...(enqueueOcrOpts.parentRunId ? { parentRunId: enqueueOcrOpts.parentRunId } : {}),
    };
    // The orchestrator's `_loadRosterOverride` bypasses real parsing, but the
    // path must resolve to a non-empty string so the "no roster path" guard
    // doesn't trip — write an empty placeholder.
    const uploadsDir = join(trackerDir, "uploads");
    if (!existsSync(uploadsDir)) {
      // registerOcrPdf already mkdirs uploads on the synthetic path; ensure it
      // for the fixture path too.
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(uploadsDir, { recursive: true });
      } catch {
        /* best-effort */
      }
    }
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(ocrInput.rosterPath!, "");
    } catch {
      /* best-effort */
    }
    await enqueue("ocr", ocrInput as unknown as Partial<GatedInput> & { id?: string }, {
      runId,
      itemId: sessionId,
      ...(enqueueOcrOpts.parentRunId ? { parentRunId: enqueueOcrOpts.parentRunId } : {}),
    });
    return { sessionId, runId, usedFixture };
  };

  const approveOcr: DelegationRuntime["approveOcr"] = async (approveOcrOpts) => {
    requireOcr("approveOcr");
    const enqueuedChildren: ApprovedChild[] = [];
    const handler = buildOcrApproveHandler({
      trackerDir,
      // The real approve route resolves per-record itemIds + inputs via the form
      // spec; redirect the child enqueue onto the gated daemon so each becomes a
      // controllable, individually-cancellable child run. Returning `enqueued`
      // lets the route create dependency rows + the terminal OCR row.
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId, overrideOpts) => {
        const enqueued: Array<{ id: string; runId?: string }> = [];
        const isRegistered = workflows.has(workflow);
        for (let i = 0; i < inputs.length; i++) {
          const itemId = deriveItemId(inputs[i], i);
          if (isRegistered) {
            // Redirect onto the gated daemon → a controllable child run.
            const { runId: childRunId } = await enqueue(
              workflow,
              inputs[i] as unknown as Partial<GatedInput> & { id?: string },
              {
                itemId,
                ...(overrideOpts?.parentRunId ? { parentRunId: overrideOpts.parentRunId } : {}),
                renderAs: "batch",
              },
            );
            enqueued.push({ id: itemId, runId: childRunId });
            if (workflow === approveOcrOpts.childWorkflow) {
              enqueuedChildren.push({ itemId, runId: childRunId });
            }
          } else {
            // A fan-out target with no daemon in this runtime (e.g. the
            // once-per-document `oath-upload` ticket when only oath-signature is
            // under test). Pre-emit its pending row through the route's hook so
            // the projection still nests it, but don't try to claim it.
            const childRunId = randomUUID();
            overrideOpts?.onPreEmitPending?.(inputs[i], childRunId, overrideOpts.parentRunId, itemId);
            enqueued.push({ id: itemId, runId: childRunId });
          }
        }
        return { enqueued };
      },
    });
    const res = await handler({
      sessionId: approveOcrOpts.sessionId,
      runId: approveOcrOpts.runId,
      records: approveOcrOpts.records,
    });
    if (res.status !== 200) {
      throw new Error(
        `approveOcr: approve route returned ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    // The actual enqueue runs inside the approve route's BACKGROUND dispatch
    // IIFE, so `res` returns before children are enqueued. The synchronous
    // `fannedOut` response names the per-record targets; wait until the override
    // has enqueued exactly that many onto `childWorkflow` (no sleeps — poll the
    // captured handle).
    const body = res.body as { ok: true; fannedOut: Array<{ workflow: string; itemId: string }> };
    const expected = body.fannedOut.filter((f) => f.workflow === approveOcrOpts.childWorkflow).length;
    const start = Date.now();
    while (enqueuedChildren.length < expected) {
      if (Date.now() - start > 10_000) {
        throw new Error(
          `approveOcr: only ${enqueuedChildren.length}/${expected} ${approveOcrOpts.childWorkflow} children enqueued within 10s`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return enqueuedChildren;
  };

  // ── cleanup ──────────────────────────────────────────────────────────────
  let cleanedUp = false;
  const cleanup: DelegationRuntime["cleanup"] = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const d of daemons) {
      await fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    await Promise.allSettled(daemons.map((d) => d.runPromise));
    try {
      closeStateDbForTests(trackerDir);
    } catch {
      /* best-effort */
    }
    try {
      rmSync(trackerDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return {
    trackerDir,
    workflows,
    enqueue,
    waitForEvent,
    holdAll,
    release,
    cancel,
    children,
    dashboard,
    cleanup,
    stubOcr,
    enqueueOcr,
    approveOcr,
  };
}

export {
  createGateCoordinator,
  makeGatedWorkflow,
  type GateCoordinator,
  type GatedWorkflowSpec,
  type GatedInput,
} from "./scenario-handler.js";

/** Re-export for tests that progress-poll the queue directly. */
export { readQueueStateIncludingTerminals };
