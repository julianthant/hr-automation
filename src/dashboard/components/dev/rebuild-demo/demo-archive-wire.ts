/**
 * DEV-ONLY — the ARCHIVE + VERSION-REGISTRY half of the wire contract.
 *
 * The ratified model (`docs/rebuild/reviews/second-look-2026-07-22.md` §6.6,
 * pinned as a contract in `docs/rebuild/03-tracker-dashboard.md` §10.2):
 *
 *  - The dashboard's active surfaces, counts and filters contain **current-version
 *    runs only**.
 *  - When a workflow's version bumps, every prior-version run leaves the
 *    dashboard for a read-only **Archive**, stored as **self-contained data** —
 *    final projected row + receipt + evidence pointers — so rendering an
 *    archived run needs ZERO old-version code. That is why the shapes below
 *    carry their own receipt and their own input instead of a row id to
 *    re-project.
 *  - **The write ledger is never archived.** Archiving is a display lifecycle;
 *    the ledger is an audit one, so every archived run still lists what it
 *    filed.
 *  - **Relaunch from archive is a FRESH run on the current version** from the
 *    archived immutable input. Never a resume.
 *  - **A bump cannot archive a non-terminal run.** Queued / running / waiting /
 *    parked runs must be terminalized or resolved FIRST, and the bump flow
 *    lists them. An unresolved possible-submit is never buried in an archive.
 *
 * The last rule is the one this file makes mechanical: `deriveBumpPlan` reads
 * the SAME corpus and the SAME `effectiveStatus` the queue reads, so the
 * blocker list cannot drift from what the queue is showing — and
 * `submitVersionBump` refuses on its own derived output rather than on a flag a
 * fixture set.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoCommandResultState } from "./demo-commands";
import type { DemoRow } from "./demo-data";
import { effectiveStatus } from "./demo-data";
import { DEMO_DAYS, topLevelRowsForDay } from "./demo-days";
import { DEMO_APP_VERSION, DEMO_OPERATOR, DEMO_WORKFLOWS, type DemoWorkflowId } from "./demo-wire";

// ---------------------------------------------------------------------------
// Terminality — the whole safety carve-out turns on this one predicate
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES: ProposedStatus[] = ["verifiedDone", "doneWarnings", "failed", "cancelled"];

export function isTerminal(status: ProposedStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * What a non-terminal run has to become before a bump may archive it. Parked is
 * the one that is not negotiable for convenience — it is the status that means
 * "we may already have filed something".
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
// Version registry — the dashboard's authoritative "what version is each workflow"
// ---------------------------------------------------------------------------

export interface VersionRegistryEntry {
  workflowId: DemoWorkflowId;
  label: string;
  code: string;
  currentVersion: number;
  appVersion: string;
  /** listed runs stamped with the current version */
  atCurrentVersion: number;
  /** listed runs stamped with an OLDER version — leftovers a sweep would archive */
  atPriorVersion: number;
  /** listed runs that are not terminal — these BLOCK the next bump */
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
      currentVersion: wf.version,
      appVersion: DEMO_APP_VERSION,
      atCurrentVersion: mine.filter((r) => r.workflowVersion === wf.version).length,
      atPriorVersion: mine.filter((r) => r.workflowVersion < wf.version).length,
      nonTerminal: mine.filter((r) => !isTerminal(effectiveStatus(r))).length,
      archived: DEMO_ARCHIVE.filter((a) => a.workflowId === wf.id).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Change records — what/why/version/commit, one per bump
// ---------------------------------------------------------------------------

export type BumpScope = "workflow" | "multi-workflow" | "dashboard";

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

export interface ChangeRecordWire {
  id: string;
  scope: BumpScope;
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

export const DEMO_CHANGE_RECORDS: ChangeRecordWire[] = [
  {
    id: "chg-ec-4",
    scope: "workflow",
    workflowIds: ["emergency-contact"],
    at: "Jul 22, 4:41 PM",
    by: DEMO_OPERATOR,
    what: "Emergency Contact now reads the relationship field from the form instead of defaulting it to “Other”.",
    why: "A defaulted relationship is a silent wrong value on a real record — the field is now required and the run fails loud when the page does not carry one.",
    commit: "a5ac547",
    fromVersion: "v3",
    toVersion: "v4",
    archivedRuns: 3,
  },
  {
    id: "chg-app-2026073",
    scope: "dashboard",
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
    workflowIds: ["ocr"],
    at: "Jul 18, 11:20 AM",
    by: DEMO_OPERATOR,
    what: "OCR holds tier-1 model patience for the whole batch instead of degrading to a weaker tier partway through.",
    why: "Mid-batch tier drift is what makes a weak model invent handwritten SSNs. Behaviour change, so the guard forced a bump.",
    commit: "9022c14",
    fromVersion: "v8",
    toVersion: "v9",
    archivedRuns: 0,
  },
];

// ---------------------------------------------------------------------------
// Archived runs — SELF-CONTAINED. No old-version code renders these.
// ---------------------------------------------------------------------------

export interface ArchivedReceiptLine {
  label: string;
  value: string;
  verified?: boolean;
}

export interface ArchivedRunWire {
  runId: string;
  traceId: string;
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  workflowCode: string;
  /** the version this run RAN under — never the registry's current one */
  workflowVersion: number;
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
  receipt: {
    headline: string;
    confidence: "verified" | "partial" | "unknown";
    lines: ArchivedReceiptLine[];
  };
  /** content-addressed pointers — the images themselves are not in the archive row */
  evidence: { kind: "step" | "error" | "confirmation"; label: string; ref: string }[];
  /** the immutable input a relaunch would replay — the only re-runnable part */
  input: { label: string; value: string }[];
  /** the ledger is NEVER archived; an archived run still says what it filed */
  ledger: { system: string; action: string; confirmation: string; instance: "prod" | "test" }[];
}

export const DEMO_ARCHIVE: ArchivedRunWire[] = [
  {
    runId: "arch-ec-tomas-v3",
    traceId: "ec-091452-4a02",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
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
    receipt: {
      headline: "Cancelled at Navigation — nothing written",
      confidence: "unknown",
      lines: [
        { label: "Reached", value: "UCPath navigation" },
        { label: "Written", value: "nothing", verified: true },
        { label: "Relationship read", value: "— (v3 defaulted this field; that is what v4 fixed)" },
      ],
    },
    evidence: [{ kind: "step", label: "UCPath landing page", ref: "sha256:9f2c…a41" }],
    input: [
      { label: "Name", value: "Tomás Rivera" },
      { label: "EID", value: "10443321" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 4" },
    ],
    ledger: [],
  },
  {
    runId: "arch-ec-noor-v3",
    traceId: "ec-081120-77bd",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
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
      { kind: "confirmation", label: "UCPath confirmation panel", ref: "sha256:1b70…c02" },
      { kind: "step", label: "Contact form page 2", ref: "sha256:4ae1…9dd" },
    ],
    input: [
      { label: "Name", value: "Noor Haddad" },
      { label: "EID", value: "10502774" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 2" },
    ],
    ledger: [
      { system: "ucpath", action: "Emergency contact written", confirmation: "UCP-2026-0722-44119", instance: "prod" },
    ],
  },
  {
    runId: "arch-ec-derek-v3",
    traceId: "ec-081702-2c19",
    workflowId: "emergency-contact",
    workflowLabel: "Emergency Contact",
    workflowCode: "ec",
    workflowVersion: 3,
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
    evidence: [{ kind: "confirmation", label: "UCPath confirmation panel", ref: "sha256:77ea…31f" }],
    input: [
      { label: "Name", value: "Derek Osei" },
      { label: "EID", value: "10511903" },
      { label: "Contact form", value: "ec-intake-2026-07-22.pdf · page 3" },
    ],
    ledger: [
      { system: "ucpath", action: "Emergency contact written", confirmation: "UCP-2026-0722-44127", instance: "prod" },
    ],
  },
  {
    runId: "arch-sep-imani-app2",
    traceId: "se-101204-b6f0",
    workflowId: "separations",
    workflowLabel: "Separations",
    workflowCode: "se",
    workflowVersion: 6,
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
      { kind: "confirmation", label: "UCPath post-submit confirmation", ref: "sha256:0c31…88a" },
      { kind: "step", label: "Kuali finalization", ref: "sha256:b402…7e1" },
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
  },
  {
    runId: "arch-ou-spring-app2",
    traceId: "ou-134410-e551",
    workflowId: "oath-upload",
    workflowLabel: "Oath Upload",
    workflowCode: "ou",
    workflowVersion: 5,
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
    receipt: {
      headline: "Ticket filed after all 12 signers completed",
      confidence: "verified",
      lines: [
        { label: "Signers", value: "12 of 12 signed and read back", verified: true },
        { label: "ServiceNow ticket", value: "INC0448120", verified: true },
        { label: "Document", value: "Oath_Packet_Spring.pdf · 12 pages" },
      ],
    },
    evidence: [{ kind: "confirmation", label: "ServiceNow ticket", ref: "sha256:aa19…b30" }],
    input: [{ label: "Document", value: "Oath_Packet_Spring.pdf" }],
    ledger: [
      { system: "servicenow", action: "Ticket filed", confirmation: "INC0448120", instance: "prod" },
    ],
  },
  {
    runId: "arch-ws-cohort-app2",
    traceId: "ws-090015-31c8",
    workflowId: "work-study",
    workflowLabel: "Work-Study",
    workflowCode: "ws",
    workflowVersion: 4,
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
    receipt: {
      headline: "13 of 14 updated · 1 not found",
      confidence: "partial",
      lines: [
        { label: "Updated", value: "13", verified: true },
        { label: "Not found in UCPath", value: "1 — Rae Lindqvist, EID 10559002" },
        { label: "Award year", value: "2026–2027" },
      ],
    },
    evidence: [{ kind: "error", label: "Person search — no results", ref: "sha256:5fd2…104" }],
    input: [
      { label: "Roster", value: "work-study-2026-fall.xlsx" },
      { label: "Award year", value: "2026–2027" },
    ],
    ledger: [
      { system: "ucpath", action: "13 work-study rows written", confirmation: "UCP-2026-0719-90xxx (13 entries)", instance: "prod" },
    ],
  },
  {
    runId: "arch-onb-kai-app2",
    traceId: "on-112207-d904",
    workflowId: "onboarding",
    workflowLabel: "Onboarding",
    workflowCode: "on",
    workflowVersion: 10,
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
    receipt: {
      headline: "Failed at I-9 section 2 — document expired",
      confidence: "verified",
      lines: [
        { label: "Reached", value: "I-9 section 2" },
        { label: "Written", value: "nothing in UCPath", verified: true },
        { label: "Reason", value: "List A document expired 2026-06-30; I-9 refuses it at the source" },
      ],
    },
    evidence: [{ kind: "error", label: "I-9 rejection banner", ref: "sha256:c110…2fa" }],
    input: [
      { label: "Name", value: "Kai Nakamura" },
      { label: "EID", value: "10620551" },
      { label: "CRM case", value: "CRM-2026-31188" },
    ],
    ledger: [],
  },
];

export function archiveForBump(bumpId: string): ArchivedRunWire[] {
  return DEMO_ARCHIVE.filter((run) => run.bumpId === bumpId);
}

// ---------------------------------------------------------------------------
// The bump flow — derived from the LIVE corpus, refused on its own output
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
  workflowVersion: number;
}

export interface BumpPlanWire {
  scope: BumpScope;
  targets: { workflowId: DemoWorkflowId; label: string; from: number; to: number }[];
  /** terminal runs that WILL be archived if the bump proceeds */
  archivable: BumpArchivableWire[];
  /** non-terminal runs that REFUSE the bump until they are resolved */
  blockers: BumpBlockerWire[];
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

/**
 * The bump's pre-flight, computed from the same rows and the same
 * `effectiveStatus` the queue renders. A blocker list derived any other way
 * could disagree with what the operator is looking at.
 */
export function deriveBumpPlan(scope: BumpScope, workflowIds: DemoWorkflowId[], rows: DemoRow[]): BumpPlanWire {
  const ids = scope === "dashboard" ? (Object.keys(DEMO_WORKFLOWS) as DemoWorkflowId[]) : workflowIds;
  const idSet = new Set<DemoWorkflowId>(ids);
  const scoped = rows.filter((r) => idSet.has(r.workflow.id));

  const blockers: BumpBlockerWire[] = [];
  const archivable: BumpArchivableWire[] = [];
  for (const row of scoped) {
    const status = effectiveStatus(row);
    if (isTerminal(status)) {
      archivable.push({
        runId: row.id,
        title: row.displayName ?? row.title,
        workflowLabel: row.workflow.label,
        status,
        workflowVersion: row.workflowVersion,
      });
    } else {
      blockers.push({
        runId: row.id,
        title: row.displayName ?? row.title,
        workflowLabel: row.workflow.label,
        status,
        why: BLOCKER_WHY[status],
        requiredResolution: REQUIRED_RESOLUTION[status],
        panel: row.workflow.label,
        day: row.enqueuedAt.slice(0, 10),
      });
    }
  }

  return {
    scope,
    targets: ids.map((id) => ({
      workflowId: id,
      label: DEMO_WORKFLOWS[id].label,
      from: DEMO_WORKFLOWS[id].version,
      to: DEMO_WORKFLOWS[id].version + 1,
    })),
    archivable,
    blockers,
  };
}

export interface BumpResult {
  state: DemoCommandResultState;
  code?: string;
  headline: string;
  detail: string;
}

/**
 * The refusal is not a UI guard — it is the server's answer, and it is computed
 * from the plan's own blocker list. There is no "force" arm, deliberately.
 */
export function submitVersionBump(plan: BumpPlanWire, changeRecord: { what: string; why: string }): BumpResult {
  const targets = plan.targets.map((t) => `${t.label} v${t.from}→v${t.to}`).join(", ");

  if (plan.blockers.length > 0) {
    const parked = plan.blockers.filter((b) => b.status === "parked").length;
    return {
      state: "rejected",
      code: "non-terminal-runs-outstanding",
      headline: `Refused — ${plan.blockers.length} run${plan.blockers.length === 1 ? "" : "s"} ${plan.blockers.length === 1 ? "is" : "are"} not terminal yet`,
      detail:
        `NOTHING was bumped and nothing was archived. A version bump moves every prior-version run out of the dashboard, so a run that is still queued, running, waiting on you or parked would be filed away mid-flight.` +
        (parked > 0
          ? ` ${parked} of them ${parked === 1 ? "is" : "are"} a PARKED WRITE — a write whose outcome is unknown may never be buried in an archive. Resolve ${parked === 1 ? "it" : "them"} present or absent first.`
          : "") +
        ` Resolve the list, then run the bump again.`,
    };
  }

  if (!changeRecord.what.trim() || !changeRecord.why.trim()) {
    return {
      state: "rejected",
      code: "change-record-incomplete",
      headline: "Refused — the change record is incomplete",
      detail:
        "Every bump leaves a record of what changed and why, in the same store as fix records. NOTHING was bumped. An archive whose sweeps have no reason attached is an archive nobody can audit.",
    };
  }

  return {
    state: "applied",
    headline: `Bumped — ${plan.archivable.length} run${plan.archivable.length === 1 ? "" : "s"} archived`,
    detail:
      `${targets}. ${plan.archivable.length} prior-version run${plan.archivable.length === 1 ? "" : "s"} left the dashboard for the archive as self-contained snapshots — final row, receipt and evidence pointers, so nothing needs old-version code to open. ` +
      `The write ledger is untouched: what was filed in UCPath / Kuali / ServiceNow stays on record regardless. The change record is attributed to ${DEMO_OPERATOR}.`,
  };
}

export interface RelaunchResult {
  state: DemoCommandResultState;
  headline: string;
  detail: string;
}

/** Relaunch is a FRESH run on the current version — never a resume of the old one. */
export function relaunchFromArchive(run: ArchivedRunWire): RelaunchResult {
  const current = DEMO_WORKFLOWS[run.workflowId].version;
  return {
    state: "applied",
    headline: `New ${run.workflowLabel} run enqueued on v${current}`,
    detail:
      `The archived input (${run.input.map((i) => i.label).join(", ")}) was replayed into a BRAND NEW run with its own trace id and its own receipt. ` +
      `This is not a resume of ${run.traceId} — that run stays archived exactly as it ended, at v${run.workflowVersion}. ` +
      `Resuming across a version change is what the fingerprint rule forbids: the old run's checkpoints describe code that no longer exists.`,
  };
}
