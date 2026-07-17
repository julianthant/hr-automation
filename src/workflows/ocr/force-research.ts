/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { emitTrackerRow, dateLocal } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { fanOutAndWatch } from "../../services/ocr/fan-out.js";
import { emitOcrReviewSnapshot } from "../../services/ocr/review-snapshot.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../services/ocr/eid-lookup-results.js";
import { readQueueTitle } from "../../domain/queue-title.js";

const WORKFLOW = "ocr";

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}

export interface ForceResearchOpts {
  /** Tracker directory override. Default: `.tracker`. */
  trackerDir?: string;
  // ─── Test escape hatches ──────────────────────────────
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueOverride?: (itemIds: string[], inputs: unknown[]) => Promise<void>;
}

export async function runForceResearch(input: ForceResearchInput, trackerDirOrOpts?: string | ForceResearchOpts): Promise<void> {
  const opts: ForceResearchOpts = typeof trackerDirOrOpts === "string"
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
  if (!formType) throw new Error("formType missing on OCR row");
  // Hard-reject verify rows (N4). force-research is the oath/EC re-research path:
  // it CLEARS employeeId, re-fans person-lookup by NAME, and patches via
  // `patchOcrRecordFromEidLookupOutcome` only — it never calls
  // `applyPersonLookupToVerifyRecord`, never rebuilds `checks[]`, and drops
  // `paperEmployeeId`. Running it on a verify record corrupts the completeness
  // report. The verify analogue is `verify-relookup` (re-runs ONE lookup per
  // record + rebuilds checks); the dashboard routes verify rows there. Mirror
  // verify-relookup's inverse guard (`formType !== "verify"`).
  if (formType === "verify") {
    throw new Error(
      'force-research does not apply to verify rows — use verify-relookup (per-check ↻) instead',
    );
  }
  // i9 is read-only like verify: its records are enriched by the person-match
  // fan-out in the spec's `enrichRecords`, not the oath/EC name-lookup pipeline
  // force-research replays. Re-running it here would clear identity fields and
  // corrupt the report — re-upload/re-OCR is the i9 re-run path.
  if (formType === "i9") {
    throw new Error(
      "force-research does not apply to i9 rows — re-upload or re-OCR the PDF instead",
    );
  }
  const spec = getFormSpec(formType);
  if (!spec) throw new Error(`Unknown formType "${formType}"`);

  const records = JSON.parse((latest.data?.records as unknown as string) ?? "[]") as unknown[];
  const itemIds: string[] = [];
  const enqueueInputs: Array<{ name: string }> = [];
  // Map itemId → index into records[] for outcome patching.
  const itemIdToRecordIdx = new Map<string, number>();

  for (const idx of input.recordIndices) {
    const r = records[idx] as Record<string, unknown>;
    if (!r) continue;
    if ("employee" in r) {
      const e = r.employee as Record<string, unknown>;
      e.employeeId = "";
    } else {
      r.employeeId = "";
    }
    r.matchState = "lookup-pending";
    r.matchSource = null;
    r.matchConfidence = null;
    r.verification = null;
    r.forceResearch = true;
    const itemId = `ocr-force-${input.runId}-r${idx}`;
    itemIds.push(itemId);
    itemIdToRecordIdx.set(itemId, idx);
    const name = spec.carryForwardKey(r);
    enqueueInputs.push({ name });
  }

  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "person-lookup",
      data: { records: JSON.stringify(records), archetype: "preview" },
    },
    trackerDir,
  );

  // Two selected records can carry the IDENTICAL extracted name (a real
  // occurrence — common names): dispatching them as two separate
  // fanOutAndWatch children would collide inside its own
  // JSON.stringify(input)-keyed itemId map (last-write-wins, NOT a per-key
  // FIFO queue) and silently misapply ONE person's lookup outcome to a
  // DIFFERENT record. Fix: group by the logical input BEFORE dispatch so
  // fanOutAndWatch only ever sees ONE child per unique input — collision-proof
  // by construction, since no duplicate key ever reaches it — then fan the
  // single resolved outcome back out to every aliased record below. Identical
  // input always resolves to the identical real-world lookup result, so this
  // is exact (not an approximation) and also skips a redundant duplicate
  // person-lookup dispatch for the same name.
  type EidLookupChildInput = { name: string };
  interface FanOutGroup { itemId: string; input: EidLookupChildInput; aliasItemIds: string[] }
  const groupsByInputKey = new Map<string, FanOutGroup>();
  enqueueInputs.forEach((inp, arrayPos) => {
    const itemId = itemIds[arrayPos] ?? "";
    const key = JSON.stringify(inp);
    const existing = groupsByInputKey.get(key);
    if (existing) existing.aliasItemIds.push(itemId);
    else groupsByInputKey.set(key, { itemId, input: inp, aliasItemIds: [itemId] });
  });
  const groups = [...groupsByInputKey.values()];
  const aliasItemIdsByDispatchedItemId = new Map(groups.map((g) => [g.itemId, g.aliasItemIds]));

  // Shared dispatch→watch→cascade-cancel pipeline (BM-1). force-research re-fans
  // person-lookup by NAME (it cleared employeeId above) and patches each outcome
  // with the name-resolution semantics. The `_enqueueOverride(itemIds, inputs)`
  // HTTP test seam maps to fanOutAndWatch's dispatch override; the cascade-cancel
  // on operator discard-abort lives in fanOutAndWatch.
  const { personLookupWorkflow } = await import("../person-lookup/index.js");
  const { byItemId, missingItemIds } = await fanOutAndWatch<EidLookupChildInput>({
    sessionId: input.sessionId,
    runId: input.runId,
    parentRunId: input.runId,
    trackerDir,
    date,
    child: personLookupWorkflow as never,
    children: groups.map((g) => ({ input: g.input, itemId: g.itemId })),
    timeoutMs: 30 * 60_000,
    ...(opts._enqueueOverride
      ? { dispatch: async (children) => opts._enqueueOverride!(children.map((c) => c.itemId), children.map((c) => c.input)) }
      : {}),
    ...(opts._watchChildRunsOverride ? { watch: opts._watchChildRunsOverride } : {}),
  });

  // Patch records from lookup outcomes before emitting the final state — fan
  // each unique-input outcome out to every original record that shared the
  // lookup key (see grouping above). A dispatched itemId with no matching
  // alias group is an invariant violation (fanOutAndWatch reported an id we
  // never asked it to watch) — fail loud rather than silently dropping it.
  for (const [dispatchedItemId, outcome] of byItemId) {
    const aliasItemIds = aliasItemIdsByDispatchedItemId.get(dispatchedItemId);
    if (!aliasItemIds) {
      throw new Error(
        `force-research: person-lookup outcome for unexpected itemId "${dispatchedItemId}" — ` +
          `not one of the ${groups.length} dispatched fan-out children`,
      );
    }
    for (const aliasItemId of aliasItemIds) {
      const idx = itemIdToRecordIdx.get(aliasItemId);
      if (idx === undefined) continue;
      patchOcrRecordFromEidLookupOutcome(records, idx, outcome, "name");
    }
  }

  // Any expected itemId that did not produce an outcome (timeout or skipped)
  // must be marked unresolved so the dashboard does not leave the record
  // stuck in `lookup-pending`. Mirrors the orchestrator's safety net. Fan out
  // to every aliased record sharing the same (never-resolved) lookup key.
  for (const dispatchedItemId of missingItemIds) {
    const aliasItemIds = aliasItemIdsByDispatchedItemId.get(dispatchedItemId) ?? [dispatchedItemId];
    for (const aliasItemId of aliasItemIds) {
      const idx = itemIdToRecordIdx.get(aliasItemId);
      if (idx === undefined) continue;
      patchOcrRecordUnresolved(
        records,
        idx,
        "eid-lookup timed out without a result",
      );
    }
  }

  // Re-emit via the shared OCR preview-row envelope (BM-5) so the dashboard
  // resolves the row by archetype/__id/__name/parentSubject. Running → done pair.
  const parentRunId = (latest.data?.parentRunId) ?? latest.parentRunId;
  const parentSubject =
    readQueueTitle(latest.data) ??
    (latest.data?.parentSubject);
  const snapshotArgs = {
    base: { ...(latest.data ?? {}) },
    sessionId: input.sessionId,
    runId: input.runId,
    records,
    step: "awaiting-approval",
    parent: {
      ...(parentRunId ? { parentRunId } : {}),
      ...(parentSubject ? { parentSubject } : {}),
    },
    trackerDir,
  } as const;
  emitOcrReviewSnapshot({ ...snapshotArgs, status: "running" });
  emitOcrReviewSnapshot({ ...snapshotArgs, status: "done" });
}
