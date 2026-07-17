/**
 * I-9 check member fan-out — the daemon half of the "Run I-9 Check" operation
 * flow (rev. 2026-07-16: REAL member tasks, not display rows; rev. 2026-07-17:
 * the tasks run in the dedicated `i9-check` workflow, split out of the
 * separations daemon).
 *
 * An i9 OCR run launched from the I-9 Check panel is delegated under an
 * `i9-check` operation coordinator row (one per uploaded PDF). The i9 form
 * spec has NO approve flow (`completeDelegatedRun`), so when the run completes
 * — right after Section 2 corroboration + the roster NAME match — the prepare
 * route calls `enqueueI9CheckMemberTasks` to enqueue one REAL i9-check daemon
 * task per person (see `src/workflows/i9-check/schema.ts`). Each task searches
 * UCPath (one UCPath browser per daemon), re-matches the Action History roster
 * by the resolved EID, stamps the found/not-found verdict on its own member
 * row, and appends one row to the master retention tracker
 * (`src/tracker/exports/i9-check-tracker.ts`).
 *
 * Pages that can never be searched (no legible name anywhere) still become
 * DISPLAY-ONLY failed rows (`data.displayOnly === "true"`) — a person the
 * packet names but cannot check must fail loud, not vanish; those rows have no
 * task, so `isDisplayOnlyRow` strips retry/cancel/bump.
 *
 * The member pre-emit deliberately carries NO `input:` block and no SSN in
 * `data` — SQLite `tasks.original_input_json` is the replay authority.
 */
import { randomUUID, type UUID } from "node:crypto";
import { z } from "zod/v4";
import { appendLogEntry, emitTrackerRow } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { tracePrefix } from "../../../domain/queue-trace-id.js";
import { runOptionsToDaemonFlags, type RunOptions } from "../../../domain/run-options.js";
import type { DaemonFlags } from "../../../core/daemon/types.js";
import { getTimekeeperName } from "../../../config.js";
import { displayPersonName } from "../../../domain/identity/person-name.js";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import {
  I9PreviewRecordSchema,
  buildI9DisplayName,
  buildI9PersonMatchInput,
  normalizeI9Dob,
  type I9PreviewRecord,
} from "../../../services/ocr/forms/i9.js";
import type { I9CheckMemberInput } from "../../../workflows/i9-check/schema.js";
import { buildFanOutItemIdResolver } from "./approve.js";
import {
  composeFanOutMemberTraceId,
  withMemberShapeRuntimeOption,
  withRootTracePrefixRuntimeOption,
} from "./fan-out-runtime-options.js";

const I9RecordsSchema = z.array(I9PreviewRecordSchema);

/** One log line for a member row (emitted against that row's own runId). */
export interface I9CheckMemberLog {
  level: "step" | "success" | "warn" | "error";
  message: string;
}

/** A page that can never be checked — surfaced as a display-only failed row. */
export interface I9CheckDisplayFailure {
  /** Index of the source record in the OCR run's `records` array. */
  index: number;
  name: string;
  error: string;
  logs: I9CheckMemberLog[];
}

/** One REAL i9-check member task planned from an i9 preview record. */
export interface I9CheckMemberTaskPlan {
  input: I9CheckMemberInput;
  itemId: string;
  /** Curated pending-row data — never the SSN, never the raw input. */
  seedData: Record<string, string>;
  /** OCR-provenance log lines written against the pending member row. */
  logs: I9CheckMemberLog[];
}

export interface I9CheckMemberPlan {
  tasks: I9CheckMemberTaskPlan[];
  displayFailures: I9CheckDisplayFailure[];
}

function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * The provenance an operator needs to JUDGE the eventual verdict — above all,
 * the criteria the search will rest on. A UCPath "not found" is only as good
 * as the OCR that fed it (live 2026-07-13: 17 of 29 scanned Section 1s had at
 * least one wrong field), so every row states what will be searched, never
 * just the answer. The SSN is NEVER logged — only whether one was supplied.
 */
function buildProvenanceLogs(
  rec: I9PreviewRecord,
  name: string,
  searchCriteria?: { ssn: boolean; dob: string | null },
): I9CheckMemberLog[] {
  const logs: I9CheckMemberLog[] = [];
  logs.push({
    level: "step",
    message: rec.orphanSection2
      ? `Employer Section 2 sheet read from page ${rec.sourcePage} — name "${name}" (its Section 1 page is missing from the packet)`
      : `I-9 Section 1 read from page ${rec.sourcePage} — name "${name}"`
        + (rec.extractedBy ? ` (extracted by ${rec.extractedBy})` : ""),
  });

  // The corroboration line is the one that tells the operator whether to
  // believe any of this.
  if (rec.corroboration === "confirmed") {
    logs.push({
      level: "step",
      message: "Cross-checked against the employer's Section 2 sheet — the two readings agree.",
    });
  } else if (rec.corroboration === "disputed") {
    logs.push({
      level: "warn",
      message:
        `DISPUTED by the employer's Section 2 sheet on: ${rec.disputedFields.join(", ")}. `
        + `The disputed field(s) will NOT be used to search UCPath.`,
    });
  } else if (rec.formKind === "i9") {
    logs.push({
      level: "step",
      message: "No Section 2 sheet found for this person — the read could not be cross-checked.",
    });
  }
  if (rec.illegible.length > 0) {
    logs.push({
      level: "warn",
      message:
        `Not legible on the scan, so left EMPTY rather than guessed: ${rec.illegible.join(", ")}. `
        + `A guessed digit would have searched UCPath for the wrong person.`,
    });
  }

  if (searchCriteria) {
    logs.push({
      level: "step",
      message:
        `UCPath search criteria: name "${name}", `
        + `DOB ${searchCriteria.dob ?? "(not used)"}, `
        + `SSN ${searchCriteria.ssn ? "supplied" : "(not used)"} `
        + `— a wrong digit in ANY of these returns "no results", which reads the same as a real absence. `
        + `The search runs as this row's i9-check task.`,
    });
  }
  for (const note of rec.notes) logs.push({ level: "step", message: `OCR note: ${note}` });
  for (const warning of rec.warnings) logs.push({ level: "warn", message: `OCR warning: ${warning}` });
  if (rec.originallyMissing.length > 0) {
    logs.push({
      level: "warn",
      message: `Section 1 fields genuinely blank on the paper: ${rec.originallyMissing.join(", ")}`,
    });
  }
  return logs;
}

/** Roster seed (from the OCR stage's NAME match) for the member input. */
function rosterSeed(rec: I9PreviewRecord): I9CheckMemberInput["roster"] {
  const seed: NonNullable<I9CheckMemberInput["roster"]> = {
    ...(rec.ppsEid ? { ppsEid: rec.ppsEid } : {}),
    ...(rec.ppsEidPadded ? { ppsEidPadded: rec.ppsEidPadded } : {}),
    ...(rec.rosterEmplId ? { emplId: rec.rosterEmplId } : {}),
    ...(rec.i9SeparationDate ? { separationDate: rec.i9SeparationDate } : {}),
  };
  return Object.keys(seed).length > 0 ? seed : undefined;
}

/**
 * Project the run's enriched records onto the member-task plan. Pure —
 * unit-tested.
 *
 * Skips only the expected filler pages of a scanned packet (non-Section-1
 * pages with no person). Every page that named a person — or SHOULD have —
 * yields either a real task or a loud display failure, never silence.
 */
export function buildI9CheckMemberPlan(
  records: I9PreviewRecord[],
  ctx: { sessionId: string; ocrRunId: string },
): I9CheckMemberPlan {
  const tasks: I9CheckMemberTaskPlan[] = [];
  const displayFailures: I9CheckDisplayFailure[] = [];

  for (let index = 0; index < records.length; index++) {
    const rec = records[index];
    const itemId = `i9-check-${ctx.sessionId}-r${index}`;

    // An orphan Section 2 — the employer verified this person but their
    // Section 1 page is missing. The employer's name line is still a
    // searchable identity, so the person gets a REAL name-only check.
    if (rec.orphanSection2) {
      // Normalize the employer's hand-printed name line to the standard
      // "Last, First" title-cased display convention (matches buildI9DisplayName).
      const rawSection2Name = nonEmpty(rec.section2Name);
      const name = rawSection2Name ? displayPersonName(rawSection2Name) : null;
      if (!name) {
        const failure: I9CheckDisplayFailure = {
          index,
          name: `Page ${rec.sourcePage} — Section 2, unreadable name`,
          error:
            `A Section 2 sheet on page ${rec.sourcePage} has no Section 1 page in the packet AND its `
            + `name line could not be read — this person cannot be checked. Verify the scan.`,
          logs: [],
        };
        failure.logs = buildProvenanceLogs(rec, failure.name);
        displayFailures.push(failure);
        continue;
      }
      const hire = nonEmpty(rec.section2HireDate);
      tasks.push({
        itemId,
        input: {
          mode: "i9-check",
          person: {
            name,
            ...(hire ? { hireDate: normalizeI9Dob(hire) ?? hire } : {}),
            section2Page: rec.sourcePage,
            orphanSection2: true,
          },
          ...(rosterSeed(rec) ? { roster: rosterSeed(rec) } : {}),
          ocrSessionId: ctx.sessionId,
          ocrRunId: ctx.ocrRunId,
          recordIndex: index,
        },
        seedData: buildSeedData(rec, name, ctx, { orphan: true }),
        logs: [
          ...buildProvenanceLogs(rec, name, { ssn: false, dob: null }),
          {
            level: "warn",
            message:
              `The Section 1 page for this person is MISSING from the packet (Section 2 is on page `
              + `${rec.sourcePage}) — the UCPath check runs on the employer's name line alone. `
              + `Locate the missing Section 1 page.`,
          },
        ],
      });
      continue;
    }

    if (rec.formKind !== "i9") {
      // Expected filler page (claimed Section 2 sheets, Lists of Acceptable
      // Documents, blanks) — not a person, not an error.
      continue;
    }

    const name = nonEmpty(rec.name) ?? (buildI9DisplayName(rec) || null);
    const pmInput = buildI9PersonMatchInput(rec, {});
    if (!name && !pmInput) {
      // An i9-classified page whose Section 1 could not be read at all —
      // a person the packet holds but we cannot check. Fail loud.
      const failure: I9CheckDisplayFailure = {
        index,
        name: `Page ${rec.sourcePage} — unreadable Section 1`,
        error:
          `Section 1 on page ${rec.sourcePage} could not be read (no legible name) — this person `
          + `cannot be checked against UCPath. Verify the scan and re-upload.`,
        logs: [],
      };
      failure.logs = buildProvenanceLogs(rec, failure.name);
      displayFailures.push(failure);
      continue;
    }

    const displayName = name ?? displayPersonName(`${pmInput!.lastName}, ${pmInput!.firstName}`);
    tasks.push({
      itemId,
      input: {
        mode: "i9-check",
        person: {
          name: displayName,
          ...(nonEmpty(rec.lastName) ? { lastName: nonEmpty(rec.lastName)! } : {}),
          ...(nonEmpty(rec.firstName) ? { firstName: nonEmpty(rec.firstName)! } : {}),
          ...(nonEmpty(rec.middleInitial) ? { middleInitial: nonEmpty(rec.middleInitial)! } : {}),
          ...(pmInput?.ssn ? { ssn: pmInput.ssn } : {}),
          ...(pmInput?.dob ? { dob: pmInput.dob } : {}),
          ...(nonEmpty(rec.hireDate) ? { hireDate: nonEmpty(rec.hireDate)! } : {}),
          sourcePage: rec.sourcePage,
          ...(rec.section2Page !== undefined ? { section2Page: rec.section2Page } : {}),
        },
        ...(rosterSeed(rec) ? { roster: rosterSeed(rec) } : {}),
        ocrSessionId: ctx.sessionId,
        ocrRunId: ctx.ocrRunId,
        recordIndex: index,
      },
      seedData: buildSeedData(rec, displayName, ctx, { orphan: false }),
      logs: buildProvenanceLogs(rec, displayName, {
        ssn: Boolean(pmInput?.ssn),
        dob: pmInput?.dob ?? null,
      }),
    });
  }
  return { tasks, displayFailures };
}

function buildSeedData(
  rec: I9PreviewRecord,
  name: string,
  ctx: { sessionId: string; ocrRunId: string },
  opts: { orphan: boolean },
): Record<string, string> {
  return {
    i9Check: "true",
    name,
    ...(rec.ppsEid ? { ppsEid: rec.ppsEid } : {}),
    ...(rec.i9SeparationDate ? { separationDate: rec.i9SeparationDate } : {}),
    ...(nonEmpty(rec.hireDate) || opts.orphan
      ? { i9HireDate: nonEmpty(rec.hireDate) ?? nonEmpty(rec.section2HireDate) ?? "" }
      : {}),
    section1Present: opts.orphan ? "Missing" : `Yes — page ${rec.sourcePage}`,
    section2Present: opts.orphan
      ? `Yes — page ${rec.sourcePage}`
      : rec.section2Page !== undefined
        ? `Yes — page ${rec.section2Page}`
        : "Missing",
    ocrSessionId: ctx.sessionId,
    ocrRunId: ctx.ocrRunId,
    __subject: name,
    __subjectKind: "person",
  };
}

export interface EnqueueI9CheckMemberTasksArgs {
  /** OCR session id — resolves the finished run's records row. */
  sessionId: string;
  /** The completed OCR run's id. */
  ocrRunId: string;
  /** The i9-check operation coordinator the members nest under. */
  operation: {
    workflow: string;
    runId: string;
    /** Coordinator trace id — members compose its prefix with their own tail. */
    traceId: string;
  };
  /** Operator run options (Automation workers) from the upload modal. */
  runOptions?: RunOptions | undefined;
  trackerDir?: string | undefined;
  /** Test seam — mirrors approve.ts's override. */
  ensureDaemonsAndEnqueueOverride?: (
    wf: unknown,
    inputs: unknown[],
    flags: DaemonFlags,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface I9CheckFanOutSummary {
  enqueued: number;
  displayFailed: number;
}

/**
 * Read the completed i9 OCR run's records and enqueue one REAL i9-check
 * i9-check member task per person under the coordinator (plus display-only
 * failed rows for the never-searchable pages).
 *
 * Throws (fail loud) when the finished run's records can't be found or don't
 * parse, or when the operator identity (TIMEKEEPER_NAME → the tracker's
 * Reviewer Name) is unset — the caller surfaces that on the coordinator row
 * instead of leaving a silently empty operation.
 */
export async function enqueueI9CheckMemberTasks(
  args: EnqueueI9CheckMemberTasksArgs,
): Promise<I9CheckFanOutSummary> {
  const { sessionId, ocrRunId, operation, trackerDir } = args;
  const row = findLatestEntryForPredicate({
    workflow: "ocr",
    ...(trackerDir !== undefined ? { trackerDir } : {}),
    lookbackDays: 2,
    predicate: (e) =>
      e.id === sessionId && e.runId === ocrRunId && typeof e.data?.records === "string",
  });
  if (!row) {
    throw new Error(
      `I-9 check fan-out: no records row found for completed OCR run ${ocrRunId} (session ${sessionId}) — cannot enqueue i9-check member tasks`,
    );
  }
  const parsed = I9RecordsSchema.safeParse(JSON.parse(row.data!.records));
  if (!parsed.success) {
    throw new Error(
      `I-9 check fan-out: records on OCR run ${ocrRunId} (session ${sessionId}) failed to parse: ${parsed.error.message}`,
    );
  }

  // Validate the operator identity BEFORE any enqueue — every member task
  // appends a tracker row whose Reviewer Name is the timekeeper name, and a
  // missing value should fail the fan-out legibly, not each member mid-run.
  try {
    getTimekeeperName();
  } catch (err) {
    throw new Error(
      `I-9 check fan-out: operator identity is not set — set TIMEKEEPER_NAME (Settings → General); ` +
        `it becomes the retention tracker's Reviewer Name. (${errorMessage(err)})`,
      { cause: err },
    );
  }

  const plan = buildI9CheckMemberPlan(parsed.data, { sessionId, ocrRunId });
  const rootPrefix = tracePrefix(operation.traceId);

  // Display-only failures first — they exist regardless of the enqueue.
  for (const failure of plan.displayFailures) {
    emitDisplayFailureRow(failure, { sessionId, ocrRunId, operation, trackerDir, rootPrefix });
  }

  if (plan.tasks.length > 0) {
    const runIds: UUID[] = plan.tasks.map(() => randomUUID());
    const logicalInputs = plan.tasks.map((t) => t.input);
    const wrappedInputs = logicalInputs.map((input) =>
      withMemberShapeRuntimeOption(
        withRootTracePrefixRuntimeOption(input, rootPrefix),
        "operation-member",
      ),
    );
    const deriveItemId = buildFanOutItemIdResolver(
      logicalInputs,
      plan.tasks.map((t) => t.itemId),
      "i9-check",
    );
    const planByItemId = new Map(plan.tasks.map((t) => [t.itemId, t]));
    const daemonFlags = runOptionsToDaemonFlags(args.runOptions);

    const onPreEmitPending = (
      _item: unknown,
      childRunId: string,
      passedParentRunId: string | undefined,
      itemId: string,
    ): void => {
      const task = planByItemId.get(itemId);
      const memberTraceId = composeFanOutMemberTraceId(rootPrefix, childRunId);
      emitTrackerRow(
        {
          workflow: operation.workflow,
          timestamp: new Date().toISOString(),
          id: itemId,
          runId: childRunId,
          status: "pending",
          data: {
            archetype: "operation-member",
            queueRowKind: "person",
            __id: itemId,
            ...(task ? task.seedData : {}),
            ...(memberTraceId ? { __traceId: memberTraceId } : {}),
          },
          // Deliberately NO `input:` block (deviates from approve.ts): the
          // SQLite task's original_input_json is the replay authority, and the
          // i9 input carries the person's SSN — it must not ride a JSONL row.
          ...(passedParentRunId ?? operation.runId
            ? { parentRunId: passedParentRunId ?? operation.runId }
            : {}),
        },
        trackerDir,
      );
      for (const line of task?.logs ?? []) {
        appendLogEntry(
          {
            workflow: operation.workflow,
            itemId,
            runId: childRunId,
            level: line.level,
            message: line.message,
            ts: new Date().toISOString(),
          },
          trackerDir,
        );
      }
    };

    const enqueueOpts = {
      trackerDir,
      deriveItemId,
      runIds,
      existingTaskPolicy: "idempotent",
      parentRunId: operation.runId,
      onPreEmitPending,
    };
    if (args.ensureDaemonsAndEnqueueOverride) {
      await args.ensureDaemonsAndEnqueueOverride(
        { name: "i9-check" },
        wrappedInputs,
        daemonFlags,
        enqueueOpts,
      );
    } else {
      const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
      const i9Wf = await loadWorkflow("i9-check");
      if (!i9Wf) {
        throw new Error("I-9 check fan-out: i9-check workflow could not be loaded");
      }
      const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
      await ensureDaemonsAndEnqueue(i9Wf, wrappedInputs as never, daemonFlags, enqueueOpts as never);
    }
  }

  log.success(
    `[i9-check] fan-out complete — ${plan.tasks.length} member task(s) enqueued to i9-check, `
      + `${plan.displayFailures.length} unsearchable page(s) surfaced as failed rows (session ${sessionId}). `
      + `Each member appends one row to the master I-9 retention tracker; a re-run appends again.`,
  );
  return { enqueued: plan.tasks.length, displayFailed: plan.displayFailures.length };
}

function emitDisplayFailureRow(
  failure: I9CheckDisplayFailure,
  ctx: {
    sessionId: string;
    ocrRunId: string;
    operation: { workflow: string; runId: string; traceId: string };
    trackerDir?: string | undefined;
    rootPrefix: string | undefined;
  },
): void {
  const memberRunId = randomUUID();
  const memberItemId = `i9-check-${ctx.sessionId}-r${failure.index}`;
  emitTrackerRow(
    {
      workflow: ctx.operation.workflow,
      timestamp: new Date().toISOString(),
      id: memberItemId,
      runId: memberRunId,
      parentRunId: ctx.operation.runId,
      status: "failed",
      step: "i9-check",
      data: {
        archetype: "operation-member",
        queueRowKind: "person",
        i9Check: "true",
        // No daemon task backs this row — nothing is searchable. Suppresses
        // retry/cancel/bump in the queue footer (a reconstructed
        // retry would start a REAL termination run — see `isDisplayOnlyRow`);
        // delete stays available.
        displayOnly: "true",
        name: failure.name,
        ocrSessionId: ctx.sessionId,
        ocrRunId: ctx.ocrRunId,
        __id: memberItemId,
        __subject: failure.name,
        __subjectKind: "person",
        ...(composeFanOutMemberTraceId(ctx.rootPrefix, memberRunId)
          ? { __traceId: composeFanOutMemberTraceId(ctx.rootPrefix, memberRunId)! }
          : {}),
      },
      error: failure.error,
    },
    ctx.trackerDir,
  );
  for (const line of failure.logs) {
    appendLogEntry(
      {
        workflow: ctx.operation.workflow,
        itemId: memberItemId,
        runId: memberRunId,
        level: line.level,
        message: line.message,
        ts: new Date().toISOString(),
      },
      ctx.trackerDir,
    );
  }
  appendLogEntry(
    {
      workflow: ctx.operation.workflow,
      itemId: memberItemId,
      runId: memberRunId,
      level: "error",
      message: failure.error,
      ts: new Date().toISOString(),
    },
    ctx.trackerDir,
  );
}
