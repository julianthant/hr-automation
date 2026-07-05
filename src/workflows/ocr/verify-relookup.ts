/**
 * Per-record, per-lookup re-run for `verify` OCR rows.
 *
 * The verify completeness report (`buildVerifyChecks`) fills each record from
 * TWO background lookups that run once during prep (`verify`'s `enrichRecords`
 * hook): **person-lookup** (name / EID / active status / CRM employment + oath
 * dates) and **i9-lookup** (the Section-2 "Authorized Official Signer"). When a
 * lookup comes back empty the check renders as `missing` ("— not found"), and
 * the operator can re-run JUST that one lookup for JUST that one record from the
 * review pane (`/api/ocr/verify-relookup`).
 *
 * This mirrors a single step of `verify.ts`'s `enrichRecords` (and the emit
 * shape of `force-research.ts`): load the OCR row → re-fan the one child →
 * `watchChildRuns` → patch the record with the verify pure helpers →
 * `buildVerifyChecks` → re-emit the terminal `done`/person-lookup review row.
 * (A standalone verify run completes `done` at person-lookup — there is no
 * awaiting-approval gate — so the relookup re-OPENS that done row, runs the one
 * lookup, and settles it back to `done`.) It is the verify analogue of
 * force-research, which is person-lookup-only and drops the EID; here we keep
 * the resolved identity and target either underlying lookup.
 */
import { randomUUID } from "node:crypto";
import { dateLocal } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { fanOutAndWatch } from "../../services/ocr/fan-out.js";
import { emitOcrReviewSnapshot } from "../../services/ocr/review-snapshot.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../services/ocr/eid-lookup-results.js";
import {
  applyI9ToVerifyRecord,
  applyPersonLookupToVerifyRecord,
  buildVerifyChecks,
  type VerifyPreviewRecord,
} from "../../services/ocr/forms/verify.js";
import { parsePersonOrgNameInput } from "../../systems/ucpath/person-org-summary.js";
import { readQueueTitle } from "../../domain/queue-title.js";
import { tracePrefix } from "../../domain/queue-trace-id.js";
import { log } from "../../utils/log.js";

const WORKFLOW = "ocr";

/** Which background lookup to re-run for the targeted verify record. */
export type VerifyRelookupKind = "person" | "i9";

export interface VerifyRelookupInput {
  sessionId: string;
  runId: string;
  /** Index into the row's `data.records` array. */
  recordIndex: number;
  lookup: VerifyRelookupKind;
}

export interface VerifyRelookupOpts {
  /** Tracker directory override. Default: `.tracker`. */
  trackerDir?: string;
  // ─── Test escape hatches (mirror force-research.ts) ──────────
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueOverride?: (itemId: string, input: unknown) => Promise<void>;
}

/** Trim to a non-empty string, or null. Local copy of verify.ts's helper. */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

export async function runVerifyRelookup(
  input: VerifyRelookupInput,
  trackerDirOrOpts?: string | VerifyRelookupOpts,
): Promise<void> {
  const opts: VerifyRelookupOpts =
    typeof trackerDirOrOpts === "string"
      ? { trackerDir: trackerDirOrOpts }
      : (trackerDirOrOpts ?? {});
  const trackerDir = opts.trackerDir;
  const date = dateLocal();

  const latest = findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir,
    lookbackDays: 7,
    predicate: (e) => e.id === input.sessionId && e.runId === input.runId,
  });
  if (!latest) throw new Error("OCR row not found in JSONL");
  const formType = latest.data?.formType;
  if (formType !== "verify") {
    throw new Error(`verify-relookup only applies to verify rows (got formType "${String(formType)}")`);
  }

  const records: VerifyPreviewRecord[] = JSON.parse(
    (latest.data?.records as unknown as string) ?? "[]",
  );
  const recs = records as unknown[];
  const idx = input.recordIndex;
  const rec = records[idx];
  if (!rec) throw new Error(`No record at index ${idx}`);

  const name = nonEmpty(rec.name) ?? nonEmpty(rec.printedName);
  if (!name) throw new Error("Record has no name to look up");

  // Trace propagation: descendants share the OCR root's prefix (see the
  // root-trace-id lesson). Derive it from the row's frozen `__traceId`.
  const frozenTraceId = nonEmpty(latest.data?.__traceId);
  const rootTracePrefix = frozenTraceId ? tracePrefix(frozenTraceId) : undefined;
  const parentSubject =
    readQueueTitle(latest.data) ??
    (latest.data?.parentSubject);

  // Fresh per-invocation itemId so `watchChildRuns` waits for THIS re-run and
  // never matches a stale completed child from the initial enrichment (whose
  // ids were `ocr-verify-…` / `ocr-verify-i9-…`).
  const nonce = randomUUID().slice(0, 8);
  const itemId = `ocr-verify-relook-${input.lookup}-${input.runId}-r${idx}-${nonce}`;

  // ── Intermediate: mark the row running so the queue/session show activity ──
  emitRelookupRow(input, latest, records, trackerDir, "running");

  if (input.lookup === "person") {
    await runPersonRelookup({
      input,
      idx,
      name,
      itemId,
      parentSubject,
      rootTracePrefix,
      trackerDir,
      date,
      records,
      recs,
      opts,
    });
  } else {
    if (rec.formKind !== "oath") {
      throw new Error(`i9 relookup only applies to oath records (got "${String(rec.formKind)}")`);
    }
    await runI9Relookup({
      input,
      idx,
      name,
      itemId,
      parentSubject,
      rootTracePrefix,
      trackerDir,
      date,
      records,
      opts,
    });
  }

  // Recompute the targeted record's checks from the freshly patched values.
  records[idx].checks = buildVerifyChecks(records[idx]);

  // Final re-emit: a standalone verify run is terminal `done` at person-lookup
  // (no awaiting-approval gate). Re-open as running then settle `done` so the ↻
  // keeps spinning until the patched records land on the terminal row.
  emitRelookupRow(input, latest, records, trackerDir, "running", "person-lookup");
  emitRelookupRow(input, latest, records, trackerDir, "done", "person-lookup");
}

async function runPersonRelookup(ctx: {
  input: VerifyRelookupInput;
  idx: number;
  name: string;
  itemId: string;
  parentSubject?: string;
  rootTracePrefix?: string;
  trackerDir?: string;
  date: string;
  records: VerifyPreviewRecord[];
  recs: unknown[];
  opts: VerifyRelookupOpts;
}): Promise<void> {
  const { input, idx, name, itemId, parentSubject, rootTracePrefix, trackerDir, date, records, recs, opts } = ctx;
  type PersonLookupChildInput = {
    name: string;
    includeCrmDates: true;
    keepNonHdh: true;
    taskGroupId: string;
    parentSubject?: string;
  };
  const childInput: PersonLookupChildInput = {
    name,
    includeCrmDates: true,
    keepNonHdh: true,
    taskGroupId: input.sessionId,
    ...(parentSubject ? { parentSubject } : {}),
  };

  const { personLookupWorkflow } = await import("../person-lookup/index.js");
  // Shared dispatch→watch→cascade-cancel pipeline (BM-1). The HTTP test seams
  // (`_enqueueOverride`/`_watchChildRunsOverride`) map to fanOutAndWatch's
  // dispatch/watch overrides; the cascade-cancel on operator discard-abort lives
  // in fanOutAndWatch.
  const { byItemId } = await fanOutAndWatch<PersonLookupChildInput>({
    sessionId: input.sessionId,
    runId: input.runId,
    parentRunId: input.runId,
    trackerDir,
    date,
    child: personLookupWorkflow as never,
    children: [{ input: childInput, itemId }],
    timeoutMs: 30 * 60_000,
    ...(rootTracePrefix ? { rootTracePrefix } : {}),
    ...(opts._enqueueOverride
      ? { dispatch: async () => opts._enqueueOverride!(itemId, childInput) }
      : {}),
    ...(opts._watchChildRunsOverride ? { watch: opts._watchChildRunsOverride } : {}),
  });

  const outcome = byItemId.get(itemId);
  if (outcome) {
    patchOcrRecordFromEidLookupOutcome(recs, idx, outcome, "name");
    applyPersonLookupToVerifyRecord(records[idx], outcome.data);
  } else {
    patchOcrRecordUnresolved(recs, idx, "person-lookup timed out without a result");
  }
}

async function runI9Relookup(ctx: {
  input: VerifyRelookupInput;
  idx: number;
  name: string;
  itemId: string;
  parentSubject?: string;
  rootTracePrefix?: string;
  trackerDir?: string;
  date: string;
  records: VerifyPreviewRecord[];
  opts: VerifyRelookupOpts;
}): Promise<void> {
  const { input, idx, name, itemId, parentSubject, rootTracePrefix, trackerDir, date, records, opts } = ctx;
  let parsed: { lastName: string; first: string };
  try {
    parsed = parsePersonOrgNameInput(name);
  } catch (err) {
    throw new Error(`Cannot parse name "${name}" for I-9 lookup`, { cause: err });
  }
  if (!parsed.lastName || !parsed.first) {
    throw new Error(`Name "${name}" is missing a first or last name for I-9 lookup`);
  }

  type I9ChildInput = { lastName: string; firstName: string; parentSubject?: string };
  const childInput: I9ChildInput = {
    lastName: parsed.lastName,
    firstName: parsed.first,
    ...(parentSubject ? { parentSubject } : {}),
  };

  const { i9LookupWorkflow } = await import("../i9-lookup/index.js");
  // Shared dispatch→watch→cascade-cancel pipeline (BM-1). The watched workflow is
  // i9-lookup (not the default child name), so pass it explicitly.
  const { byItemId } = await fanOutAndWatch<I9ChildInput>({
    sessionId: input.sessionId,
    runId: input.runId,
    parentRunId: input.runId,
    trackerDir,
    date,
    child: i9LookupWorkflow as never,
    watchWorkflow: "i9-lookup",
    children: [{ input: childInput, itemId }],
    timeoutMs: 30 * 60_000,
    ...(rootTracePrefix ? { rootTracePrefix } : {}),
    ...(opts._enqueueOverride
      ? { dispatch: async () => opts._enqueueOverride!(itemId, childInput) }
      : {}),
    ...(opts._watchChildRunsOverride ? { watch: opts._watchChildRunsOverride } : {}),
  });

  const outcome = byItemId.get(itemId);
  if (outcome) {
    applyI9ToVerifyRecord(records[idx], outcome.data);
  } else {
    log.warn(`[verify/relookup] i9 lookup for record ${idx} timed out without a result`);
  }
}

/**
 * Re-emit the OCR prep row carrying the (possibly patched) records via the
 * shared OCR preview-row envelope (BM-5), so the dashboard resolves the row by
 * archetype/__id/__name/parentSubject/parentRunId rather than whatever the
 * latest row happened to carry.
 */
function emitRelookupRow(
  input: VerifyRelookupInput,
  latest: { data?: Record<string, unknown>; parentRunId?: string },
  records: VerifyPreviewRecord[],
  trackerDir: string | undefined,
  status: "running" | "done",
  step: "verify-relookup" | "person-lookup" = "verify-relookup",
): void {
  const parentRunId =
    (latest.data?.parentRunId as string | undefined) ?? latest.parentRunId;
  const parentSubject =
    readQueueTitle(latest.data) ??
    (latest.data?.parentSubject as string | undefined);
  emitOcrReviewSnapshot({
    base: { ...(latest.data ?? {}) },
    sessionId: input.sessionId,
    runId: input.runId,
    records,
    status,
    step,
    parent: {
      ...(parentRunId ? { parentRunId } : {}),
      ...(parentSubject ? { parentSubject } : {}),
    },
    trackerDir,
  });
}
