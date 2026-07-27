/**
 * DEV-ONLY — the ARCHIVE + VERSION-REGISTRY half of the wire contract.
 *
 * The ratified model (`docs/rebuild/reviews/second-look-2026-07-22.md` §6.6,
 * pinned as a contract in `docs/rebuild/03-tracker-dashboard.md` §10.2):
 *
 *  - The dashboard's active surfaces, counts and filters contain **current-version
 *    runs only**.
 *  - When a workflow's version bumps, every prior-version run leaves the
 *    dashboard for a read-only **Archive**, stored as **self-contained data** so
 *    rendering an archived run needs ZERO old-version code.
 *  - **The write ledger is never archived.** Archiving is a display lifecycle;
 *    the ledger is an audit one, so every archived run still lists what it filed.
 *  - **Relaunch from archive is a FRESH run on the current version** from the
 *    archived immutable input. Never a resume.
 *  - **A bump cannot archive a non-terminal run.**
 *
 * **Wave 12 made "self-contained" mean it.** The stored snapshot was a final
 * row, a receipt and a list of `sha256:` strings — which is enough to say what
 * happened and not enough to answer a question about it. A run whose receipt
 * read "13 of 14 updated · 1 not found" could not name the other thirteen. So
 * the shape now carries the log stream, the step timeline, the members, the
 * decision history, the failure record, the data ledger with its corrections,
 * the attempt history, and the run-identity facts (`dryRun`, `resolvedInstance`,
 * `priority`, `preset`) without which an archived rehearsal is indistinguishable
 * from an archived filing. It also carries what the page's whole claim rests on
 * and had no way to check: WHO archived it, a snapshot integrity hash, and how
 * long the row and its evidence live.
 *
 * **Versioning is `major.minor`** (`demo-wire.ts`). Only a MAJOR bump archives:
 * a minor bump is presentation, so nothing moves and there are no blockers. The
 * two arms are different commands with different consequences, and the plan
 * preview says which one you are looking at.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoCommandResultState } from "./demo-commands";
import type { DemoRow } from "./demo-data";
import { effectiveStatus, isTerminal } from "./demo-data";
import { DEMO_DAYS, topLevelRowsForDay } from "./demo-days";
import type { DemoCapture } from "./demo-evidence-wire";
import {
  DEMO_APP_VERSION,
  DEMO_OPERATOR,
  DEMO_WORKFLOWS,
  descriptorVersion,
  fmtVersion,
  fmtVersionTag,
  type DemoWorkflowId,
  type SystemKey,
} from "./demo-wire";

// ---------------------------------------------------------------------------
// Terminality — the whole safety carve-out turns on this one predicate
// ---------------------------------------------------------------------------

// Terminality lives in `demo-data.ts` — the lowest layer that knows what a
// status is — and is re-exported here because the archive is where it is
// load-bearing (a bump may not archive a non-terminal run). One definition, so
// the bump's refusal and the queue's own settlement can never disagree.
export { TERMINAL_STATUSES, isTerminal } from "./demo-data";

/**
 * What a non-terminal run has to become before a MAJOR bump may archive it.
 * Parked is the one that is not negotiable for convenience — it is the status
 * that means "we may already have filed something".
 */
export const REQUIRED_RESOLUTION: Record<ProposedStatus, string> = {
  queued: "Cancel it, or bump it and let it reach a terminal state.",
  running: "Let it finish, or cancel it. A bump mid-write is how a half-filed transaction loses its row.",
  waiting: "Answer the gate — approve or discard — or cancel the run.",
  parked:
    "Resolve the write present or absent. This one is not negotiable: an unresolved possible-submit may never be buried in an archive.",
  verifiedDone: "",
  doneWarnings: "",
  failed: "",
  cancelled: "",
};

/** every top-level row the tracker holds, across every day it holds */
export function allTopLevelRows(): DemoRow[] {
  return DEMO_DAYS.flatMap((day) => topLevelRowsForDay(day));
}

// ---------------------------------------------------------------------------
// Version registry
// ---------------------------------------------------------------------------

export interface VersionRegistryEntry {
  workflowId: DemoWorkflowId;
  label: string;
  code: string;
  /** `7.2` — identity. The archive keys on the major half alone. */
  currentVersion: string;
  currentMajor: number;
  appVersion: string;
  /** listed runs at the current MAJOR — a minor difference is not a difference */
  atCurrentVersion: number;
  /** listed runs at an OLDER major — what a major bump would sweep */
  atPriorVersion: number;
  /** listed runs that are not terminal — these BLOCK a major bump only */
  nonTerminal: number;
  /** runs already in the archive for this workflow */
  archived: number;
}

export function deriveVersionRegistry(rows: DemoRow[]): VersionRegistryEntry[] {
  return Object.values(DEMO_WORKFLOWS).map((wf) => {
    const mine = rows.filter((r) => r.workflow.id === wf.id);
    return {
      workflowId: wf.id,
      label: wf.label,
      code: wf.code,
      currentVersion: fmtVersion(descriptorVersion(wf)),
      currentMajor: wf.version,
      appVersion: DEMO_APP_VERSION,
      atCurrentVersion: mine.filter((r) => r.workflowVersion === wf.version).length,
      atPriorVersion: mine.filter((r) => r.workflowVersion < wf.version).length,
      nonTerminal: mine.filter((r) => !isTerminal(effectiveStatus(r))).length,
      archived: DEMO_ARCHIVE.filter((a) => a.workflowId === wf.id).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Change records — one per bump, and they now record WHICH KIND it was
// ---------------------------------------------------------------------------

export type BumpScope = "workflow" | "multi-workflow" | "dashboard";

/**
 * The distinction the demo could not express before: every bump archived
 * everything terminal in scope, and the dialog asked *why* without doing
 * anything with the answer.
 */
export type BumpKind = "major" | "minor";

export const BUMP_KIND_LABEL: Record<BumpKind, string> = {
  major: "Major — the run's shape changed",
  minor: "Minor — presentation only",
};

export const BUMP_KIND_NOTE: Record<BumpKind, string> = {
  major:
    "Steps added, removed or renamed, or the data contract moved. Runs started under the old descriptor cannot be rendered by the new one, so every prior-version run is archived — and a run that is not terminal blocks the bump until it is resolved.",
  minor:
    "A label, a title rule, a description. Nothing is archived, runs in flight continue, and every old run still renders correctly — so there is nothing a run could be doing that would block this.",
};

export interface ChangeRecordWire {
  id: string;
  scope: BumpScope;
  kind: BumpKind;
  workflowIds: DemoWorkflowId[];
  at: string;
  by: string;
  what: string;
  why: string;
  commit: string;
  fromVersion: string;
  toVersion: string;
  archivedRuns: number;
}

export const BUMP_SCOPE_LABEL: Record<BumpScope, string> = {
  workflow: "Single workflow",
  "multi-workflow": "Several workflows",
  dashboard: "Dashboard update — every workflow",
};

export const BUMP_SCOPE_NOTE: Record<BumpScope, string> = {
  workflow: "Only this workflow's version moves. Only its prior-version runs archive.",
  "multi-workflow": "Each named workflow's version moves together, under one change record.",
  dashboard:
    "An app update bumps the EFFECTIVE version of every workflow, because old runs may not be interpretable against new dashboard state. Every listed run archives.",
};

export const DEMO_CHANGE_RECORDS: ChangeRecordWire[] = [
  {
    id: "chg-se-7-2",
    scope: "workflow",
    kind: "minor",
    workflowIds: ["separations"],
    at: "Jul 24, 10:18 AM",
    by: DEMO_OPERATOR,
    what: "The Separations queue row is titled by the person once Kuali has been read, instead of keeping the doc ID for the whole run.",
    why: "Presentation only — the run does the same thing in the same order. Nothing was archived and the four runs in flight at the time carried on.",
    commit: "3f10ba2",
    fromVersion: "v7.1",
    toVersion: "v7.2",
    archivedRuns: 0,
  },
  {
    id: "chg-ec-4",
    scope: "workflow",
    kind: "major",
    workflowIds: ["emergency-contact"],
    at: "Jul 22, 4:41 PM",
    by: DEMO_OPERATOR,
    what: "Emergency Contact now reads the relationship field from the form instead of defaulting it to “Other”.",
    why: "A defaulted relationship is a silent wrong value on a real record — the field is now required and the run fails loud when the page does not carry one.",
    commit: "a5ac547",
    fromVersion: "v3.1",
    toVersion: "v4.0",
    archivedRuns: 3,
  },
  {
    id: "chg-app-2026073",
    scope: "dashboard",
    kind: "major",
    workflowIds: [],
    at: "Jul 20, 9:02 AM",
    by: DEMO_OPERATOR,
    what: "Dashboard update 2026.07.2 → 2026.07.3 — the queue projection gained containment and the merged Data surface.",
    why: "Old rows carry no containment, so they cannot be placed in the new queue model. Bumping every workflow is what keeps exactly one rendering path in the dashboard.",
    commit: "e15677b",
    fromVersion: "app 2026.07.2",
    toVersion: "app 2026.07.3",
    archivedRuns: 4,
  },
  {
    id: "chg-ocr-9",
    scope: "workflow",
    kind: "major",
    workflowIds: ["ocr"],
    at: "Jul 18, 11:20 AM",
    by: DEMO_OPERATOR,
    what: "OCR holds tier-1 model patience for the whole batch instead of degrading to a weaker tier partway through.",
    why: "Mid-batch tier drift is what makes a weak model invent handwritten SSNs. Behaviour change, so the guard forced a bump.",
    commit: "9022c14",
    fromVersion: "v8.0",
    toVersion: "v9.0",
    archivedRuns: 0,
  },
];

export function changeRecordFor(bumpId: string): ChangeRecordWire | undefined {
  return DEMO_CHANGE_RECORDS.find((record) => record.id === bumpId);
}

// ---------------------------------------------------------------------------
// The stored snapshot
// ---------------------------------------------------------------------------

export interface ArchivedReceiptLine {
  label: string;
  value: string;
  verified?: boolean;
}

/**
 * An evidence pointer. It carries the capture's METADATA, so the archive can
 * open the same viewer the live rail uses — and it says whether the BYTES are
 * still there, because a content ref with no retention state is a link the
 * operator cannot tell from a dead one until they click it.
 */
export interface ArchivedEvidenceWire {
  id: string;
  kind: DemoCapture["kind"];
  label: string;
  ref: string;
  step?: string;
  system?: SystemKey;
  /**
   * A demo INSTANT (`2026-07-22T08:14:00`), never a formatted clock. The viewer
   * parses it with `fmtClock`, which throws on anything else — that fail-loud
   * parse is what caught a fixture holding `"8:14 AM"` and crashing the
   * lightbox, so do not soften it into a display string.
   */
  capturedAt?: string;
  screen?: string;
  pageState?: string;
  urlRedacted?: string;
  size?: { w: number; h: number };
  note?: string;
  /** whether the image is still in the evidence store */
  retention: "retained" | "purged";
  /** when it goes, or when it went */
  retentionAt: string;
}

export interface ArchivedLogLineWire {
  at: string;
  level: "info" | "warn" | "error" | "read" | "write";
  text: string;
  system?: SystemKey;
  step?: string;
}

export interface ArchivedStepWire {
  label: string;
  state: "done" | "failed" | "skipped" | "cancelled";
  durationLabel?: string;
}

export interface ArchivedMemberWire {
  id: string;
  name: string;
  eid?: string;
  /** the typed outcome word this workflow answers with */
  outcome: string;
  tone: "quiet" | "warning" | "danger";
  detail: string;
}

export interface ArchivedDecisionWire {
  at: string;
  kind: "gate" | "correction" | "park" | "identity";
  question: string;
  answer: string;
  by: string;
}

export interface ArchivedFailureWire {
  headline: string;
  /** what is half-done — the difference between a safe retry and a duplicate */
  writeState: string;
  classification: string;
  cause: string;
}

export interface ArchivedDataPointWire {
  direction: "read" | "write";
  field: string;
  value: string;
  system?: SystemKey;
  at?: string;
  /** the machine's reading, kept beside the value that replaced it */
  correctedFrom?: string;
  correctedBy?: string;
}

export interface ArchivedAttemptWire {
  ordinal: number;
  traceId: string;
  outcome: ProposedStatus;
  at: string;
  note: string;
}

/**
 * How long this row and its evidence live. Nothing said this before, on the one
 * surface most likely to be opened for an audit request.
 */
export interface ArchivedRetentionWire {
  policy: string;
  rowPurgeAt: string;
  evidencePurgeAt: string;
}

/**
 * Who archived it and whether the stored bytes still hash to what was written.
 * The page's whole claim — "this is what happened, rendered with no old-version
 * code" — rests on trusting the row, and nothing was checking the row.
 */
export interface ArchivedProvenanceWire {
  archivedBy: string;
  snapshotHash: string;
  snapshotVerifiedAt: string;
  /** the snapshot schema the row was written under */
  schema: string;
}

export interface ArchivedRunWire {
  runId: string;
  traceId: string;
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  workflowCode: string;
  /** the MAJOR this run RAN under — never the registry's current one */
  workflowVersion: number;
  workflowMinorVersion: number;
  appVersion: string;
  title: string;
  subtitle: string;
  displayName?: string;
  finalStatus: ProposedStatus;
  enqueuedAt: string;
  endedAt: string;
  durationLabel: string;
  requestedBy: string;
  archivedAt: string;
  /** the change record that swept it out of the dashboard */
  bumpId: string;

  /* ---- run identity: without these an archived rehearsal reads as a filing -- */
  dryRun: boolean;
  priority: "interactive" | "bulk";
  resolvedInstance: Partial<Record<SystemKey, "prod" | "test">>;
  preset?: string;

  receipt: {
    headline: string;
    confidence: "verified" | "partial" | "unknown";
    lines: ArchivedReceiptLine[];
  };
  evidence: ArchivedEvidenceWire[];
  /** the immutable input a relaunch would replay — the only re-runnable part */
  input: { label: string; value: string }[];
  /** the ledger is NEVER archived; an archived run still says what it filed */
  ledger: { system: string; action: string; confirmation: string; instance: "prod" | "test" }[];

  /* ---- the inspectable half ---------------------------------------------- */
  steps: ArchivedStepWire[];
  logs: ArchivedLogLineWire[];
  data: ArchivedDataPointWire[];
  members: ArchivedMemberWire[];
  decisions: ArchivedDecisionWire[];
  attempts: ArchivedAttemptWire[];
  failure?: ArchivedFailureWire;

  retention: ArchivedRetentionWire;
  provenance: ArchivedProvenanceWire;
}

const RETAINED = (retentionAt: string) => ({ retention: "retained" as const, retentionAt });
const PURGED = (retentionAt: string) => ({ retention: "purged" as const, retentionAt });

const VIEWPORT = { w: 1600, h: 1000 };

export const DEMO_ARCHIVE: ArchivedRunWire[] = [
  {
    runId: "arch-ec-tomas-v3",
    traceId: "ec-091452-4a02",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
    workflowMinorVersion: 1,
    appVersion: "2026.07.2",
    title: "Tomás Rivera",
    subtitle: "EID 10443321",
    finalStatus: "cancelled",
    enqueuedAt: "Jul 22, 9:14 AM",
    endedAt: "Jul 22, 9:15 AM",
    durationLabel: "22s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 22, 4:41 PM",
    bumpId: "chg-ec-4",
    dryRun: false,
    priority: "interactive",
    resolvedInstance: { ucpath: "prod" },
    receipt: {
      headline: "Cancelled at Navigation — nothing written",
      confidence: "unknown",
      lines: [
        { label: "Reached", value: "UCPath navigation" },
        { label: "Written", value: "nothing", verified: true },
        { label: "Relationship read", value: "— (v3 defaulted this field; that is what v4.0 fixed)" },
      ],
    },
    evidence: [
      {
        id: "arch-ec-tomas-e1",
        kind: "step",
        label: "UCPath landing page",
        ref: "sha256:9f2c…a41",
        step: "Navigation",
        system: "ucpath",
        capturedAt: "2026-07-22T09:14:00",
        screen: "UCPath — Employee Actions",
        size: VIEWPORT,
        ...RETAINED("purges Oct 22, 2026"),
      },
    ],
    input: [
      { label: "Name", value: "Tomás Rivera" },
      { label: "EID", value: "10443321" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 4" },
    ],
    ledger: [],
    steps: [
      { label: "Read the form", state: "done", durationLabel: "6s" },
      { label: "Navigation", state: "cancelled", durationLabel: "16s" },
      { label: "Fill contact", state: "skipped" },
      { label: "Read back", state: "skipped" },
    ],
    logs: [
      { at: "9:14:02 AM", level: "info", text: "Run accepted · interactive priority", step: "Read the form" },
      { at: "9:14:08 AM", level: "read", text: "Contact name read from page 4 — Marisol Rivera", step: "Read the form" },
      { at: "9:14:31 AM", level: "info", text: "Opened UCPath Employee Actions", system: "ucpath", step: "Navigation" },
      { at: "9:15:00 AM", level: "warn", text: "Cancelled by the operator before any field was filled", step: "Navigation" },
    ],
    data: [
      { direction: "read", field: "Contact name", value: "Marisol Rivera", at: "9:14:08 AM" },
      { direction: "read", field: "Contact phone", value: "(858) 555-0132", at: "9:14:09 AM" },
      { direction: "read", field: "Relationship", value: "—", at: "9:14:09 AM" },
    ],
    members: [],
    decisions: [
      {
        at: "9:15:00 AM",
        kind: "gate",
        question: "Cancel this run before it writes?",
        answer: "Cancelled — the form's relationship box was blank and v3 would have filed “Other”.",
        by: DEMO_OPERATOR,
      },
    ],
    attempts: [{ ordinal: 1, traceId: "ec-091452-4a02", outcome: "cancelled", at: "Jul 22, 9:14 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 20, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:4c81…9be",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-ec-noor-v3",
    traceId: "ec-081120-77bd",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
    workflowMinorVersion: 1,
    appVersion: "2026.07.2",
    title: "Noor Haddad",
    subtitle: "EID 10502774",
    finalStatus: "doneWarnings",
    enqueuedAt: "Jul 22, 8:11 AM",
    endedAt: "Jul 22, 8:14 AM",
    durationLabel: "2m 51s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 22, 4:41 PM",
    bumpId: "chg-ec-4",
    dryRun: false,
    priority: "interactive",
    resolvedInstance: { ucpath: "prod" },
    receipt: {
      headline: "Filed — relationship defaulted to “Other”",
      confidence: "partial",
      lines: [
        { label: "Contact", value: "Rania Haddad · (858) 555-0146", verified: true },
        { label: "Relationship", value: "Other (defaulted by v3 — the paper said Spouse)" },
        { label: "Confirmation", value: "UCP-2026-0722-44119", verified: true },
      ],
    },
    evidence: [
      {
        id: "arch-ec-noor-e1",
        kind: "confirmation",
        label: "UCPath confirmation panel",
        ref: "sha256:1b70…c02",
        step: "Read back",
        system: "ucpath",
        capturedAt: "2026-07-22T08:14:00",
        screen: "UCPath — Emergency Contact saved",
        pageState: "Confirmation banner visible, transaction id in frame",
        size: VIEWPORT,
        note: "This is the frame the confirmation number was read out of.",
        ...RETAINED("purges Oct 20, 2026"),
      },
      {
        id: "arch-ec-noor-e2",
        kind: "form",
        label: "Contact form page 2",
        ref: "sha256:4ae1…9dd",
        step: "Read the form",
        capturedAt: "2026-07-22T08:11:00",
        ...PURGED("purged Jul 25, 2026 — 3-day form-image retention"),
      },
    ],
    input: [
      { label: "Name", value: "Noor Haddad" },
      { label: "EID", value: "10502774" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 2" },
    ],
    ledger: [{ system: "ucpath", action: "Emergency contact written", confirmation: "UCP-2026-0722-44119", instance: "prod" }],
    steps: [
      { label: "Read the form", state: "done", durationLabel: "11s" },
      { label: "Navigation", state: "done", durationLabel: "34s" },
      { label: "Fill contact", state: "done", durationLabel: "1m 22s" },
      { label: "Read back", state: "done", durationLabel: "44s" },
    ],
    logs: [
      { at: "8:11:20 AM", level: "info", text: "Run accepted · interactive priority", step: "Read the form" },
      { at: "8:11:28 AM", level: "read", text: "Contact read — Rania Haddad, (858) 555-0146", step: "Read the form" },
      { at: "8:11:31 AM", level: "warn", text: "Relationship box read as “Spouse” but v3 has no relationship mapping — defaulting to Other", step: "Read the form" },
      { at: "8:12:05 AM", level: "info", text: "Opened UCPath Emergency Contact", system: "ucpath", step: "Navigation" },
      { at: "8:13:27 AM", level: "write", text: "Emergency contact submitted", system: "ucpath", step: "Fill contact" },
      { at: "8:14:11 AM", level: "read", text: "Read back — contact matches, relationship reads Other", system: "ucpath", step: "Read back" },
    ],
    data: [
      { direction: "read", field: "Contact name", value: "Rania Haddad", at: "8:11:28 AM" },
      { direction: "read", field: "Contact phone", value: "(858) 555-0146", at: "8:11:28 AM" },
      { direction: "read", field: "Relationship (paper)", value: "Spouse", at: "8:11:31 AM" },
      { direction: "write", field: "Relationship", value: "Other", system: "ucpath", at: "8:13:27 AM" },
      { direction: "write", field: "Emergency contact", value: "Rania Haddad · (858) 555-0146", system: "ucpath", at: "8:13:27 AM" },
      { direction: "read", field: "Confirmation", value: "UCP-2026-0722-44119", system: "ucpath", at: "8:14:11 AM" },
    ],
    members: [],
    decisions: [],
    attempts: [{ ordinal: 1, traceId: "ec-081120-77bd", outcome: "doneWarnings", at: "Jul 22, 8:11 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 20, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:0da4…71c",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-ec-derek-v3",
    traceId: "ec-081702-2c19",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
    workflowMinorVersion: 1,
    appVersion: "2026.07.2",
    title: "Derek Osei",
    subtitle: "EID 10511903",
    finalStatus: "verifiedDone",
    enqueuedAt: "Jul 22, 8:17 AM",
    endedAt: "Jul 22, 8:20 AM",
    durationLabel: "3m 04s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 22, 4:41 PM",
    bumpId: "chg-ec-4",
    dryRun: false,
    priority: "interactive",
    resolvedInstance: { ucpath: "prod" },
    receipt: {
      headline: "Filed and read back",
      confidence: "verified",
      lines: [
        { label: "Contact", value: "Ama Osei · (619) 555-0188", verified: true },
        { label: "Relationship", value: "Parent", verified: true },
        { label: "Confirmation", value: "UCP-2026-0722-44127", verified: true },
        { label: "Read back", value: "Contact re-read from UCPath after submit — matched", verified: true },
      ],
    },
    evidence: [
      {
        id: "arch-ec-derek-e1",
        kind: "confirmation",
        label: "UCPath confirmation panel",
        ref: "sha256:77ea…31f",
        step: "Read back",
        system: "ucpath",
        capturedAt: "2026-07-22T08:20:00",
        screen: "UCPath — Emergency Contact saved",
        size: VIEWPORT,
        ...RETAINED("purges Oct 20, 2026"),
      },
    ],
    input: [
      { label: "Name", value: "Derek Osei" },
      { label: "EID", value: "10511903" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 3" },
    ],
    ledger: [{ system: "ucpath", action: "Emergency contact written", confirmation: "UCP-2026-0722-44127", instance: "prod" }],
    steps: [
      { label: "Read the form", state: "done", durationLabel: "9s" },
      { label: "Navigation", state: "done", durationLabel: "31s" },
      { label: "Fill contact", state: "done", durationLabel: "1m 34s" },
      { label: "Read back", state: "done", durationLabel: "50s" },
    ],
    logs: [
      { at: "8:17:02 AM", level: "info", text: "Run accepted · interactive priority", step: "Read the form" },
      { at: "8:17:11 AM", level: "read", text: "Contact read — Ama Osei, (619) 555-0188, Parent", step: "Read the form" },
      { at: "8:19:16 AM", level: "write", text: "Emergency contact submitted", system: "ucpath", step: "Fill contact" },
      { at: "8:20:06 AM", level: "read", text: "Read back matched on all three fields", system: "ucpath", step: "Read back" },
    ],
    data: [
      { direction: "read", field: "Contact name", value: "Ama Osei", at: "8:17:11 AM" },
      { direction: "read", field: "Relationship (paper)", value: "Parent", at: "8:17:11 AM" },
      {
        direction: "read",
        field: "Contact phone",
        value: "(619) 555-0188",
        at: "8:17:40 AM",
        correctedFrom: "(619) 555-Ol88",
        correctedBy: DEMO_OPERATOR,
      },
      { direction: "write", field: "Emergency contact", value: "Ama Osei · (619) 555-0188 · Parent", system: "ucpath", at: "8:19:16 AM" },
    ],
    members: [],
    decisions: [
      {
        at: "8:17:40 AM",
        kind: "correction",
        question: "Contact phone read as (619) 555-Ol88 — letter O in a digit position",
        answer: "Corrected to (619) 555-0188 before the write. The machine's reading is kept beside it.",
        by: DEMO_OPERATOR,
      },
    ],
    attempts: [{ ordinal: 1, traceId: "ec-081702-2c19", outcome: "verifiedDone", at: "Jul 22, 8:17 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 20, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:b95f…2a0",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-sep-imani-app2",
    traceId: "se-101204-b6f0",
    workflowId: "separations",
    workflowLabel: "Separations",
    workflowCode: "se",
    workflowVersion: 6,
    workflowMinorVersion: 0,
    appVersion: "2026.07.2",
    title: "Imani Brooks",
    subtitle: "EID 10388417",
    finalStatus: "verifiedDone",
    enqueuedAt: "Jul 19, 10:12 AM",
    endedAt: "Jul 19, 10:31 AM",
    durationLabel: "18m 42s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 20, 9:02 AM",
    bumpId: "chg-app-2026073",
    dryRun: false,
    priority: "interactive",
    resolvedInstance: { kuali: "prod", ucpath: "prod", kronos: "prod" },
    preset: "Full separation",
    receipt: {
      headline: "Separation filed and read back",
      confidence: "verified",
      lines: [
        { label: "Effective date", value: "2026-07-31", verified: true },
        { label: "UCPath transaction", value: "UCP-2026-0719-91044", verified: true },
        { label: "Kuali", value: "Finalized · KU-2026-7712", verified: true },
        { label: "Kronos", value: "Pay rule cleared", verified: true },
        { label: "Identity at commit", value: "Imani Brooks · 10388417 · Job 0 · SDCMP", verified: true },
      ],
    },
    evidence: [
      {
        id: "arch-sep-imani-e1",
        kind: "confirmation",
        label: "UCPath post-submit confirmation",
        ref: "sha256:0c31…88a",
        step: "Submit",
        system: "ucpath",
        capturedAt: "2026-07-19T10:26:00",
        screen: "UCPath — Smart HR Transaction submitted",
        pageState: "Transaction id in frame beside the effective date",
        size: VIEWPORT,
        ...RETAINED("purges Oct 17, 2026"),
      },
      {
        id: "arch-sep-imani-e2",
        kind: "step",
        label: "Kuali finalization",
        ref: "sha256:b402…7e1",
        step: "Finalize Kuali",
        system: "kuali",
        capturedAt: "2026-07-19T10:30:00",
        ...RETAINED("purges Oct 17, 2026"),
      },
    ],
    input: [
      { label: "Name", value: "Imani Brooks" },
      { label: "EID", value: "10388417" },
      { label: "Kuali document", value: "KU-2026-7712" },
    ],
    ledger: [
      { system: "ucpath", action: "Separation submitted", confirmation: "UCP-2026-0719-91044", instance: "prod" },
      { system: "kuali", action: "Document finalized", confirmation: "KU-2026-7712", instance: "prod" },
    ],
    steps: [
      { label: "Read Kuali", state: "done", durationLabel: "1m 42s" },
      { label: "Resolve identity", state: "done", durationLabel: "3m 09s" },
      { label: "Submit", state: "done", durationLabel: "6m 51s" },
      { label: "Clear pay rule", state: "done", durationLabel: "3m 20s" },
      { label: "Finalize Kuali", state: "done", durationLabel: "3m 40s" },
    ],
    logs: [
      { at: "10:12:04 AM", level: "info", text: "Run accepted from Kuali doc 7712", step: "Read Kuali" },
      { at: "10:13:46 AM", level: "read", text: "Kuali read — Imani Brooks, last day worked 2026-07-31", system: "kuali", step: "Read Kuali" },
      { at: "10:15:22 AM", level: "warn", text: "Two UCPath people matched the name — paused for identity approval", system: "ucpath", step: "Resolve identity" },
      { at: "10:16:55 AM", level: "info", text: "Identity approved by the operator — EID 10388417, Job 0, SDCMP", step: "Resolve identity" },
      { at: "10:23:52 AM", level: "write", text: "Smart HR Transaction submitted", system: "ucpath", step: "Submit" },
      { at: "10:26:07 AM", level: "read", text: "Read back — transaction UCP-2026-0719-91044 present", system: "ucpath", step: "Submit" },
      { at: "10:27:41 AM", level: "write", text: "Kronos pay rule cleared", system: "kronos", step: "Clear pay rule" },
      { at: "10:31:12 AM", level: "write", text: "Kuali document finalized", system: "kuali", step: "Finalize Kuali" },
    ],
    data: [
      { direction: "read", field: "Last day worked", value: "2026-07-31", system: "kuali", at: "10:13:46 AM" },
      { direction: "read", field: "Department", value: "SDCMP", system: "ucpath", at: "10:16:55 AM" },
      { direction: "write", field: "Separation date", value: "2026-07-31", system: "ucpath", at: "10:23:52 AM" },
      { direction: "write", field: "Pay rule", value: "cleared", system: "kronos", at: "10:27:41 AM" },
      { direction: "write", field: "Kuali document", value: "finalized", system: "kuali", at: "10:31:12 AM" },
    ],
    members: [],
    decisions: [
      {
        at: "10:16:55 AM",
        kind: "identity",
        question: "Two UCPath people match “Imani Brooks”. Which one is this separation for?",
        answer: "EID 10388417 · Job 0 · SDCMP — the department on the Kuali document.",
        by: DEMO_OPERATOR,
      },
    ],
    attempts: [{ ordinal: 1, traceId: "se-101204-b6f0", outcome: "verifiedDone", at: "Jul 19, 10:12 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 17, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:7e02…415",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-ou-spring-app2",
    traceId: "ou-134410-e551",
    workflowId: "oath-upload",
    workflowLabel: "Oath Upload",
    workflowCode: "ou",
    workflowVersion: 5,
    workflowMinorVersion: 0,
    appVersion: "2026.07.2",
    title: "Oath_Packet_Spring.pdf",
    subtitle: "ou-134410-e551",
    displayName: "Spring cohort oaths",
    finalStatus: "verifiedDone",
    enqueuedAt: "Jul 19, 1:44 PM",
    endedAt: "Jul 19, 2:29 PM",
    durationLabel: "44m 51s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 20, 9:02 AM",
    bumpId: "chg-app-2026073",
    dryRun: false,
    priority: "bulk",
    resolvedInstance: { ucpath: "prod", servicenow: "prod" },
    receipt: {
      headline: "Ticket filed after all 12 signers completed",
      confidence: "verified",
      lines: [
        { label: "Signers", value: "12 of 12 signed and read back", verified: true },
        { label: "ServiceNow ticket", value: "INC0448120", verified: true },
        { label: "Document", value: "Oath_Packet_Spring.pdf · 12 pages" },
      ],
    },
    evidence: [
      {
        id: "arch-ou-spring-e1",
        kind: "confirmation",
        label: "ServiceNow ticket",
        ref: "sha256:aa19…b30",
        step: "File the ticket",
        system: "servicenow",
        capturedAt: "2026-07-19T14:29:00",
        screen: "ServiceNow — INC0448120 created",
        size: VIEWPORT,
        ...RETAINED("purges Oct 17, 2026"),
      },
    ],
    input: [{ label: "Document", value: "Oath_Packet_Spring.pdf" }],
    ledger: [{ system: "servicenow", action: "Ticket filed", confirmation: "INC0448120", instance: "prod" }],
    steps: [
      { label: "OCR prep", state: "done", durationLabel: "4m 12s" },
      { label: "Awaiting approval", state: "done", durationLabel: "21m 06s" },
      { label: "Wait for signatures", state: "done", durationLabel: "17m 41s" },
      { label: "File the ticket", state: "done", durationLabel: "1m 52s" },
    ],
    logs: [
      { at: "1:44:10 PM", level: "info", text: "Document accepted · 12 pages · bulk priority", step: "OCR prep" },
      { at: "1:48:22 PM", level: "info", text: "12 people read off the packet", step: "OCR prep" },
      { at: "2:09:28 PM", level: "info", text: "Approved by the operator — 12 of 12 selected", step: "Awaiting approval" },
      { at: "2:27:09 PM", level: "write", text: "All 12 oaths signed in UCPath and read back", system: "ucpath", step: "Wait for signatures" },
      { at: "2:29:01 PM", level: "write", text: "ServiceNow ticket INC0448120 filed", system: "servicenow", step: "File the ticket" },
    ],
    data: [
      { direction: "read", field: "Pages", value: "12", at: "1:44:10 PM" },
      { direction: "read", field: "People read", value: "12", at: "1:48:22 PM" },
      { direction: "write", field: "Oath signatures", value: "12 signed", system: "ucpath", at: "2:27:09 PM" },
      { direction: "write", field: "Ticket", value: "INC0448120", system: "servicenow", at: "2:29:01 PM" },
    ],
    members: [
      { id: "m1", name: "Alicia Fontaine", eid: "10604412", outcome: "Signed", tone: "quiet", detail: "page 1 · read back" },
      { id: "m2", name: "Bo Nguyen", eid: "10604418", outcome: "Signed", tone: "quiet", detail: "page 2 · read back" },
      { id: "m3", name: "Casey Uribe", eid: "10604429", outcome: "Signed", tone: "quiet", detail: "page 3 · read back" },
      { id: "m4", name: "Dev Raman", eid: "10604437", outcome: "Signed", tone: "quiet", detail: "page 4 · read back" },
      { id: "m5", name: "Elif Kaya", eid: "10604441", outcome: "Signed", tone: "quiet", detail: "page 5 · read back" },
      { id: "m6", name: "Farid Mansour", eid: "10604450", outcome: "Signed", tone: "quiet", detail: "page 6 · read back" },
      { id: "m7", name: "Grace Egan", eid: "10604462", outcome: "Signed", tone: "quiet", detail: "page 7 · read back" },
      { id: "m8", name: "Hana Ito", eid: "10604470", outcome: "Signed", tone: "quiet", detail: "page 8 · read back" },
      { id: "m9", name: "Iris Bellamy", eid: "10604481", outcome: "Signed", tone: "quiet", detail: "page 9 · read back" },
      { id: "m10", name: "Jonas Pérez", eid: "10604493", outcome: "Signed", tone: "quiet", detail: "page 10 · read back" },
      { id: "m11", name: "Kalinda Roy", eid: "10604501", outcome: "Signed", tone: "quiet", detail: "page 11 · read back" },
      { id: "m12", name: "Lars Oduya", eid: "10604514", outcome: "Signed", tone: "quiet", detail: "page 12 · read back" },
    ],
    decisions: [
      {
        at: "2:09:28 PM",
        kind: "gate",
        question: "Approve 12 read records and release the signing fan-out?",
        answer: "Approved all 12. No field was corrected.",
        by: DEMO_OPERATOR,
      },
    ],
    attempts: [{ ordinal: 1, traceId: "ou-134410-e551", outcome: "verifiedDone", at: "Jul 19, 1:44 PM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 17, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:1f88…c73",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-ws-cohort-app2",
    traceId: "ws-090015-31c8",
    workflowId: "work-study",
    workflowLabel: "Work-Study",
    workflowCode: "ws",
    workflowVersion: 4,
    workflowMinorVersion: 0,
    appVersion: "2026.07.2",
    title: "14 work-study updates",
    subtitle: "ws-090015-31c8",
    finalStatus: "doneWarnings",
    enqueuedAt: "Jul 19, 9:00 AM",
    endedAt: "Jul 19, 9:52 AM",
    durationLabel: "51m 30s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 20, 9:02 AM",
    bumpId: "chg-app-2026073",
    dryRun: false,
    priority: "bulk",
    resolvedInstance: { ucpath: "prod" },
    receipt: {
      headline: "13 of 14 updated · 1 not found",
      confidence: "partial",
      lines: [
        { label: "Updated", value: "13", verified: true },
        { label: "Not found in UCPath", value: "1 — Rae Lindqvist, EID 10559002" },
        { label: "Award year", value: "2026–2027" },
      ],
    },
    evidence: [
      {
        id: "arch-ws-e1",
        kind: "error",
        label: "Person search — no results",
        ref: "sha256:5fd2…104",
        step: "Update awards",
        system: "ucpath",
        capturedAt: "2026-07-19T09:41:00",
        screen: "UCPath — Person Search, 0 results for 10559002",
        pageState: "Search returned no rows; the EID box holds the searched value",
        size: VIEWPORT,
        ...RETAINED("purges Oct 17, 2026"),
      },
    ],
    input: [
      { label: "Roster", value: "work-study-2026-fall.xlsx" },
      { label: "Award year", value: "2026–2027" },
    ],
    ledger: [
      { system: "ucpath", action: "13 work-study rows written", confirmation: "UCP-2026-0719-90xxx (13 entries)", instance: "prod" },
    ],
    steps: [
      { label: "Read the roster", state: "done", durationLabel: "1m 04s" },
      { label: "Resolve people", state: "done", durationLabel: "12m 22s" },
      { label: "Update awards", state: "done", durationLabel: "38m 04s" },
    ],
    logs: [
      { at: "9:00:15 AM", level: "info", text: "Roster read — 14 rows · bulk priority", step: "Read the roster" },
      { at: "9:13:41 AM", level: "warn", text: "1 of 14 did not resolve in UCPath — EID 10559002", system: "ucpath", step: "Resolve people" },
      { at: "9:41:02 AM", level: "error", text: "Person search returned no rows for 10559002 (Rae Lindqvist)", system: "ucpath", step: "Update awards" },
      { at: "9:52:19 AM", level: "write", text: "13 work-study awards written for 2026–2027", system: "ucpath", step: "Update awards" },
    ],
    data: [
      { direction: "read", field: "Roster rows", value: "14", at: "9:00:15 AM" },
      { direction: "read", field: "Resolved in UCPath", value: "13", system: "ucpath", at: "9:13:41 AM" },
      { direction: "write", field: "Award year", value: "2026–2027 (13 people)", system: "ucpath", at: "9:52:19 AM" },
    ],
    /* The whole point of the inspectability work: this run's receipt says "13 of
       14 updated · 1 not found" and the other thirteen used to be unrecoverable. */
    members: [
      { id: "ws1", name: "Adaeze Okonkwo", eid: "10551120", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws2", name: "Brianna Cole", eid: "10551188", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $2,800" },
      { id: "ws3", name: "Chen Wei", eid: "10551204", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws4", name: "Daniela Ruiz", eid: "10551237", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $1,900" },
      { id: "ws5", name: "Emeka Balogun", eid: "10551249", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws6", name: "Fatima Zahra", eid: "10551262", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $2,200" },
      { id: "ws7", name: "Grigor Petrov", eid: "10551275", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws8", name: "Hyeon-ju Park", eid: "10551288", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $2,600" },
      { id: "ws9", name: "Ines Moreau", eid: "10551294", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws10", name: "Jamal Whitfield", eid: "10551311", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $1,400" },
      { id: "ws11", name: "Keiko Tanaka", eid: "10551327", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      { id: "ws12", name: "Luis Ferreira", eid: "10551340", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $2,050" },
      { id: "ws13", name: "Maya Rosenthal", eid: "10551358", outcome: "Updated", tone: "quiet", detail: "award 2026–2027 · $3,500" },
      {
        id: "ws14",
        name: "Rae Lindqvist",
        eid: "10559002",
        outcome: "Not found",
        tone: "warning",
        detail: "no UCPath person matched the roster EID — nothing was written for this row",
      },
    ],
    decisions: [],
    attempts: [{ ordinal: 1, traceId: "ws-090015-31c8", outcome: "doneWarnings", at: "Jul 19, 9:00 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 17, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:6ab3…d18",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  {
    runId: "arch-onb-kai-app2",
    traceId: "on-112207-d904",
    workflowId: "onboarding",
    workflowLabel: "Onboarding",
    workflowCode: "on",
    workflowVersion: 10,
    workflowMinorVersion: 0,
    appVersion: "2026.07.2",
    title: "Kai Nakamura",
    subtitle: "EID 10620551",
    finalStatus: "failed",
    enqueuedAt: "Jul 19, 11:22 AM",
    endedAt: "Jul 19, 11:26 AM",
    durationLabel: "3m 58s",
    requestedBy: DEMO_OPERATOR,
    archivedAt: "Jul 20, 9:02 AM",
    bumpId: "chg-app-2026073",
    dryRun: false,
    priority: "interactive",
    resolvedInstance: { crm: "prod", i9: "prod", ucpath: "prod" },
    receipt: {
      headline: "Failed at I-9 section 2 — document expired",
      confidence: "verified",
      lines: [
        { label: "Reached", value: "I-9 section 2" },
        { label: "Written", value: "nothing in UCPath", verified: true },
        { label: "Reason", value: "List A document expired 2026-06-30; I-9 refuses it at the source" },
      ],
    },
    evidence: [
      {
        id: "arch-onb-kai-e1",
        kind: "error",
        label: "I-9 rejection banner",
        ref: "sha256:c110…2fa",
        step: "I-9 section 2",
        system: "i9",
        capturedAt: "2026-07-19T11:26:00",
        screen: "I-9 — Section 2, document rejected",
        pageState: "Rejection banner in frame with the expiry date",
        size: VIEWPORT,
        ...RETAINED("purges Oct 17, 2026"),
      },
    ],
    input: [
      { label: "Name", value: "Kai Nakamura" },
      { label: "EID", value: "10620551" },
      { label: "CRM case", value: "CRM-2026-31188" },
    ],
    ledger: [],
    steps: [
      { label: "Read the CRM case", state: "done", durationLabel: "42s" },
      { label: "I-9 section 2", state: "failed", durationLabel: "3m 16s" },
      { label: "UCPath hire", state: "skipped" },
    ],
    logs: [
      { at: "11:22:07 AM", level: "info", text: "Run accepted from CRM-2026-31188", step: "Read the CRM case" },
      { at: "11:22:49 AM", level: "read", text: "CRM read — Kai Nakamura, start date 2026-08-03", system: "crm", step: "Read the CRM case" },
      { at: "11:25:12 AM", level: "read", text: "List A document read — expires 2026-06-30", system: "i9", step: "I-9 section 2" },
      { at: "11:26:05 AM", level: "error", text: "I-9 refused the document at the source: expired", system: "i9", step: "I-9 section 2" },
    ],
    data: [
      { direction: "read", field: "Start date", value: "2026-08-03", system: "crm", at: "11:22:49 AM" },
      { direction: "read", field: "List A expiry", value: "2026-06-30", system: "i9", at: "11:25:12 AM" },
    ],
    members: [],
    decisions: [],
    failure: {
      headline: "I-9 refused the List A document because it expired on 2026-06-30",
      writeState:
        "Nothing was written to UCPath, I-9 or CRM. The run stopped at the source system's own refusal, before any field on any form was submitted, so a retry after the document is replaced is safe and cannot duplicate anything.",
      classification: "Upstream refusal — the data is wrong, the automation is not.",
      cause: "The candidate's List A document expired between the CRM case being raised and the I-9 being started.",
    },
    attempts: [
      { ordinal: 1, traceId: "on-112207-d904", outcome: "failed", at: "Jul 19, 11:22 AM", note: "Only attempt. Never retried — the document had to be replaced first." },
    ],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "Oct 17, 2026",
    },
    provenance: {
      archivedBy: DEMO_OPERATOR,
      snapshotHash: "sha256:c2d9…a06",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v2",
    },
  },
  /**
   * The one case the archive silently lost the reason it exists: a row whose
   * `bumpId` matches no change record. It renders as a NAMED gap, not as a raw
   * id in the position a version pair belongs.
   */
  {
    runId: "arch-pl-legacy",
    traceId: "pl-074410-9a17",
    workflowId: "person-lookup",
    workflowLabel: "Person Lookup",
    workflowCode: "pl",
    workflowVersion: 3,
    workflowMinorVersion: 0,
    appVersion: "2026.06.4",
    title: "Renata Aguilar",
    subtitle: "EID 10477310",
    finalStatus: "verifiedDone",
    enqueuedAt: "Jun 30, 7:44 AM",
    endedAt: "Jun 30, 7:45 AM",
    durationLabel: "58s",
    requestedBy: "hr-automation (migration)",
    archivedAt: "Jul 1, 6:00 AM",
    bumpId: "chg-migration-2026063",
    dryRun: true,
    priority: "bulk",
    resolvedInstance: { ucpath: "test" },
    receipt: {
      headline: "Dry run — person resolved, nothing written",
      confidence: "verified",
      lines: [
        { label: "Resolved", value: "Renata Aguilar · 10477310 · Job 0 · SDLAB", verified: true },
        { label: "Written", value: "nothing — dry run", verified: true },
      ],
    },
    evidence: [
      {
        id: "arch-pl-legacy-e1",
        kind: "step",
        label: "UCPath person search result",
        ref: "sha256:e441…70b",
        step: "Search",
        system: "ucpath",
        capturedAt: "2026-06-30T07:45:00",
        ...PURGED("purged Sep 28, 2026 — 90-day evidence retention"),
      },
    ],
    input: [{ label: "EID", value: "10477310" }],
    ledger: [],
    steps: [{ label: "Search", state: "done", durationLabel: "58s" }],
    logs: [
      { at: "7:44:10 AM", level: "info", text: "Dry run · bulk priority · UCPath TEST instance", step: "Search" },
      { at: "7:45:08 AM", level: "read", text: "Resolved — Renata Aguilar, 10477310, Job 0, SDLAB", system: "ucpath", step: "Search" },
    ],
    data: [{ direction: "read", field: "Department", value: "SDLAB", system: "ucpath", at: "7:45:08 AM" }],
    members: [],
    decisions: [],
    attempts: [{ ordinal: 1, traceId: "pl-074410-9a17", outcome: "verifiedDone", at: "Jun 30, 7:44 AM", note: "Only attempt." }],
    retention: {
      policy: "An archived row is kept indefinitely; its evidence is kept 90 days from the run's end.",
      rowPurgeAt: "kept indefinitely",
      evidencePurgeAt: "purged Sep 28, 2026",
    },
    provenance: {
      archivedBy: "hr-automation (migration)",
      snapshotHash: "sha256:39fe…88d",
      snapshotVerifiedAt: "Jul 25, 2:12 AM",
      schema: "archive/v1",
    },
  },
];

export function archiveForBump(bumpId: string): ArchivedRunWire[] {
  return DEMO_ARCHIVE.filter((run) => run.bumpId === bumpId);
}

/** the version this run ran under, as it is displayed */
export function archivedVersionTag(run: ArchivedRunWire): string {
  return fmtVersionTag({ major: run.workflowVersion, minor: run.workflowMinorVersion });
}

/** the archive's own retention statement — one policy, stated once */
export const ARCHIVE_RETENTION_NOTE =
  "An archived row is kept indefinitely — it is the audit copy. Its evidence images are kept 90 days from the run's end and then purged; a purged pointer still names what it was of. The write ledger is never archived and never pruned.";

// ---------------------------------------------------------------------------
// Finding something — the reason anyone opens an archive
// ---------------------------------------------------------------------------

export type ArchiveSortKey = "newest" | "oldest" | "longest" | "name";

export const ARCHIVE_SORT_LABEL: Record<ArchiveSortKey, string> = {
  newest: "Newest run first",
  oldest: "Oldest run first",
  longest: "Longest run first",
  name: "By name",
};

export interface ArchiveQuery {
  text: string;
  workflowId: string;
  status: ProposedStatus | "all";
  instance: "all" | "prod" | "test";
  sort: ArchiveSortKey;
}

export const EMPTY_ARCHIVE_QUERY: ArchiveQuery = {
  text: "",
  workflowId: "all",
  status: "all",
  instance: "all",
  sort: "newest",
};

/**
 * Everything about a run a search should match. The archive had NO search at
 * all, which meant the single most plausible reason to open it — *did we ever
 * file something for this person?* — had no answer short of reading every row.
 */
function haystack(run: ArchivedRunWire): string {
  return [
    run.title,
    run.displayName ?? "",
    run.subtitle,
    run.traceId,
    run.runId,
    run.workflowLabel,
    run.requestedBy,
    ...run.input.map((i) => `${i.label} ${i.value}`),
    ...run.receipt.lines.map((l) => `${l.label} ${l.value}`),
    run.receipt.headline,
    ...run.ledger.map((l) => `${l.system} ${l.action} ${l.confirmation}`),
    ...run.members.map((m) => `${m.name} ${m.eid ?? ""} ${m.outcome} ${m.detail}`),
    ...run.evidence.map((e) => e.ref),
  ]
    .join(" ")
    .toLowerCase();
}

/** whether ANY of this run's systems resolved to a test host */
export function archivedRunTouchedTest(run: ArchivedRunWire): boolean {
  return Object.values(run.resolvedInstance).some((v) => v === "test");
}

const SORT_INDEX = new Map(DEMO_ARCHIVE.map((run, index) => [run.runId, index]));

function durationSeconds(label: string): number {
  const hours = /(\d+)h/.exec(label);
  const minutes = /(\d+)m/.exec(label);
  const seconds = /(\d+)s/.exec(label);
  return Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0);
}

export function queryArchive(runs: readonly ArchivedRunWire[], query: ArchiveQuery): ArchivedRunWire[] {
  const text = query.text.trim().toLowerCase();
  const matched = runs.filter((run) => {
    if (query.workflowId !== "all" && run.workflowId !== query.workflowId) return false;
    if (query.status !== "all" && run.finalStatus !== query.status) return false;
    if (query.instance === "test" && !archivedRunTouchedTest(run)) return false;
    if (query.instance === "prod" && archivedRunTouchedTest(run)) return false;
    if (text && !haystack(run).includes(text)) return false;
    return true;
  });

  const sorted = [...matched];
  if (query.sort === "name") {
    sorted.sort((a, b) => (a.displayName ?? a.title).localeCompare(b.displayName ?? b.title));
  } else if (query.sort === "longest") {
    sorted.sort((a, b) => durationSeconds(b.durationLabel) - durationSeconds(a.durationLabel));
  } else {
    // Fixture order IS newest-first; the archive has no parseable instant, so
    // "oldest" is that order reversed rather than a date maths invented here.
    sorted.sort((a, b) => (SORT_INDEX.get(a.runId) ?? 0) - (SORT_INDEX.get(b.runId) ?? 0));
    if (query.sort === "oldest") sorted.reverse();
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Evidence — the pointer, as a capture the shared viewer can open
// ---------------------------------------------------------------------------

/**
 * An archived pointer, shaped for `CaptureLightbox`. The bytes are not in the
 * demo corpus and a drawn stand-in of a real system page on an evidence surface
 * is the one thing this view must never do, so the viewer renders metadata and
 * says so — the same honesty copy the live rail uses, from the same component.
 */
export function archivedCapture(item: ArchivedEvidenceWire): DemoCapture {
  return {
    id: item.id,
    label: item.label,
    kind: item.kind,
    failure: item.kind === "error",
    step: item.step,
    system: item.system,
    capturedAt: item.capturedAt,
    ref: item.ref,
    screen: item.screen,
    pageState: item.pageState,
    urlRedacted: item.urlRedacted,
    size: item.size,
    note:
      item.retention === "purged"
        ? `${item.note ? `${item.note} ` : ""}The image itself is gone — ${item.retentionAt}. The pointer is kept so the record still names what was captured.`
        : item.note,
  };
}

// ---------------------------------------------------------------------------
// Export — the surface most likely to be needed for an audit request
// ---------------------------------------------------------------------------

export function exportArchivedRunJson(run: ArchivedRunWire): string {
  return JSON.stringify(run, null, 2);
}

export function archivedRunExportName(run: ArchivedRunWire): string {
  return `archive-${run.traceId}.json`;
}

// ---------------------------------------------------------------------------
// The bump flow — two arms, and only one of them archives
// ---------------------------------------------------------------------------

export interface BumpBlockerWire {
  runId: string;
  title: string;
  workflowLabel: string;
  status: ProposedStatus;
  /** why this specific row cannot be swept */
  why: string;
  requiredResolution: string;
  /** the panel + day the operator has to go to */
  panel: string;
  day: string;
}

export interface BumpArchivableWire {
  runId: string;
  title: string;
  workflowLabel: string;
  status: ProposedStatus;
  /** the two-part tag this run ran under, as it is displayed */
  versionTag: string;
}

export interface BumpPlanWire {
  scope: BumpScope;
  kind: BumpKind;
  targets: { workflowId: DemoWorkflowId; label: string; from: string; to: string }[];
  /** terminal runs that WILL be archived if the bump proceeds — always empty for a minor */
  archivable: BumpArchivableWire[];
  /** non-terminal runs that REFUSE the bump — a minor bump can have none */
  blockers: BumpBlockerWire[];
  /** runs that keep running through a minor bump, and would have blocked a major */
  unaffected: BumpBlockerWire[];
}

const BLOCKER_WHY: Record<ProposedStatus, string> = {
  queued: "Accepted but never run. Archiving it would file a run that has no outcome at all.",
  running: "A worker owns it right now. Its writes are still landing.",
  waiting: "Sitting on a decision from you. Archiving it buries the decision, not the run.",
  parked: "A write whose outcome is UNKNOWN. This is the one the carve-out exists for.",
  verifiedDone: "",
  doneWarnings: "",
  failed: "",
  cancelled: "",
};

function blockerFor(row: DemoRow, status: ProposedStatus): BumpBlockerWire {
  return {
    runId: row.id,
    title: row.displayName ?? row.title,
    workflowLabel: row.workflow.label,
    status,
    why: BLOCKER_WHY[status],
    requiredResolution: REQUIRED_RESOLUTION[status],
    panel: row.workflow.label,
    day: row.enqueuedAt.slice(0, 10),
  };
}

/**
 * The bump's pre-flight, computed from the same rows and the same
 * `effectiveStatus` the queue renders.
 *
 * **The kind is what decides whether there is anything to pre-flight at all.**
 * A minor bump archives nothing, so no run can be swept mid-flight and there is
 * nothing to block: the non-terminal runs are listed as UNAFFECTED instead, in
 * the same place a major bump would list them as blockers, so the operator can
 * see exactly what the two arms do differently.
 */
export function deriveBumpPlan(
  scope: BumpScope,
  workflowIds: DemoWorkflowId[],
  rows: DemoRow[],
  kind: BumpKind = "major",
): BumpPlanWire {
  const ids = scope === "dashboard" ? (Object.keys(DEMO_WORKFLOWS) as DemoWorkflowId[]) : workflowIds;
  const idSet = new Set<DemoWorkflowId>(ids);
  const scoped = rows.filter((r) => idSet.has(r.workflow.id));

  const blockers: BumpBlockerWire[] = [];
  const unaffected: BumpBlockerWire[] = [];
  const archivable: BumpArchivableWire[] = [];

  for (const row of scoped) {
    const status = effectiveStatus(row);
    if (isTerminal(status)) {
      if (kind === "major") {
        archivable.push({
          runId: row.id,
          title: row.displayName ?? row.title,
          workflowLabel: row.workflow.label,
          status,
          versionTag: fmtVersionTag({ major: row.workflowVersion, minor: row.workflowMinorVersion }),
        });
      }
    } else if (kind === "major") {
      blockers.push(blockerFor(row, status));
    } else {
      unaffected.push(blockerFor(row, status));
    }
  }

  return {
    scope,
    kind,
    targets: ids.map((id) => {
      const version = descriptorVersion(DEMO_WORKFLOWS[id]);
      const next = kind === "major" ? { major: version.major + 1, minor: 0 } : { major: version.major, minor: version.minor + 1 };
      return { workflowId: id, label: DEMO_WORKFLOWS[id].label, from: fmtVersionTag(version), to: fmtVersionTag(next) };
    }),
    archivable,
    blockers,
    unaffected,
  };
}

export interface BumpResult {
  state: DemoCommandResultState;
  code?: string;
  headline: string;
  detail: string;
}

/**
 * The refusal is not a UI guard — it is the server's answer, computed from the
 * plan's own blocker list. There is no "force" arm, deliberately, and a minor
 * bump has nothing to refuse because it archives nothing.
 */
export function submitVersionBump(plan: BumpPlanWire, changeRecord: { what: string; why: string }): BumpResult {
  const targets = plan.targets.map((t) => `${t.label} ${t.from}→${t.to}`).join(", ");

  if (plan.kind === "major" && plan.blockers.length > 0) {
    const parked = plan.blockers.filter((b) => b.status === "parked").length;
    return {
      state: "rejected",
      code: "non-terminal-runs-outstanding",
      headline: `Refused — ${plan.blockers.length} run${plan.blockers.length === 1 ? "" : "s"} ${plan.blockers.length === 1 ? "is" : "are"} not terminal yet`,
      detail:
        `NOTHING was bumped and nothing was archived. A MAJOR bump moves every prior-version run out of the dashboard, so a run that is still queued, running, waiting on you or parked would be filed away mid-flight.` +
        (parked > 0
          ? ` ${parked} of them ${parked === 1 ? "is" : "are"} a PARKED WRITE — a write whose outcome is unknown may never be buried in an archive. Resolve ${parked === 1 ? "it" : "them"} present or absent first.`
          : "") +
        ` Resolve the list, then run the bump again. (If the change is presentation only, a MINOR bump archives nothing and has no blockers.)`,
    };
  }

  if (!changeRecord.what.trim() || !changeRecord.why.trim()) {
    return {
      state: "rejected",
      code: "change-record-incomplete",
      headline: "Refused — the change record is incomplete",
      detail:
        "Every bump leaves a record of what changed, why, and WHICH KIND it was, in the same store as fix records. NOTHING was bumped. An archive whose sweeps have no reason attached is an archive nobody can audit.",
    };
  }

  if (plan.kind === "minor") {
    return {
      state: "applied",
      headline: "Bumped — nothing was archived",
      detail:
        `${targets}. This is a MINOR bump: presentation only, so no run's shape moved and NOTHING left the dashboard. ` +
        (plan.unaffected.length > 0
          ? `The ${plan.unaffected.length} run${plan.unaffected.length === 1 ? "" : "s"} still in flight ${plan.unaffected.length === 1 ? "carries" : "carry"} on untouched — under a major bump ${plan.unaffected.length === 1 ? "it" : "they"} would have blocked this. `
          : "") +
        `Every existing run still renders correctly, because nothing a stored run depends on changed. The change record is attributed to ${DEMO_OPERATOR}.`,
    };
  }

  return {
    state: "applied",
    headline: `Bumped — ${plan.archivable.length} run${plan.archivable.length === 1 ? "" : "s"} archived`,
    detail:
      `${targets}. ${plan.archivable.length} prior-version run${plan.archivable.length === 1 ? "" : "s"} left the dashboard for the archive as self-contained snapshots — final row, receipt, evidence pointers, logs, steps, members, decisions and data, so nothing needs old-version code to open. ` +
      `The write ledger is untouched: what was filed in UCPath / Kuali / ServiceNow stays on record regardless. The change record is attributed to ${DEMO_OPERATOR}.`,
  };
}

// ---------------------------------------------------------------------------
// Relaunch — a real write, so it asks first
// ---------------------------------------------------------------------------

/**
 * What relaunching would create, before it creates it.
 *
 * Relaunch used to fire from ONE click with no confirm, no preview and no link
 * to what it made — on a page where at least one archived run's ledger shows a
 * real production UCPath write. For a product whose thesis is "never duplicate
 * a write", that was the wrong default.
 */
export interface RelaunchPlanWire {
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  /** the version the NEW run would execute under */
  versionTag: string;
  /** the version the archived run executed under */
  archivedVersionTag: string;
  /** the panel the new row lands in */
  panel: string;
  input: { label: string; value: string }[];
  /** the systems the new run would drive */
  systems: SystemKey[];
  /** what the ARCHIVED run already filed — the duplicate-write question, named */
  alreadyFiled: { system: string; action: string; confirmation: string }[];
  /**
   * Anything about this relaunch the operator should decide on rather than
   * discover. Deliberately does NOT restate `alreadyFiled` — that is rendered
   * loud from the ledger itself, and a bullet repeating it is the second band
   * saying what the first one said.
   */
  cautions: string[];
}

export function deriveRelaunchPlan(run: ArchivedRunWire): RelaunchPlanWire {
  const workflow = DEMO_WORKFLOWS[run.workflowId];
  const cautions: string[] = [];

  if (run.dryRun) {
    cautions.push("The archived run was a DRY RUN. The new one is not — it will write for real unless you start it as a dry run from the run modal.");
  }
  if (archivedRunTouchedTest(run)) {
    cautions.push("The archived run targeted a TEST instance. The new one resolves its instances fresh, and defaults to production.");
  }
  if (run.members.length > 0) {
    cautions.push(
      `The archived run covered ${run.members.length} people. The relaunch replays the same input, so it will cover them all again — including the ${run.members.filter((m) => m.tone === "quiet").length} that already succeeded.`,
    );
  }

  return {
    workflowId: run.workflowId,
    workflowLabel: run.workflowLabel,
    versionTag: fmtVersionTag(descriptorVersion(workflow)),
    archivedVersionTag: archivedVersionTag(run),
    panel: workflow.label,
    input: run.input,
    systems: workflow.systems,
    alreadyFiled: run.ledger.map((l) => ({ system: l.system, action: l.action, confirmation: l.confirmation })),
    cautions,
  };
}

export interface RelaunchResult {
  state: DemoCommandResultState;
  headline: string;
  detail: string;
  /** where the new run landed, so the surface can link to it rather than describe it */
  created: { runId: string; traceId: string; workflowId: DemoWorkflowId; panel: string };
}

let relaunchSequence = 0;

/** test seam — the demo's relaunch ids restart per test file */
export function resetRelaunchSequence(): void {
  relaunchSequence = 0;
}

/** Relaunch is a FRESH run on the current version — never a resume of the old one. */
export function relaunchFromArchive(run: ArchivedRunWire): RelaunchResult {
  const workflow = DEMO_WORKFLOWS[run.workflowId];
  relaunchSequence += 1;
  const traceId = `${workflow.code}-relaunch-${String(relaunchSequence).padStart(2, "0")}`;
  return {
    state: "applied",
    headline: `New ${run.workflowLabel} run enqueued on ${fmtVersionTag(descriptorVersion(workflow))}`,
    detail:
      `The archived input (${run.input.map((i) => i.label).join(", ")}) was replayed into a BRAND NEW run with its own trace id and its own receipt. ` +
      `This is not a resume of ${run.traceId} — that run stays archived exactly as it ended, at ${archivedVersionTag(run)}. ` +
      `Resuming across a version change is what the fingerprint rule forbids: the old run's checkpoints describe code that no longer exists.`,
    created: { runId: `relaunch-${relaunchSequence}`, traceId, workflowId: run.workflowId, panel: workflow.label },
  };
}
