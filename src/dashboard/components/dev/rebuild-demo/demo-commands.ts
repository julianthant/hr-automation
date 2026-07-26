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

import { DEMO_OPERATOR, fmtClockSec, agoSeconds, type ActionDescriptorWire, type DemoCommandKey } from "./demo-wire";
import type { DemoRow } from "./demo-data";

export type DemoCommandResultState = "applied" | "conflict" | "rejected";

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
  /** conflict only */
  expectedVersion?: number;
  serverVersion?: number;
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
};

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

  const copy = APPLIED_COPY[command](row);
  return { ...base, state: "applied", headline: copy.headline, detail: copy.detail };
}
