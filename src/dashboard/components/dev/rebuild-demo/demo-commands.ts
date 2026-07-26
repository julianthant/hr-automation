/**
 * DEV-ONLY — the rebuild demo's MOCK COMMAND SERVICE.
 *
 * Every control in the demo goes through here, because the interesting part of
 * a command protocol is not the happy path. A command returns exactly one of
 * three states and the UI must be able to render all three:
 *
 *  - `applied`   the server accepted it and the row moved.
 *  - `conflict`  the operator acted on a STALE surface. The CAS `expectedVersion`
 *                on the descriptor no longer matches the server's version, so
 *                NOTHING was applied. The only cure is a forced refresh.
 *  - `rejected`  the command is not permitted in this row's current state. Typed
 *                code + message, and again nothing was applied.
 *
 * A UI that only ever shows success teaches the operator that clicking works.
 * These two failure states are the ones that actually protect a real HR
 * transaction, so the demo makes both reachable by click.
 */

import { DEMO_OPERATOR, fmtClock, fmtClockSec, agoSeconds, plusSeconds, type ActionDescriptorWire, type DemoCommandKey } from "./demo-wire";
import type { DemoRow } from "./demo-data";
import { checkpointFor, fenceCleared, fenceClearsAt, writeFenceFor } from "./demo-flows-wire";

export type DemoCommandResultState = "applied" | "conflict" | "rejected";

/**
 * A parked write that was OBSERVED absent once has not settled: doc 09 §4
 * requires N qualifying observations separated in time before the intent may
 * become retryable. The command is applied — the observation is recorded — and
 * the row goes back into work while the remaining probes run. This field is how
 * the UI is able to say that without pretending the row is finished.
 */
export interface DemoCommandSettling {
  observations: number;
  required: number;
  nextProbeAt: string;
  fenceClearedAt: string;
}

export interface DemoCommandResult {
  /** unique per submission, so repeated clicks stack instead of collapsing */
  id: string;
  state: DemoCommandResultState;
  rowId: string;
  rowTitle: string;
  workflowLabel: string;
  command: DemoCommandKey;
  actionLabel: string;
  headline: string;
  detail: string;
  /** rejected only — a typed code, never a bare string */
  code?: string;
  /** conflict on the ROW's version only — the feed's refresh acts on this */
  expectedVersion?: number;
  serverVersion?: number;
  /**
   * Conflict on something other than the row version (today: the checkpoint
   * generation). Kept separate so the row-refresh affordance is never offered
   * for a conflict that refreshing the row would not fix.
   */
  cas?: { kind: "checkpoint-generation"; expected: number; server: number };
  /** applied-but-not-finished — a recorded absence observation still settling */
  settling?: DemoCommandSettling;
  clock: string;
  requestedBy: string;
}

/**
 * Commands the server refuses OUTRIGHT, keyed `<rowId>:<command>`.
 *
 * These are not "buttons we forgot to hide": the descriptor is genuinely
 * offered (the row IS failed, retry IS in the vocabulary) and the server still
 * says no, because the refusal depends on facts the queue surface does not
 * carry. That gap is exactly why `rejected` exists in the protocol.
 */
const REJECTIONS: Record<string, { code: string; headline: string; detail: string }> = {
  "oath-batch:retry": {
    code: "not-retryable-at-this-level",
    headline: "Rejected — a packet is not retryable as a unit",
    detail:
      "11 of 12 signers on Oath_Packet_Spring.pdf are already signed and read back. Re-running the packet would sign them a second time. Retry Grace Egan's member row instead — it replays that one person and leaves the other 11 untouched.",
  },
  "ec-tomas:retry": {
    code: "workflow-version-retired",
    headline: "Rejected — this run's workflow version is retired",
    detail:
      "Tomás Rivera ran under Emergency Contact v3; runs are served by v4 now. A retry would replay v3 code, so it is refused. Relaunch from the archive instead: that mints a fresh v4 run from the same archived input.",
  },
};

const APPLIED_COPY: Record<DemoCommandKey, (row: DemoRow) => { headline: string; detail: string }> = {
  retry: (row) => ({
    headline: "Retry applied",
    detail: `A new attempt for ${label(row)} was enqueued with the same input. The failed attempt keeps its own row, evidence and receipt — the two are separate runs.`,
  }),
  cancel: (row) => ({
    headline: "Cancel applied",
    detail: `${label(row)} stopped where it was. Anything already written to ${row.workflow.systems.join(" / ")} stays written — cancelling is not an undo.`,
  }),
  "cancel-tree": (row) => {
    const members = row.memberRunIds?.length ?? 0;
    return {
      headline: "Group cancelled — whole tree",
      detail:
        members > 0
          ? `${label(row)}, its delegated review and all ${members} member rows were cancelled together. There is no undo; a member already mid-write finishes that write and then stops.`
          : `${label(row)} and its delegated review were cancelled together. No member rows existed yet — approving is what creates them — so nothing was fanned out and nothing was written. There is no undo.`,
    };
  },
  bump: (row) => ({
    headline: "Bump applied",
    detail: `${label(row)} moved to the front of the ${row.workflow.label} queue. Everything behind it keeps its order.`,
  }),
  hide: (row) => ({
    headline: "Row removed from the queue",
    detail: `${label(row)} stops being listed. Its receipt, evidence and ledger entries stay in history — nothing was undone in any system.`,
  }),
  rename: (row) => ({
    headline: "Run renamed",
    detail: `The name rides the row and the receipt. The trace id ${row.trace} is untouched, so history still matches.`,
  }),
  "resolve-gate": (row) => ({
    headline: "Decision recorded",
    detail: `${label(row)} leaves the gate and returns to the queue. The decision is attributed to ${DEMO_OPERATOR} and written into the run's evidence.`,
  }),
  "resolve-write-present": (row) => ({
    headline: "Write recorded as PRESENT",
    detail: `${label(row)} closes as Verified done against what you read in UCPath, and a ledger entry is filed under your name. Retry stays locked — there is nothing left to run.`,
  }),
  "resolve-write-absent": (row) => ({
    headline: "Write recorded as ABSENT",
    detail: `${label(row)} closes as Failed and retry is UNLOCKED. The next run submits for real, so this is the answer that must be right.`,
  }),
  "rerun-with-different-input": (row) => ({
    headline: "New run from a different input",
    detail: `${label(row)} keeps its failure and its evidence. A separate ${row.workflow.label} run starts from the file you pick, with its own trace id and its own receipt.`,
  }),
  "edit-checkpoint": (row) => ({
    headline: "Checkpoint saved",
    detail: `Your corrections are written to ${label(row)}'s checkpoint at a new generation, each field stamped provenance "operator" with your name and the time. The original observed values are kept beside them — a correction never overwrites what was read.`,
  }),
  "rerun-with-existing-data": (row) => ({
    headline: "New run from this data",
    detail: `A fresh ${row.workflow.label} run was enqueued on the current workflow version from these values. Reused values are marked as reused in its receipt — a replay is never labelled as newly observed.`,
  }),
};

// ---------------------------------------------------------------------------
// Payload parsing — the server's schemas, not the browser's opinion
// ---------------------------------------------------------------------------

interface Refusal {
  code: string;
  headline: string;
  detail: string;
}

/**
 * The DOUBLE FENCE, in code. A resolution for a parked write must bind BOTH
 * the same subject key and the same intent generation as the write it resolves,
 * and an absence must be observed under the settle rules. Anything else is
 * refused outright — nothing is recorded, nothing is unlocked.
 */
function parkRefusal(row: DemoRow, command: DemoCommandKey, payload: Record<string, string>): Refusal | null {
  const fence = writeFenceFor(row);
  if (!fence) {
    return {
      code: "not-parked",
      headline: "Rejected — this run has no unknown write",
      detail: "The two write resolutions exist only for a write whose outcome we cannot see. This row is not parked.",
    };
  }
  if (payload.intentGeneration !== String(fence.intentGeneration)) {
    return {
      code: "stale-intent-generation",
      headline: "Refused by the fence — you are resolving an older attempt",
      detail: `This form was opened against intent generation ${payload.intentGeneration}; the parked write is at generation ${fence.intentGeneration}. Nothing was recorded. Close the form and re-open it so you are answering about the write that actually exists.`,
    };
  }
  if ((payload.observedEid ?? "").trim() !== fence.subjectEid) {
    return {
      code: "subject-key-mismatch",
      headline: "Refused by the fence — that is a different person",
      detail: `The parked write is keyed to ${fence.subjectName} · EID ${fence.subjectEid}. You entered EID “${payload.observedEid || "—"}”, so what you looked at cannot answer this question. NOTHING was recorded. Re-check ${fence.subjectName} in ${fence.system} and try again.`,
    };
  }
  if (command === "resolve-write-present") {
    if (payload.proofSource === "attestation") {
      if ((payload.attestation ?? "").trim().length < 20) {
        return {
          code: "proof-parse-failed",
          headline: "Proof rejected — the attestation is too thin to stand as evidence",
          detail: "An operator attestation replaces a machine-read confirmation number, so it has to say what you saw and where: the page, the person, the effective date. Nothing was recorded — the write is still parked.",
        };
      }
      return null;
    }
    if (!fence.proofPattern.test((payload.transactionNumber ?? "").trim())) {
      return {
        code: "proof-parse-failed",
        headline: "Proof rejected — the transaction number did not parse",
        detail: `“${payload.transactionNumber || "—"}” is not a ${fence.proofLabel} (expected e.g. ${fence.proofExample}). A present-proof is parsed by the same schema the run itself would have used, so an unparsed proof can never close a run. NOTHING changed — the write is still parked.`,
      };
    }
    return null;
  }
  // resolve-write-absent
  if (payload.observations === "two-adjacent") {
    return {
      code: "observations-not-independent",
      headline: "Refused by the fence — two checks in the same minute count as one",
      detail: `Two observations only settle an absence if they are at least ${fence.minBetweenReadsMin} minutes apart — back-to-back reads see the same replica and would agree even if the write is still propagating. NOTHING was recorded. Either wait ${fence.minBetweenReadsMin} minutes and look again, or record this as a single observation and let the scheduled probe finish it.`,
    };
  }
  if (payload.observations === "two-spaced" && !fenceCleared(fence)) {
    return {
      code: "absence-not-settled",
      headline: "Refused by the fence — the absence cannot settle yet",
      detail: `The write was fenced at ${fmtClock(fence.fencedAt)}; no observation may count before ${fmtClock(fenceClearsAt(fence))} (fence + ${fence.minSinceFenceMin}m). NOTHING was recorded.`,
    };
  }
  if ((payload.evidenceNote ?? "").trim().length < 12) {
    return {
      code: "evidence-note-required",
      headline: "Rejected — an absence needs written evidence",
      detail: "Say where you looked and what you saw. This note is the only record of why a retry was allowed to submit for real, so an empty one is not acceptable.",
    };
  }
  return null;
}

function checkpointConflict(row: DemoRow, payload: Record<string, string>): { expected: number; server: number } | null {
  const cp = checkpointFor(row);
  const expected = Number(payload.expectedGeneration ?? cp.heldGeneration);
  return expected === cp.serverGeneration ? null : { expected, server: cp.serverGeneration };
}

function label(row: DemoRow): string {
  return row.displayName ?? row.title;
}

let sequence = 0;

export interface SubmitContext {
  /**
   * The version the operator's view is at NOW. Starts as the descriptor's
   * `expectedVersion` and is replaced when they force a refresh — which is the
   * only way out of a conflict.
   */
  knownVersion?: number;
  tick?: number;
}

/**
 * Submit one command. Pure and deterministic: same row + action + context in,
 * same result out. There is no backend and nothing mutates — the point is to
 * make all three result shapes REACHABLE, not to simulate a database.
 */
export function submitDemoCommand(row: DemoRow, action: ActionDescriptorWire, ctx: SubmitContext = {}): DemoCommandResult {
  if (action.kind !== "command" || !action.command) {
    throw new Error(`demo commands: ${action.key} on ${row.id} is navigation, not a command`);
  }
  const command = action.command;
  sequence += 1;
  const base = {
    id: `cmd-${sequence}`,
    rowId: row.id,
    rowTitle: label(row),
    workflowLabel: row.workflow.label,
    command,
    actionLabel: action.label,
    clock: fmtClockSec(agoSeconds(-(ctx.tick ?? 0))),
    requestedBy: DEMO_OPERATOR,
  };

  // 1. CAS first. A stale view can never be allowed to act, whatever it asks for.
  const expectedVersion = ctx.knownVersion ?? action.expectedVersion;
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    return {
      ...base,
      state: "conflict",
      expectedVersion,
      serverVersion: row.version,
      headline: "Conflict — your view of this row is out of date",
      detail: `You acted on version ${expectedVersion}; the server is at version ${row.version}. NOTHING was applied. Refresh the row and look again before you decide — the change you could not see may be the reason this command is wrong.`,
    };
  }

  // 2. State-dependent refusals the surface cannot know about.
  const rejection = REJECTIONS[`${row.id}:${command}`];
  if (rejection) {
    return { ...base, state: "rejected", code: rejection.code, headline: rejection.headline, detail: rejection.detail };
  }

  const payload = action.payload;

  // 3. Typed bodies. A parked write's proof and a checkpoint patch are PARSED
  //    here — the form collects, the server decides. A parse failure changes
  //    nothing, which is the whole point of doc 09 §4.1.
  if (command === "resolve-write-present" || command === "resolve-write-absent") {
    const refusal = parkRefusal(row, command, payload ?? {});
    if (refusal) return { ...base, state: "rejected", ...refusal };
  }

  if (command === "edit-checkpoint") {
    const conflict = checkpointConflict(row, payload ?? {});
    if (conflict) {
      return {
        ...base,
        state: "conflict",
        cas: { kind: "checkpoint-generation", expected: conflict.expected, server: conflict.server },
        headline: "Conflict — the checkpoint moved while you were editing",
        detail: `You edited generation ${conflict.expected}; the server holds generation ${conflict.server}. NOTHING was saved and your edits were NOT discarded — they are held on the Data tab and re-offered field by field against the values the server now has, so you can decide each one instead of overwriting a change you never saw.`,
      };
    }
  }

  const copy = APPLIED_COPY[command](row);

  // 4. Applied, but not finished: one absence observation is evidence, not
  //    authority. The row re-enters work until the fence is satisfied.
  if (command === "resolve-write-absent" && payload?.observations === "one") {
    const fence = writeFenceFor(row);
    const nextProbeAt = fence ? plusSeconds(agoSeconds(-(ctx.tick ?? 0)), fence.minBetweenReadsMin * 60) : agoSeconds(0);
    return {
      ...base,
      state: "applied",
      headline: "Observation recorded — the write is still parked",
      detail: `Your single look counts as ONE qualifying observation. Retry stays locked until a second, independent observation agrees: a probe is queued for ${fmtClock(nextProbeAt)}. The row is back in work while that settles — it has not failed and it has not finished.`,
      settling: fence
        ? { observations: 1, required: fence.requiredObservations, nextProbeAt, fenceClearedAt: fenceClearsAt(fence) }
        : undefined,
    };
  }

  return { ...base, state: "applied", headline: copy.headline, detail: copy.detail };
}
