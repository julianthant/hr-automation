/**
 * DEV-ONLY — the EXPLORER's wire shapes: a workflow DESCRIPTOR GRAPH, and a
 * run overlaid on it.
 *
 * `demo-feature-plan-2026-07-25.md` §1.6 (Explorer, Phase A) + second-look
 * §5.1: descriptor graph (nodes / edges / branches / gates / delegation +
 * per-task contracts, UI ids, dry-run boundary, editable fields) and a
 * selected-run timeline overlay (timings, attempts, checkpoint reuse, failures,
 * children, evidence).
 *
 * **Read-only-first is ratified (Q14).** There is deliberately no authoring
 * arm here — no node creation, no edge editing, no DSL. The graph answers
 * "what does this workflow DO, where does it write, and what did this run
 * actually do on it"; changing behaviour stays a code change with a version
 * bump and a change record.
 *
 * Four rules this file follows:
 *
 *  1. **The graph is authored, the overlay is DERIVED.** Node ids are the
 *     descriptor's own step labels, so a run is matched from its real
 *     `DemoRow.steps` array — recorded durations, attempts and outcomes —
 *     instead of being a second hand-authored story about the same run. A node
 *     the run never reached renders `pending`; a node it skipped says so.
 *  2. **A contract row is joined to what the run RECORDED.** `DemoRow.data` is
 *     the run's own read/write ledger, stamped with the step it happened in, so
 *     the descriptor's "this step reads Last day worked out of Kuali" sits
 *     beside "and on this run that was 07/15/2026". Neither half is authored
 *     twice.
 *  3. **Every workflow in the registry serves a graph.** A page that could only
 *     draw two of sixteen is a page about two workflows. Where a workflow's
 *     runs take more than one shape — a per-person path and a multi-value
 *     coordinator that fans out to it — both shapes are LANES of one graph,
 *     because they are one descriptor.
 *  4. **The dry-run posture is SERVED, never inferred from a missing line.**
 *     There are three of them and they are not degrees of each other: a
 *     workflow whose rehearsal stops at a boundary, a workflow that writes to a
 *     system of record and honours NO rehearsal at all, and a workflow that
 *     changes no system of record so has nothing to stop short of. The middle
 *     one is a hazard; drawing it as "no boundary" beside the third would hide
 *     it.
 */

import { isTerminal, type DemoDataPoint, type DemoRow, type DemoStep } from "./demo-data";
import type { DemoWorkflowId, SystemKey } from "./demo-wire";

// ---------------------------------------------------------------------------
// The descriptor graph
// ---------------------------------------------------------------------------

/**
 * What a node IS.
 *
 * `write` and `output` are deliberately separate. Both send a value out of the
 * run, but only one of them can change a system of record — and it is the one a
 * rehearsal exists for. A workflow whose whole product is a file on disk (a
 * roster export, a timekeeping report, a downloaded packet) has nothing a dry
 * run needs to stop short of, and calling its download a `write` would put a
 * safety question on the page that its code does not have.
 */
export type ExplorerNodeKind = "task" | "branch" | "gate" | "delegation" | "fanout" | "write" | "output";

export const NODE_KIND_LABEL: Record<ExplorerNodeKind, string> = {
  task: "Task",
  branch: "Branch",
  gate: "Gate",
  delegation: "Delegation",
  fanout: "Fan-out",
  write: "Write",
  output: "Output",
};

/**
 * ONE row of a task's contract: a value moving in one direction, between the
 * run and one named system.
 *
 * Reads and writes used to be two arrays with different fields, which is what
 * made the panel render a table, an id box AND an "editable at a checkpoint"
 * box for what is one question — *what does this step read and write, and from
 * where*. One row shape means one table.
 */
export interface ExplorerContractRow {
  dir: "read" | "write";
  /**
   * The operator's word for the value — deliberately the SAME label the run's
   * data ledger stamps (`DemoDataPoint.field`), because that is the join key
   * that puts the recorded value in the row beside the contract that promised
   * it.
   */
  field: string;
  system: SystemKey;
  /** writes only — how the outcome is proved once it has been sent */
  proof?: string;
  /** descriptor-allowlisted as correctable at a checkpoint (06 §6) */
  editable?: boolean;
  /** a row that only moves under a condition states it */
  when?: string;
}

export interface ExplorerNode {
  /** the descriptor's step label — the join key with a run's recorded steps */
  id: string;
  /**
   * Step labels an older descriptor recorded for the same node. A run stamped
   * under an earlier version still lays over this graph where the step was only
   * renamed; the alternative to carrying them is a node that reads "not on this
   * run's path" about a step the run demonstrably ran.
   */
  aliases?: string[];
  kind: ExplorerNodeKind;
  system?: SystemKey;
  /** the descriptor's own words for what this node is for — shown in the ⓘ */
  purpose: string;
  /** a dry run does not execute this node at all */
  skippedInDryRun: boolean;
  /** a conditional node states its condition in the descriptor's own words */
  when?: string;
  /** a node that hands work to another workflow */
  delegatesTo?: DemoWorkflowId;
  /**
   * Which shape of this workflow the node belongs to. Absent = the workflow has
   * one shape and the graph is one list.
   */
  lane?: string;
  contract: ExplorerContractRow[];
  /**
   * Semantic UI ids, never raw selectors. Developer detail: an operator never
   * types one, so it lives behind the ⓘ rather than costing a box on the panel.
   */
  uiIds: string[];
}

export interface ExplorerEdge {
  from: string;
  to: string;
  /** what has to be true to take this edge; absent means unconditional */
  condition?: string;
}

export interface ExplorerGraph {
  workflowId: DemoWorkflowId;
  label: string;
  /** the descriptor MAJOR this graph draws — a graph IS the run's shape */
  version: number;
  /** the presentation half, so the graph prints the same two-part tag as the row */
  minorVersion: number;
  /**
   * The first node a dry run does NOT execute — where a rehearsal stops.
   *
   * Absent means one of two very different things, and `dryRunPosture` is what
   * tells them apart: either the workflow changes no system of record, or it
   * changes one and honours no rehearsal.
   */
  dryRunBoundaryNodeId?: string;
  /** the descriptor's one-line summary of itself — shown in the ⓘ, never on the page */
  summary: string;
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
}

/**
 * What a rehearsal of this workflow is worth.
 *
 *  - `boundary` — a dry run runs the reads and stops at a drawn line.
 *  - `no-rehearsal` — it changes a system of record and has NO dry run. A
 *    hazard: there is no safe way to try it.
 *  - `no-system-write` — it changes no system of record, so every run of it is
 *    already a rehearsal and there is no line to draw.
 */
export type DryRunPosture = "boundary" | "no-rehearsal" | "no-system-write";

export function dryRunPosture(graph: ExplorerGraph): DryRunPosture {
  if (graph.dryRunBoundaryNodeId) return "boundary";
  return graph.nodes.some((node) => node.kind === "write") ? "no-rehearsal" : "no-system-write";
}

/**
 * Nodes a dry run skips that sit ABOVE the boundary line.
 *
 * A dry run skips a SET of nodes, not a suffix — separations' Job summary fills
 * the Kuali form, so a rehearsal skips it three nodes before it reaches the
 * UCPath transaction. Drawing only the line would quietly claim that everything
 * above it runs, so the graph marks these individually and this is the function
 * that finds them.
 */
export function skippedAboveBoundary(graph: ExplorerGraph): string[] {
  if (!graph.dryRunBoundaryNodeId) return [];
  const boundary = graph.nodes.findIndex((node) => node.id === graph.dryRunBoundaryNodeId);
  if (boundary < 0) return [];
  return graph.nodes.slice(0, boundary).filter((node) => node.skippedInDryRun).map((node) => node.id);
}

/** the lane a node belongs to, or the graph's single implicit lane */
export function laneOf(node: ExplorerNode): string {
  return node.lane ?? "";
}

/** every lane in the graph, in node order, with no duplicates */
export function lanesOf(graph: ExplorerGraph): string[] {
  const seen: string[] = [];
  for (const node of graph.nodes) {
    const lane = laneOf(node);
    if (!seen.includes(lane)) seen.push(lane);
  }
  return seen;
}

/** the systems any node of this graph touches, in first-seen order */
export function systemsOf(graph: ExplorerGraph): SystemKey[] {
  const seen: SystemKey[] = [];
  for (const node of graph.nodes) {
    for (const system of [node.system, ...node.contract.map((row) => row.system)]) {
      if (system && !seen.includes(system)) seen.push(system);
    }
  }
  return seen;
}

/**
 * How many contract rows the whole graph moves, split by where they LAND.
 *
 * `writes` and `files` are counted apart on purpose: a graph that says
 * "changes no system of record" beside a header reading "1 write" reads as a
 * contradiction, and it is not one — that write is a row appended to a file on
 * disk. Counting them together would make the honest chip look like a lie.
 */
export function contractTotals(graph: ExplorerGraph): { reads: number; writes: number; files: number } {
  let reads = 0;
  let writes = 0;
  let files = 0;
  for (const node of graph.nodes) {
    for (const row of node.contract) {
      if (row.dir === "read") reads += 1;
      else if (node.kind === "output") files += 1;
      else writes += 1;
    }
  }
  return { reads, writes, files };
}

// ---------------------------------------------------------------------------
// Authoring helpers — a linear path is by far the commonest shape
// ---------------------------------------------------------------------------

function chain(ids: string[]): ExplorerEdge[] {
  const edges: ExplorerEdge[] = [];
  for (let i = 0; i < ids.length - 1; i += 1) edges.push({ from: ids[i], to: ids[i + 1] });
  return edges;
}

const PER_DOCUMENT = "Per document";
const MULTI_DOCUMENT = "Multi-document start";
const PER_PERSON = "Per person";
const MULTI_PERSON = "Multi-person start";
const DELEGATED_BATCH = "Delegated batch";
const PER_PACKET = "Per packet";
const PER_SIGNER = "Per signer";

// ---------------------------------------------------------------------------
// 1 · Separations
// ---------------------------------------------------------------------------

export const SEPARATIONS_GRAPH: ExplorerGraph = {
  workflowId: "separations",
  label: "Separations",
  version: 7,
  minorVersion: 2,
  dryRunBoundaryNodeId: "UCPath transaction",
  summary:
    "Reads the separation out of Kuali, proves who the person is in UCPath, checks their timekeeping, files the UCPath transaction, then finalizes the Kuali document. Everything before the UCPath transaction is read-only; a dry run stops exactly there.",
  // The coordinator lane comes FIRST and the writing lane LAST, so the dry-run
  // boundary is the last line on the graph. Drawn the other way round, the
  // fan-out lane would render below a dashed line that says everything under it
  // can change a real system — which is not true of it.
  nodes: [
    {
      id: "Parse typed input",
      lane: MULTI_DOCUMENT,
      kind: "task",
      system: "kuali",
      purpose: "Split the typed document ids into one run each, merging any saved preset into every one of them.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Names typed", system: "kuali" },
        { dir: "read", field: "Preset merged", system: "kuali" },
      ],
      uiIds: [],
    },
    {
      id: "Member fan-out",
      lane: MULTI_DOCUMENT,
      kind: "fanout",
      purpose: "Enqueue one member run per document. Each member walks the per-document path on its own row.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: MULTI_DOCUMENT,
      kind: "task",
      purpose: "Close the coordinator once every member is terminal. A failed member never fails the coordinator.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Kuali extraction",
      lane: PER_DOCUMENT,
      kind: "task",
      system: "kuali",
      purpose: "Pull the separation facts off the Kuali document — the run's entire input beyond the person.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Last day worked", system: "kuali", editable: true },
        { dir: "read", field: "Separation date", system: "kuali", editable: true },
        { dir: "read", field: "Termination type", system: "kuali", editable: true },
        { dir: "read", field: "Department", system: "kuali" },
        { dir: "read", field: "Document number", system: "kuali" },
      ],
      uiIds: ["kuali.document.header", "kuali.document.separationPanel"],
    },
    {
      id: "Identity check",
      lane: PER_DOCUMENT,
      kind: "delegation",
      system: "ucpath",
      delegatesTo: "person-lookup",
      purpose:
        "Resolve the Kuali name to exactly one UCPath EID. Delegates to Person Lookup when the inline search does not settle it — the child keeps its own row in its own panel.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "EID", system: "ucpath", editable: true },
        { dir: "read", field: "Name", system: "ucpath" },
        { dir: "read", field: "Job record", system: "ucpath" },
        {
          dir: "write",
          field: "Employee name",
          system: "kuali",
          when: "the Kuali name is a near-miss of the UCPath one",
          proof: "the corrected name re-read on the document",
        },
      ],
      uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
    },
    {
      id: "Identity approval",
      lane: PER_DOCUMENT,
      kind: "gate",
      purpose:
        "Opens only when the resolved person differs from the typed input, or when more than one candidate matches. Nothing is written while it is open — this is a decision, not a breakage, so its status is Waiting on you.",
      skippedInDryRun: false,
      when: "resolved person ≠ typed input, or candidates > 1",
      contract: [{ dir: "read", field: "EID", system: "ucpath", editable: true }],
      uiIds: [],
    },
    {
      id: "Job summary",
      lane: PER_DOCUMENT,
      kind: "task",
      system: "ucpath",
      purpose: "Read the active job record the transaction will be filed against, and fill it into the Kuali form.",
      skippedInDryRun: true,
      contract: [
        { dir: "read", field: "Position", system: "ucpath" },
        { dir: "read", field: "Department", system: "ucpath" },
        { dir: "read", field: "Job code", system: "ucpath" },
      ],
      uiIds: ["ucpath.jobSummary.grid"],
    },
    {
      id: "Kronos search",
      lane: PER_DOCUMENT,
      kind: "task",
      system: "kronos",
      purpose: "Find the last punch and any unposted sick/holiday dates, so the effective date cannot precede real work.",
      skippedInDryRun: false,
      when: "the employee has timekeeping in the last 90 days",
      contract: [
        { dir: "read", field: "Last punch", system: "kronos" },
        { dir: "read", field: "Sick dates in window", system: "kronos" },
        { dir: "read", field: "Holiday dates", system: "kronos" },
      ],
      uiIds: ["kronos.timecard.search", "kronos.timecard.grid"],
    },
    {
      id: "UCPath transaction",
      lane: PER_DOCUMENT,
      kind: "write",
      system: "ucpath",
      purpose:
        "File the separation. THE write of this workflow — if its outcome cannot be read back, the run parks rather than retrying, because a blind retry is how somebody gets terminated twice.",
      skippedInDryRun: true,
      contract: [
        {
          dir: "write",
          field: "Separation date",
          system: "ucpath",
          proof: "confirmation number + post-submit screenshot",
        },
        { dir: "write", field: "Action", system: "ucpath", proof: "read back from the job row after submit" },
        { dir: "write", field: "Transaction number", system: "ucpath", proof: "read off the confirmation page" },
      ],
      uiIds: ["ucpath.smartHr.template", "ucpath.smartHr.submit", "ucpath.smartHr.confirmation"],
    },
    {
      id: "Kuali finalization",
      lane: PER_DOCUMENT,
      kind: "write",
      system: "kuali",
      purpose: "Close the Kuali document with the timekeeper name, so the paper trail matches the transaction.",
      skippedInDryRun: true,
      contract: [
        { dir: "write", field: "Document status", system: "kuali", proof: "document re-read as Final" },
        { dir: "write", field: "Timekeeper", system: "kuali", proof: "field re-read on the finalized document" },
      ],
      uiIds: ["kuali.document.finalizeButton", "kuali.document.timekeeperField"],
    },
  ],
  edges: [
    { from: "Kuali extraction", to: "Identity check" },
    { from: "Identity check", to: "Identity approval", condition: "resolved person ≠ typed input" },
    { from: "Identity check", to: "Job summary", condition: "exactly one confident match" },
    { from: "Identity approval", to: "Job summary", condition: "you pick an EID" },
    { from: "Job summary", to: "Kronos search", condition: "timekeeping in the last 90 days" },
    { from: "Job summary", to: "UCPath transaction", condition: "no timekeeping — Kronos is skipped" },
    { from: "Kronos search", to: "UCPath transaction" },
    { from: "UCPath transaction", to: "Kuali finalization" },
    { from: "Parse typed input", to: "Member fan-out" },
    { from: "Member fan-out", to: "Kuali extraction", condition: "each member starts the per-document path" },
    { from: "Member fan-out", to: "Rollup", condition: "every member is terminal" },
  ],
};

// ---------------------------------------------------------------------------
// 2 · Onboarding
// ---------------------------------------------------------------------------

export const ONBOARDING_GRAPH: ExplorerGraph = {
  workflowId: "onboarding",
  label: "Onboarding",
  version: 11,
  minorVersion: 1,
  dryRunBoundaryNodeId: "I-9 creation",
  summary:
    "Walks one new hire from their CRM record through the I-9 profile and the UCPath hire. A dry run stops at the I-9 creation: everything above the line reads, and neither the I-9 portal nor UCPath is written to. A rehearsal of this workflow changes no system of record.",
  nodes: [
    {
      id: "CRM extraction",
      kind: "task",
      system: "crm",
      purpose: "Read the hire's own record: wage, effective date, position number, address, and the identifiers.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Wage", system: "crm", editable: true },
        { dir: "read", field: "Effective date", system: "crm", editable: true },
        { dir: "read", field: "Position number", system: "crm" },
        { dir: "read", field: "Appointment", system: "crm" },
      ],
      uiIds: ["crm.onboardingRecord.header", "crm.onboardingRecord.dates"],
    },
    {
      id: "PDF download",
      kind: "output",
      system: "crm",
      purpose: "Pull the iDocs packet attached to the CRM record into the local documents folder.",
      skippedInDryRun: false,
      when: "the CRM record has attached documents",
      contract: [
        {
          dir: "write",
          field: "Onboarding documents",
          system: "crm",
          proof: "each file re-read from the download folder",
        },
      ],
      uiIds: ["crm.onboardingRecord.attachments"],
    },
    {
      id: "Person search",
      kind: "task",
      system: "ucpath",
      purpose: "Find out whether this hire already exists in UCPath, so a rehire is never filed as a new person.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "EID", system: "ucpath", editable: true },
        { dir: "read", field: "Name", system: "ucpath" },
        { dir: "read", field: "Existing hire transaction", system: "ucpath" },
      ],
      uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
    },
    {
      id: "Identity approval",
      kind: "gate",
      purpose:
        "Opens when the matched UCPath person's name is a different person from the one on the CRM record. It opens on a dry run too — a rehearsal that skipped the question would rehearse the wrong thing.",
      skippedInDryRun: false,
      when: "the matched person's name ≠ the CRM name",
      contract: [{ dir: "read", field: "EID", system: "ucpath", editable: true }],
      uiIds: [],
    },
    {
      id: "I-9 creation",
      kind: "write",
      system: "i9",
      purpose:
        "Create the hire's I-9 profile, unless the portal already holds one. Searches first, then creates once. This is where a rehearsal stops — an I-9 profile is a record in a federal-compliance system, and creating one for a hire that was never filed leaves a real orphan behind.",
      skippedInDryRun: true,
      contract: [
        { dir: "read", field: "Existing I-9 profile", system: "i9" },
        { dir: "write", field: "I-9 profile", system: "i9", proof: "profile id read back off the portal" },
      ],
      uiIds: ["i9.profile.create", "i9.profile.header"],
    },
    {
      id: "SmartHR transaction",
      kind: "write",
      system: "ucpath",
      purpose: "File the hire in UCPath. The transaction number is the proof, and it is read off the confirmation page.",
      skippedInDryRun: true,
      contract: [
        { dir: "write", field: "Wage", system: "ucpath", proof: "read back from the job row after submit" },
        { dir: "write", field: "Effective date", system: "ucpath", proof: "read back from the job row after submit" },
        { dir: "write", field: "Transaction number", system: "ucpath", proof: "read off the confirmation page" },
      ],
      uiIds: ["ucpath.smartHr.template", "ucpath.smartHr.submit", "ucpath.smartHr.confirmation"],
    },
  ],
  edges: [
    { from: "CRM extraction", to: "PDF download", condition: "the record has attachments" },
    { from: "CRM extraction", to: "Person search", condition: "no attachments — the download is skipped" },
    { from: "PDF download", to: "Person search" },
    { from: "Person search", to: "Identity approval", condition: "the matched name is a different person" },
    { from: "Person search", to: "I-9 creation", condition: "no match, or one confident match" },
    { from: "Identity approval", to: "I-9 creation", condition: "you pick an EID" },
    { from: "I-9 creation", to: "SmartHR transaction" },
  ],
};

// ---------------------------------------------------------------------------
// 3 · Person Lookup
// ---------------------------------------------------------------------------

export const PERSON_LOOKUP_GRAPH: ExplorerGraph = {
  workflowId: "person-lookup",
  label: "Person Lookup",
  version: 4,
  minorVersion: 0,
  summary:
    "Finds one person in UCPath, confirms they are the same person the CRM record describes, and reports what it found. It writes nothing, anywhere — so every run of it is already a rehearsal.",
  nodes: [
    {
      id: "Accept delegation",
      lane: DELEGATED_BATCH,
      kind: "task",
      system: "ucpath",
      purpose: "Take a set of people from a parent run — an OCR review, a separations document — as one delegated batch.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Member fan-out",
      lane: DELEGATED_BATCH,
      kind: "fanout",
      system: "ucpath",
      purpose: "Look each person up on their own row, so one unresolvable name never blocks the other five.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "People resolved", system: "ucpath" },
        { dir: "read", field: "Active", system: "ucpath" },
      ],
      uiIds: [],
    },
    {
      id: "Report back",
      lane: DELEGATED_BATCH,
      kind: "task",
      purpose: "Hand every member's answer back to the parent that asked, and close.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Searching",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Search UCPath's Person Org Summary for the typed EID or name and narrow to a single person.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "EID", system: "ucpath" },
        { dir: "read", field: "Name", system: "ucpath" },
        { dir: "read", field: "Department", system: "ucpath" },
        { dir: "read", field: "Job title", system: "ucpath" },
      ],
      uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
    },
    {
      id: "Cross-verification",
      lane: PER_PERSON,
      kind: "task",
      system: "crm",
      purpose:
        "Match the UCPath person against the CRM onboarding record, so a name collision cannot resolve to the wrong person.",
      skippedInDryRun: false,
      when: "a CRM record exists for the search term",
      contract: [
        { dir: "read", field: "Start date", system: "crm" },
        { dir: "read", field: "Campus email", system: "crm" },
        { dir: "read", field: "CRM match", system: "crm" },
      ],
      uiIds: ["crm.onboardingRecord.header"],
    },
    {
      id: "Active status",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Read the HR status. A separated person is a successful lookup with a negative answer, never a failure.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "HR status", system: "ucpath" },
        { dir: "read", field: "Termination date", system: "ucpath" },
      ],
      uiIds: ["ucpath.person.jobSummary"],
    },
    {
      id: "CRM dates",
      lane: PER_PERSON,
      kind: "task",
      system: "crm",
      purpose: "Read the hire and oath dates the caller asked for, and report them back.",
      skippedInDryRun: false,
      when: "the caller asked for CRM dates",
      contract: [
        { dir: "read", field: "Employment date", system: "crm" },
        { dir: "read", field: "Oath date", system: "crm" },
      ],
      uiIds: ["crm.onboardingRecord.dates"],
    },
  ],
  edges: [
    { from: "Searching", to: "Cross-verification", condition: "a CRM record exists" },
    { from: "Searching", to: "Active status", condition: "no CRM record — go straight to the status read" },
    { from: "Cross-verification", to: "Active status" },
    { from: "Active status", to: "CRM dates", condition: "the caller asked for dates" },
    { from: "Accept delegation", to: "Member fan-out" },
    { from: "Member fan-out", to: "Searching", condition: "each member starts the per-person path" },
    { from: "Member fan-out", to: "Report back", condition: "every member is terminal" },
  ],
};

// ---------------------------------------------------------------------------
// 4 · Person Match — one step, delegated only
// ---------------------------------------------------------------------------

export const PERSON_MATCH_GRAPH: ExplorerGraph = {
  workflowId: "person-match",
  label: "Person Match",
  version: 2,
  minorVersion: 0,
  summary:
    "One UCPath person search, keyed on an SSN or a date of birth plus a name, answering whether that person already exists. Delegated only, and it writes nothing.",
  nodes: [
    {
      id: "Search",
      kind: "task",
      system: "ucpath",
      purpose:
        "Search UCPath's HR-Tasks person search on the identifiers the parent holds, and hand back the first confident match or none.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Found", system: "ucpath" },
        { dir: "read", field: "Matched EID", system: "ucpath" },
        { dir: "read", field: "Matched name", system: "ucpath" },
        { dir: "read", field: "Candidates", system: "ucpath" },
      ],
      uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
    },
  ],
  edges: [],
};

// ---------------------------------------------------------------------------
// 5 · I-9 Lookup — one step, delegated only
// ---------------------------------------------------------------------------

export const I9_LOOKUP_GRAPH: ExplorerGraph = {
  workflowId: "i9-lookup",
  label: "I-9 Lookup",
  version: 3,
  minorVersion: 0,
  summary:
    "One read of the I-9 portal for one person: whether a profile exists, whether it is signed, and who the authorized representative was. Enrichment inside a parent's run; it writes nothing.",
  nodes: [
    {
      id: "Lookup",
      kind: "task",
      system: "i9",
      purpose:
        "Find the person's I-9 record and read its state. A person with no profile is a completed lookup with a negative answer, never a failure — and a portal that cannot be reached says so rather than reporting 'not found'.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "I-9 status", system: "i9" },
        { dir: "read", field: "Official signer", system: "i9" },
        { dir: "read", field: "Profile id", system: "i9" },
      ],
      uiIds: ["i9.search.form", "i9.profile.sections"],
    },
  ],
  edges: [],
};

// ---------------------------------------------------------------------------
// 6 · Work-Study — writes, and honours NO dry run
// ---------------------------------------------------------------------------

export const WORK_STUDY_GRAPH: ExplorerGraph = {
  workflowId: "work-study",
  label: "Work-Study",
  version: 5,
  minorVersion: 0,
  summary:
    "Files one PayPath work-study change in UCPath per person, effective on the date the run carries. It honours no dry run and does no pre-submit duplicate probe, so a retry can re-submit — a spreadsheet import becomes N of these runs only after a per-cell accept.",
  nodes: [
    {
      id: "Parse input",
      aliases: ["Parse typed input"],
      lane: MULTI_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Turn the typed EIDs — or an accepted spreadsheet import — into one run per person.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "People typed", system: "ucpath" }],
      uiIds: [],
    },
    {
      id: "Member fan-out",
      lane: MULTI_PERSON,
      kind: "fanout",
      purpose: "Enqueue one member run per person. Each walks the per-person path on its own row.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: MULTI_PERSON,
      kind: "task",
      purpose: "Close the coordinator once every member is terminal.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "UCPath auth",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Reach an authenticated UCPath session and land on the person the run carries.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "EID", system: "ucpath" }],
      uiIds: ["ucpath.personSearch.form"],
    },
    {
      id: "Transaction",
      aliases: ["Award update"],
      lane: PER_PERSON,
      kind: "write",
      system: "ucpath",
      purpose:
        "Open PayPath Actions, read the current award, then submit the new one against the effective date the run carries.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Prior award", system: "ucpath" },
        { dir: "read", field: "Effective date", system: "ucpath", editable: true },
        { dir: "write", field: "Award", system: "ucpath", proof: "award field re-read after submit" },
        { dir: "write", field: "Position pool", system: "ucpath", proof: "pool id re-read on the job row" },
        { dir: "write", field: "Change reason", system: "ucpath", proof: "reason code re-read on the job row" },
      ],
      uiIds: ["ucpath.payPath.actions", "ucpath.payPath.submit"],
    },
  ],
  edges: [
    { from: "UCPath auth", to: "Transaction" },
    { from: "Parse input", to: "Member fan-out" },
    { from: "Member fan-out", to: "UCPath auth", condition: "each member starts the per-person path" },
    { from: "Member fan-out", to: "Rollup", condition: "every member is terminal" },
  ],
};

// ---------------------------------------------------------------------------
// 7 · Kronos Pay Rule — writes, and honours NO dry run
// ---------------------------------------------------------------------------

export const KRONOS_PAY_RULE_GRAPH: ExplorerGraph = {
  workflowId: "kronos-pay-rule",
  label: "Kronos Pay Rule",
  version: 3,
  minorVersion: 0,
  summary:
    "Reads a person's union and current pay rule off the elections tracker, decides the correct rule, and updates it in Kronos. The decision is a branch, not a gate — no human is asked — and there is no dry run.",
  nodes: [
    {
      id: "CSV lookup",
      kind: "task",
      system: "kronos",
      purpose: "Read the person's union code, the rule they are on today, and their current and new elections.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Union code", system: "kronos" },
        { dir: "read", field: "Current pay rule", system: "kronos" },
        { dir: "read", field: "New election", system: "kronos" },
      ],
      uiIds: [],
    },
    {
      id: "Determine action",
      kind: "branch",
      purpose:
        "Decide the correct rule from the union code and election. A person already on the right rule ends here — a no-op is an outcome, not a write.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Target pay rule", system: "kronos" }],
      uiIds: [],
    },
    {
      id: "Update pay rule",
      kind: "write",
      system: "kronos",
      purpose:
        "Set the new pay rule on the person's Kronos record and read it back. Three readback gates throw rather than stamping 'Updated': the code in the cell, the effective date, and the Save button returning to disabled.",
      skippedInDryRun: false,
      when: "the target rule differs from the current one",
      contract: [
        { dir: "read", field: "Shown EID", system: "kronos" },
        { dir: "write", field: "Pay rule", system: "kronos", proof: "code re-read in the committed grid cell" },
        { dir: "write", field: "Effective date", system: "kronos", proof: "date re-read in the committed grid cell" },
      ],
      uiIds: ["kronos.people.payRuleField", "kronos.people.save"],
    },
  ],
  edges: [
    { from: "CSV lookup", to: "Determine action" },
    { from: "Determine action", to: "Update pay rule", condition: "the rule has to change" },
  ],
};

// ---------------------------------------------------------------------------
// 8 · OCR — reads a document, changes nothing
// ---------------------------------------------------------------------------

export const OCR_GRAPH: ExplorerGraph = {
  workflowId: "ocr",
  label: "OCR",
  version: 9,
  minorVersion: 1,
  summary:
    "Splits a document, reads every form off it, matches the people to a roster, looks up whoever the roster did not settle, and stops at a review. It drives no browser and changes no system — what it produces is records for something else to act on.",
  nodes: [
    {
      id: "Split pages",
      kind: "task",
      system: "i9",
      purpose: "Cut the uploaded document into pages the declared form spec can read one at a time.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Pages", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Read forms",
      kind: "task",
      system: "i9",
      purpose: "Run the form spec over each page, pull the fields it defines, and flag anything illegible.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Records read", system: "i9" },
        { dir: "read", field: "Records reported", system: "i9" },
        { dir: "read", field: "Completeness gaps", system: "i9" },
      ],
      uiIds: ["ocr.review.page", "ocr.review.record"],
    },
    {
      id: "Roster match",
      kind: "task",
      system: "i9",
      purpose: "Match each read person against the selected roster, so an EID comes off paper rather than a search.",
      skippedInDryRun: false,
      when: "a roster was selected at start",
      contract: [{ dir: "read", field: "Roster rows matched", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Person lookup",
      kind: "delegation",
      system: "ucpath",
      delegatesTo: "person-lookup",
      purpose: "Look up everybody the roster did not settle. The child keeps its own row in the Person Lookup panel.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Active people", system: "ucpath" },
        { dir: "read", field: "People resolved", system: "ucpath" },
      ],
      uiIds: [],
    },
    {
      id: "Your review",
      kind: "gate",
      purpose:
        "Park for approval. A run something delegated releases work when you approve; a standalone run has no target, so it never reaches this node at all.",
      skippedInDryRun: false,
      when: "the form spec declares an approve target",
      contract: [],
      uiIds: ["ocr.review.approve", "ocr.review.record"],
    },
    {
      id: "Done",
      kind: "task",
      purpose:
        "Complete without an approval. A read-only form spec has nothing to approve, so the run ends here rather than parking on a gate nobody can clear.",
      skippedInDryRun: false,
      when: "the form spec declares no approve target",
      contract: [],
      uiIds: [],
    },
  ],
  edges: [
    { from: "Split pages", to: "Read forms" },
    { from: "Read forms", to: "Roster match", condition: "a roster was selected" },
    { from: "Read forms", to: "Person lookup", condition: "no roster — every person is looked up" },
    { from: "Roster match", to: "Person lookup" },
    { from: "Person lookup", to: "Your review", condition: "the spec has an approve target" },
    { from: "Person lookup", to: "Done", condition: "read-only spec — nothing to approve" },
  ],
};

// ---------------------------------------------------------------------------
// 9 · Oath Signature
// ---------------------------------------------------------------------------

export const OATH_SIGNATURE_GRAPH: ExplorerGraph = {
  workflowId: "oath-signature",
  label: "Oath Signature",
  version: 6,
  minorVersion: 0,
  dryRunBoundaryNodeId: "Sign oath",
  summary:
    "Reads every signer off an oath packet, waits for your approval, then signs each person's oath in UCPath on its own row. No ServiceNow ticket — signing only.",
  nodes: [
    {
      id: "OCR extraction",
      lane: PER_PACKET,
      kind: "delegation",
      system: "i9",
      delegatesTo: "ocr",
      purpose:
        "Delegate the packet to an OCR review. That review keeps its own row in the OCR panel and is never duplicated here.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "People found", system: "i9" },
        { dir: "read", field: "Signers found", system: "i9" },
      ],
      uiIds: [],
    },
    {
      id: "Roster match",
      lane: PER_PACKET,
      kind: "task",
      system: "i9",
      purpose: "Match each signer to the selected roster so their EID comes off paper rather than a search.",
      skippedInDryRun: false,
      when: "a roster was selected at start",
      contract: [{ dir: "read", field: "Roster rows matched", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Your review",
      aliases: ["Approval"],
      lane: PER_PACKET,
      kind: "gate",
      purpose: "Approve who signs. Nothing reaches UCPath until you do — an unapprovable person is excluded, never guessed at.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["ocr.review.approve"],
    },
    {
      id: "Signer fan-out",
      lane: PER_PACKET,
      kind: "fanout",
      system: "ucpath",
      purpose: "Enqueue one signing run per approved person. Each signature is proved on its own row.",
      skippedInDryRun: false,
      contract: [
        {
          dir: "write",
          field: "Oath signatures",
          system: "ucpath",
          proof: "each signer's own run records and proves its own signature",
        },
        { dir: "write", field: "Oaths signed", system: "ucpath", proof: "the member rollup, not this row" },
      ],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: PER_PACKET,
      kind: "task",
      purpose: "Close the packet once every signer is terminal. A failed signer never fails the packet.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "CRM verify",
      lane: PER_SIGNER,
      kind: "task",
      system: "crm",
      purpose:
        "Confirm the signer against their CRM onboarding record before anything is signed in their name. No record, or an unsigned one, skips the signing outright.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "CRM onboarding", system: "crm", editable: true },
        { dir: "read", field: "Signed date", system: "crm" },
        { dir: "read", field: "Process stage", system: "crm" },
      ],
      uiIds: ["crm.onboardingRecord.header"],
    },
    {
      id: "UCPath auth",
      lane: PER_SIGNER,
      kind: "task",
      system: "ucpath",
      purpose: "Reach an authenticated UCPath session and land on the signer's Person Profile.",
      skippedInDryRun: false,
      when: "the CRM check did not skip this signer",
      contract: [{ dir: "read", field: "EID", system: "ucpath" }],
      uiIds: ["ucpath.personSearch.form"],
    },
    {
      id: "Sign oath",
      lane: PER_SIGNER,
      kind: "write",
      system: "ucpath",
      purpose:
        "Add the oath signature date row and save. A profile that already carries an oath is skipped rather than signed twice.",
      skippedInDryRun: true,
      contract: [
        { dir: "read", field: "Already has oath", system: "ucpath" },
        {
          dir: "write",
          field: "Oath signature",
          system: "ucpath",
          proof: "signature date re-read off the profile after save",
        },
      ],
      uiIds: ["ucpath.oath.signButton", "ucpath.oath.signedAt"],
    },
  ],
  edges: [
    { from: "OCR extraction", to: "Roster match", condition: "a roster was selected" },
    { from: "OCR extraction", to: "Your review", condition: "no roster — every signer is looked up" },
    { from: "Roster match", to: "Your review" },
    { from: "Your review", to: "Signer fan-out", condition: "you approve" },
    { from: "Signer fan-out", to: "CRM verify", condition: "each approved signer starts the per-signer path" },
    { from: "Signer fan-out", to: "Rollup", condition: "every signer is terminal" },
    { from: "CRM verify", to: "UCPath auth", condition: "the record is verified" },
    { from: "UCPath auth", to: "Sign oath" },
  ],
};

// ---------------------------------------------------------------------------
// 10 · Oath Upload
// ---------------------------------------------------------------------------

export const OATH_UPLOAD_GRAPH: ExplorerGraph = {
  workflowId: "oath-upload",
  label: "Oath Upload",
  version: 6,
  minorVersion: 0,
  dryRunBoundaryNodeId: "File ticket",
  summary:
    "ONE row walks the whole signed document: OCR prep, your approval, waiting for the signers, then a single ServiceNow ticket. Its signers are linked runs in the Oath Signature panel, never members of this row.",
  nodes: [
    {
      id: "OCR prep",
      kind: "delegation",
      system: "i9",
      delegatesTo: "ocr",
      purpose: "Delegate the signed document to an OCR review, which keeps its own row in the OCR panel.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Signed oaths found", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Your review",
      kind: "gate",
      purpose: "Approve the document. Nothing is filed and no signature is chased until you do; a discard files nothing at all.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["ocr.review.approve"],
    },
    {
      id: "Wait signatures",
      kind: "task",
      system: "ucpath",
      purpose:
        "Wait for every linked Oath Signature row to finish. This row signs nothing — and one missing, failed or cancelled signer throws here rather than filing a ticket for a document that is not signed.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Signatures complete", system: "ucpath" }],
      uiIds: [],
    },
    {
      id: "File ticket",
      kind: "write",
      system: "servicenow",
      purpose:
        "File exactly one ServiceNow ticket for the document with the PDF attached — once per document, never once per signer. A prior submit with no recorded ticket number stops the run instead of filing a second.",
      skippedInDryRun: true,
      contract: [
        {
          dir: "write",
          field: "ServiceNow ticket",
          system: "servicenow",
          proof: "ticket number read back off the created ticket",
        },
      ],
      uiIds: ["servicenow.ticket.form", "servicenow.ticket.submit"],
    },
  ],
  edges: chain(["OCR prep", "Your review", "Wait signatures", "File ticket"]),
};

// ---------------------------------------------------------------------------
// 11 · Emergency Contact
// ---------------------------------------------------------------------------

export const EMERGENCY_CONTACT_GRAPH: ExplorerGraph = {
  workflowId: "emergency-contact",
  label: "Emergency Contact",
  version: 4,
  minorVersion: 0,
  dryRunBoundaryNodeId: "Save",
  summary:
    "Reads each employee's emergency contact off the scanned form, waits for your approval, then fills and saves the contact in UCPath on one row per person.",
  nodes: [
    {
      id: "OCR extraction",
      lane: PER_PACKET,
      kind: "delegation",
      system: "i9",
      delegatesTo: "ocr",
      purpose: "Delegate the packet to an OCR review, which keeps its own row in the OCR panel.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Pages with a contact block", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Your review",
      lane: PER_PACKET,
      kind: "gate",
      purpose: "Approve the contacts. A page with no contact block is excluded rather than filled with a guess.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["ocr.review.approve"],
    },
    {
      id: "Member fan-out",
      lane: PER_PACKET,
      kind: "fanout",
      system: "ucpath",
      purpose: "Enqueue one fill run per approved person.",
      skippedInDryRun: false,
      contract: [{ dir: "write", field: "Contacts saved", system: "ucpath", proof: "the member rollup, not this row" }],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: PER_PACKET,
      kind: "task",
      purpose: "Close the packet once every person is terminal.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "UCPath auth",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Reach an authenticated UCPath session for this person.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "EID", system: "ucpath" }],
      uiIds: ["ucpath.personSearch.form"],
    },
    {
      id: "Navigation",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose:
        "Open this person's emergency-contact page and check the identity on it. If a primary contact already exists it is demoted here — the one mutation before the boundary, and a dry run skips it.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Employee name", system: "ucpath" },
        { dir: "read", field: "Existing contact", system: "ucpath" },
        {
          dir: "write",
          field: "Primary contact",
          system: "ucpath",
          when: "an existing primary has to be demoted",
          proof: "the demoted row re-read on the person's record",
        },
      ],
      uiIds: ["ucpath.person.emergencyContact"],
    },
    {
      id: "Fill form",
      aliases: ["Contact form"],
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Type the contact the review approved into the form, without committing it.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Contact name", system: "ucpath", editable: true },
        { dir: "read", field: "Relationship", system: "ucpath", editable: true },
        { dir: "read", field: "Phone", system: "ucpath", editable: true },
      ],
      uiIds: ["ucpath.emergencyContact.form"],
    },
    {
      id: "Save",
      lane: PER_PERSON,
      kind: "write",
      system: "ucpath",
      purpose: "Commit the contact and read it back off the person's record.",
      skippedInDryRun: true,
      contract: [
        {
          dir: "write",
          field: "Emergency contact",
          system: "ucpath",
          proof: "contact row re-read on the person's record",
        },
      ],
      uiIds: ["ucpath.emergencyContact.save"],
    },
  ],
  edges: [
    { from: "OCR extraction", to: "Your review" },
    { from: "Your review", to: "Member fan-out", condition: "you approve" },
    { from: "Member fan-out", to: "UCPath auth", condition: "each approved person starts the per-person path" },
    { from: "Member fan-out", to: "Rollup", condition: "every person is terminal" },
    { from: "UCPath auth", to: "Navigation" },
    { from: "Navigation", to: "Fill form", condition: "no exact-name duplicate already on file" },
    { from: "Fill form", to: "Save" },
  ],
};

// ---------------------------------------------------------------------------
// 12 · OnBase
// ---------------------------------------------------------------------------

export const ONBASE_GRAPH: ExplorerGraph = {
  workflowId: "onbase",
  label: "OnBase",
  version: 5,
  minorVersion: 0,
  dryRunBoundaryNodeId: "Import",
  summary:
    "Reads each person off the scanned pages, waits for your approval, then files their page into OnBase. Several uploaded files MERGE into one document, so three PDFs become one import rather than three runs.",
  nodes: [
    {
      id: "OCR extraction",
      lane: PER_PACKET,
      kind: "delegation",
      system: "i9",
      delegatesTo: "ocr",
      purpose: "Delegate the merged document to an OCR review, which keeps its own row in the OCR panel.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "People found", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Your review",
      lane: PER_PACKET,
      kind: "gate",
      purpose: "Approve who the pages belong to before anything is filed under their name.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["ocr.review.approve"],
    },
    {
      id: "Member fan-out",
      lane: PER_PACKET,
      kind: "fanout",
      system: "onbase",
      purpose: "Enqueue one import run per approved person, each carrying its own page of the merged document.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: PER_PACKET,
      kind: "task",
      purpose: "Close the packet once every import is terminal.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Authenticate",
      aliases: ["OnBase auth"],
      lane: PER_PERSON,
      kind: "task",
      system: "onbase",
      purpose: "Reach an authenticated OnBase session on the Import Document screen.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["onbase.import.screen"],
    },
    {
      id: "Prepare import",
      lane: PER_PERSON,
      kind: "task",
      system: "onbase",
      purpose: "Select the declared document type, which is what decides the keyword set the import has to fill.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Document type", system: "onbase" }],
      uiIds: ["onbase.import.documentType"],
    },
    {
      id: "Fill keywords",
      lane: PER_PERSON,
      kind: "task",
      system: "onbase",
      purpose:
        "Run the Employee Lookup and fill every required keyword. The autofilled UCPath ID must equal the one this run carries, and a blank required keyword throws before the import.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "UCPath ID", system: "onbase" },
        { dir: "read", field: "Department name", system: "onbase" },
        { dir: "write", field: "Document type", system: "onbase", proof: "re-read on the form before the import commits" },
        { dir: "write", field: "Employee ID", system: "onbase", proof: "re-read on the form before the import commits" },
      ],
      uiIds: ["onbase.import.keywordPanel"],
    },
    {
      id: "Import",
      aliases: ["Document upload"],
      lane: PER_PERSON,
      kind: "write",
      system: "onbase",
      purpose: "Commit the import. THE write of this workflow, and it is irreversible — the document now exists under the person's record.",
      skippedInDryRun: true,
      contract: [
        {
          dir: "write",
          field: "Imported document",
          system: "onbase",
          proof: "document id re-read from the person's OnBase record",
        },
      ],
      uiIds: ["onbase.import.submit", "onbase.import.confirmation"],
    },
  ],
  edges: [
    { from: "OCR extraction", to: "Your review" },
    { from: "Your review", to: "Member fan-out", condition: "you approve" },
    { from: "Member fan-out", to: "Authenticate", condition: "each approved person starts the per-person path" },
    { from: "Member fan-out", to: "Rollup", condition: "every import is terminal" },
    { from: "Authenticate", to: "Prepare import" },
    { from: "Prepare import", to: "Fill keywords" },
    { from: "Fill keywords", to: "Import" },
  ],
};

// ---------------------------------------------------------------------------
// 13 · I-9 Check — searches and records, changes no system of record
// ---------------------------------------------------------------------------

export const I9_CHECK_GRAPH: ExplorerGraph = {
  workflowId: "i9-check",
  label: "I-9 Check",
  version: 2,
  minorVersion: 0,
  summary:
    "Reads each person off a retention scan, searches UCPath for them, and appends a local retention tracker. Its review completes itself — there is nothing to approve — and no live HR system is ever mutated, which is pinned by an import guard rather than by convention.",
  nodes: [
    {
      id: "OCR extraction",
      lane: PER_PACKET,
      kind: "delegation",
      system: "i9",
      delegatesTo: "ocr",
      purpose:
        "Delegate the scan to an OCR review. That review COMPLETES rather than parking — a read-only spec has nothing to approve.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "People found", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Roster match",
      lane: PER_PACKET,
      kind: "task",
      system: "i9",
      purpose: "Match each read person against the roster, so an EID comes off paper before anybody is searched for.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Roster rows matched", system: "i9" }],
      uiIds: [],
    },
    {
      id: "Member fan-out",
      lane: PER_PACKET,
      kind: "fanout",
      system: "ucpath",
      purpose:
        "Enqueue one check per person the moment the review completes — not when you approve it, because there is no approval. A page with no name to search on becomes a failed member with no task behind it.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Rollup",
      lane: PER_PACKET,
      kind: "task",
      purpose: "Close the scan once every person is terminal.",
      skippedInDryRun: false,
      contract: [],
      uiIds: [],
    },
    {
      id: "Person match",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose: "Search UCPath for this person on the scan's identifiers. A unique hit here skips the fuller lookup below.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Matched EID", system: "ucpath" },
        { dir: "read", field: "Candidates", system: "ucpath" },
      ],
      uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
    },
    {
      id: "Person lookup",
      lane: PER_PERSON,
      kind: "task",
      system: "ucpath",
      purpose:
        "Corroborate against the hire date when the search did not settle it. An ambiguous outcome stamps no found/not-found answer at all.",
      skippedInDryRun: false,
      when: "the person search did not resolve a unique EID",
      contract: [
        { dir: "read", field: "EID", system: "ucpath" },
        { dir: "read", field: "Start date", system: "ucpath" },
      ],
      uiIds: ["ucpath.person.jobSummary"],
    },
    {
      id: "Retention tracker",
      lane: PER_PERSON,
      kind: "output",
      system: "i9",
      purpose: "Append this person's row to the master retention tracker on disk. No HR system is touched.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "I-9 separation date", system: "i9" },
        { dir: "write", field: "Retention row", system: "i9", proof: "the row re-read from the tracker file" },
      ],
      uiIds: [],
    },
  ],
  edges: [
    { from: "OCR extraction", to: "Roster match" },
    { from: "Roster match", to: "Member fan-out", condition: "the review completed" },
    { from: "Member fan-out", to: "Person match", condition: "each person starts the per-person path" },
    { from: "Member fan-out", to: "Rollup", condition: "every person is terminal" },
    { from: "Person match", to: "Person lookup", condition: "no unique EID yet" },
    { from: "Person match", to: "Retention tracker", condition: "one confident match" },
    { from: "Person lookup", to: "Retention tracker" },
  ],
};

// ---------------------------------------------------------------------------
// 14 · CRM Doc Download — the product is a file
// ---------------------------------------------------------------------------

export const CRM_DOC_DOWNLOAD_GRAPH: ExplorerGraph = {
  workflowId: "crm-doc-download",
  label: "CRM Doc Download",
  version: 3,
  minorVersion: 0,
  summary:
    "Finds a person's onboarding record in CRM and downloads the iDocs attached to it. CRM is read-only throughout — every change this workflow makes is to a local folder — so there is nothing a rehearsal would stop short of.",
  nodes: [
    {
      id: "CRM auth",
      kind: "task",
      system: "crm",
      purpose: "Reach an authenticated CRM session. A replayed session is reused when a prior attempt still holds one.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "CRM authentication", system: "crm" }],
      uiIds: ["crm.login.form"],
    },
    {
      id: "Search record",
      kind: "task",
      system: "crm",
      purpose:
        "Find the onboarding record from the typed EID or email. The fuzzy search result must be confirmed against the identifier on the record, or the run throws rather than downloading somebody else's documents.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Email searched", system: "crm", editable: true },
        { dir: "read", field: "Roster email", system: "crm", editable: true },
        { dir: "read", field: "UCPath Employee ID", system: "crm" },
      ],
      uiIds: ["crm.search.form", "crm.search.results"],
    },
    {
      id: "Download",
      kind: "output",
      system: "crm",
      purpose: "Pull every iDoc attached to the record into the person's own folder under the onboarding docs directory.",
      skippedInDryRun: false,
      contract: [
        {
          dir: "write",
          field: "Documents downloaded",
          system: "crm",
          proof: "each file re-read from the download folder",
        },
      ],
      uiIds: ["crm.onboardingRecord.attachments"],
    },
    {
      id: "Archive",
      kind: "output",
      system: "crm",
      purpose:
        "Read the person's name off the UCPath Entry Sheet, zip the folder under it, and delete the folder. Runs sharing a parent append into one combined zip under a cross-process lock.",
      skippedInDryRun: false,
      contract: [
        { dir: "read", field: "Lived name", system: "crm" },
        { dir: "write", field: "Archive zip", system: "crm", proof: "the zip listed back after the move" },
      ],
      uiIds: ["crm.entrySheet.header"],
    },
  ],
  edges: chain(["CRM auth", "Search record", "Download", "Archive"]),
};

// ---------------------------------------------------------------------------
// 15 · SharePoint Download — the product is a file
// ---------------------------------------------------------------------------

export const SHAREPOINT_DOWNLOAD_GRAPH: ExplorerGraph = {
  workflowId: "sharepoint-download",
  label: "SharePoint Download",
  version: 2,
  minorVersion: 0,
  summary:
    "Downloads the current roster export into the roster folder, then reads it back and counts its rows. Every roster-backed start reads whatever this leaves behind. It changes no system of record.",
  nodes: [
    {
      id: "SharePoint auth",
      kind: "task",
      system: "crm",
      purpose: "Reach an authenticated SharePoint session through the campus SSO.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["sharepoint.login.form"],
    },
    {
      id: "Locate export",
      kind: "task",
      system: "crm",
      purpose:
        "Open the export in the workbook viewer and check the landing page is the one expected. Any other host stops the run.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Export modified", system: "crm" }],
      uiIds: ["sharepoint.library.list"],
    },
    {
      id: "Download",
      kind: "output",
      system: "crm",
      purpose: "Pull the export into the roster folder under its own timestamped name.",
      skippedInDryRun: false,
      contract: [
        { dir: "write", field: "Roster file", system: "crm", proof: "the file re-read off disk after the download" },
      ],
      uiIds: ["sharepoint.library.download"],
    },
    {
      id: "Verify",
      kind: "task",
      system: "crm",
      purpose:
        "Read the downloaded file back and count its rows. A roster that cannot be re-read is a failed run, never a quiet one.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Rows read back", system: "crm" }],
      uiIds: [],
    },
  ],
  edges: chain(["SharePoint auth", "Locate export", "Download", "Verify"]),
};

// ---------------------------------------------------------------------------
// 16 · Old Kronos Reports — the product is a file
// ---------------------------------------------------------------------------

export const OLD_KRONOS_REPORTS_GRAPH: ExplorerGraph = {
  workflowId: "old-kronos-reports",
  label: "Old Kronos Reports",
  version: 4,
  minorVersion: 0,
  summary:
    "Builds and downloads timekeeping reports into the reports folder and appends a local status tracker. No HR record changes; a zero-byte or mismatched PDF is deleted rather than kept.",
  nodes: [
    {
      id: "Kronos auth",
      kind: "task",
      system: "kronos",
      purpose: "Reach an authenticated Old Kronos session. One Duo per worker, and the reports screen is serialized across them.",
      skippedInDryRun: false,
      contract: [],
      uiIds: ["kronos.reports.screen"],
    },
    {
      id: "Select reports",
      kind: "task",
      system: "kronos",
      purpose:
        "Find the employee in the genie and pick the reports in the requested span. No match is a recorded outcome, not a failure.",
      skippedInDryRun: false,
      when: "the start asked for a report pack",
      contract: [
        { dir: "read", field: "Reports selected", system: "kronos" },
        { dir: "read", field: "Employee name", system: "kronos" },
      ],
      uiIds: ["kronos.reports.list"],
    },
    {
      id: "Report run",
      kind: "task",
      system: "kronos",
      purpose: "Ask the builder to assemble the report and wait for it, however long the span takes.",
      skippedInDryRun: false,
      contract: [{ dir: "read", field: "Row count", system: "kronos" }],
      uiIds: ["kronos.reports.run", "kronos.reports.status"],
    },
    {
      id: "Download",
      kind: "output",
      system: "kronos",
      purpose:
        "Pull each built report into the reports folder, then check the name and id printed on it. A mismatch deletes the file rather than filing it under the wrong person.",
      skippedInDryRun: false,
      contract: [
        { dir: "write", field: "Files saved", system: "kronos", proof: "each file re-read and its printed name parsed back" },
      ],
      uiIds: ["kronos.reports.download"],
    },
    {
      id: "Archive",
      kind: "output",
      system: "kronos",
      purpose: "Append one status row per employee to the local tracker workbook.",
      skippedInDryRun: false,
      contract: [{ dir: "write", field: "Tracker row", system: "kronos", proof: "the row re-read from the tracker file" }],
      uiIds: [],
    },
  ],
  edges: [
    { from: "Kronos auth", to: "Select reports", condition: "a report pack was asked for" },
    { from: "Kronos auth", to: "Report run", condition: "a single report — nothing to select" },
    { from: "Select reports", to: "Report run" },
    { from: "Report run", to: "Download" },
    { from: "Download", to: "Archive" },
  ],
};

/**
 * Every graph the Explorer serves — one per workflow the registry holds. The
 * page used to serve two, which made it a page about two workflows rather than
 * a page about the product.
 */
export const EXPLORER_GRAPHS: ExplorerGraph[] = [
  ONBOARDING_GRAPH,
  OATH_SIGNATURE_GRAPH,
  OATH_UPLOAD_GRAPH,
  EMERGENCY_CONTACT_GRAPH,
  ONBASE_GRAPH,
  SEPARATIONS_GRAPH,
  I9_CHECK_GRAPH,
  WORK_STUDY_GRAPH,
  KRONOS_PAY_RULE_GRAPH,
  OLD_KRONOS_REPORTS_GRAPH,
  PERSON_LOOKUP_GRAPH,
  PERSON_MATCH_GRAPH,
  I9_LOOKUP_GRAPH,
  OCR_GRAPH,
  CRM_DOC_DOWNLOAD_GRAPH,
  SHAREPOINT_DOWNLOAD_GRAPH,
];

export function graphFor(workflowId: DemoWorkflowId): ExplorerGraph | undefined {
  return EXPLORER_GRAPHS.find((graph) => graph.workflowId === workflowId);
}

export function nodeById(graph: ExplorerGraph, id: string): ExplorerNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

export function edgesFrom(graph: ExplorerGraph, id: string): ExplorerEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}

// ---------------------------------------------------------------------------
// The run overlay — DERIVED from a real row's recorded steps and data ledger
// ---------------------------------------------------------------------------

export type OverlayState = "done" | "current" | "waiting" | "failed" | "skipped" | "pending" | "cancelled";

/** one value this run actually moved at this node, off the row's own ledger */
export interface OverlayRecorded {
  dir: "read" | "write";
  field: string;
  value: string;
  system: SystemKey;
  /** filled and verified, deliberately NOT submitted yet */
  staged?: boolean;
  /** submitted, but the outcome could not be read back */
  unconfirmed?: boolean;
}

export interface OverlayNode {
  nodeId: string;
  state: OverlayState;
  durationSec?: number;
  attempts?: number;
  /** the recorded key lines for this step — real log output, not a summary */
  keyLines?: string[];
  hasEvidence?: boolean;
  /** set on a delegating node whose child is the reason this node is where it is */
  childNote?: string;
  /** why a node the descriptor has never ran */
  skippedBecause?: string;
  /** what the run recorded here, joined by step label */
  recorded: OverlayRecorded[];
}

/**
 * Where this run's values came from.
 *
 * A replayed value may never be presented as a newly observed one — that is the
 * whole reason this exists. `replayed` names the checkpointed values and
 * `corrected` names the ones the operator changed by hand between attempts.
 */
export interface OverlayProvenance {
  attempt: number;
  replayed: string[];
  corrected: string[];
}

export interface ExplorerOverlay {
  runId: string;
  traceId: string;
  title: string;
  nodes: OverlayNode[];
  /** how many of the graph's nodes this run actually got to */
  reached: number;
  /**
   * How many of the graph's nodes this run recorded a step for AT ALL, whether
   * or not it got to them.
   *
   * Separate from `reached` because a QUEUED run has every step recorded and
   * none of them reached — and collapsing the two would report it as a run
   * whose shape this descriptor does not hold, which is a very different and
   * much louder claim than "it has not started".
   */
  matched: number;
  /** the graph's node count, so a coverage claim can never disagree with the graph */
  total: number;
  /** the run has not ended — a node with no step is NOT REACHED, not off-path */
  inFlight: boolean;
  /** the node the run is sitting on or stopped at, when it is not simply done */
  stoppedAtNodeId?: string;
  provenance: OverlayProvenance;
}

/** case- and qualifier-insensitive field key, so `Contact name (input)` joins `Contact name` */
export function fieldKey(field: string): string {
  return field
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function stepLabels(node: ExplorerNode): string[] {
  return [node.id, ...(node.aliases ?? [])];
}

function stepFor(steps: DemoStep[], node: ExplorerNode): DemoStep | undefined {
  const labels = stepLabels(node);
  return steps.find((step) => labels.includes(step.label));
}

function recordedFor(data: DemoDataPoint[] | undefined, node: ExplorerNode): OverlayRecorded[] {
  const labels = stepLabels(node);
  return (data ?? [])
    .filter((point) => labels.includes(point.step))
    .map((point) => ({
      dir: point.dir,
      field: point.field,
      value: point.value,
      system: point.system,
      staged: point.staged,
      unconfirmed: point.unconfirmed,
    }));
}

/** the recorded value that answers a contract row, when the run recorded one */
export function recordedForContractRow(
  recorded: readonly OverlayRecorded[],
  row: ExplorerContractRow,
): OverlayRecorded | undefined {
  const key = fieldKey(row.field);
  return recorded.find((entry) => entry.dir === row.dir && fieldKey(entry.field) === key);
}

/** recorded values with no contract row of their own — never dropped, always shown last */
export function recordedBeyondContract(
  recorded: readonly OverlayRecorded[],
  contract: readonly ExplorerContractRow[],
): OverlayRecorded[] {
  return recorded.filter(
    (entry) => !contract.some((row) => row.dir === entry.dir && fieldKey(row.field) === fieldKey(entry.field)),
  );
}

/** does a lineage entry name this contract row's value? */
export function provenanceOfRow(
  provenance: OverlayProvenance | undefined,
  row: ExplorerContractRow,
): "replayed" | "corrected" | undefined {
  if (!provenance) return undefined;
  const key = fieldKey(row.field);
  if (provenance.replayed.some((label) => fieldKey(label) === key)) return "replayed";
  if (provenance.corrected.some((label) => fieldKey(label) === key)) return "corrected";
  return undefined;
}

const STOPPED_STATES: OverlayState[] = ["failed", "waiting", "cancelled", "current"];

/**
 * Lay a run over the graph. Every fact here comes off the row: the state, the
 * recorded duration, the attempt count, the key log lines, the values moved,
 * whether evidence was captured. The only thing this function decides is what
 * to say about a node the run has no step for — and it keeps the two genuinely
 * different answers apart rather than collapsing them:
 *
 *  - the run is still in flight → **not reached yet**;
 *  - the run ended without recording it → **not on this run's path**.
 *
 * It never says "done".
 */
export function overlayForRun(graph: ExplorerGraph, row: DemoRow): ExplorerOverlay {
  const gateOpen = Boolean(row.gate);
  const inFlight = !isTerminal(row.status);
  let reached = 0;
  let matched = 0;

  const nodes: OverlayNode[] = graph.nodes.map((node) => {
    const recorded = recordedFor(row.data, node);

    if (node.kind === "gate") {
      // A RECORDED STEP ALWAYS WINS. Most gates have no step of their own and
      // are inferred from the run's `gate`, but some workflows do record one
      // (an approval a packet walked through and closed) — and inferring from a
      // gate object that is no longer there reported a step the run
      // demonstrably ran as "off this path".
      const gateStep = stepFor(row.steps, node);
      if (gateStep) {
        matched += 1;
        if (gateStep.state !== "pending") reached += 1;
        return {
          nodeId: node.id,
          state: gateStep.state,
          durationSec: gateStep.durationSec,
          attempts: gateStep.attempts,
          keyLines: gateStep.keyLines ?? (row.gate ? [row.gate.title] : undefined),
          hasEvidence: gateStep.hasShot,
          recorded,
        };
      }
      // No step: the state is the run's own gate, which is why a run with no
      // gate shows it skipped rather than pending — the condition was evaluated
      // and came back false.
      const touched = row.steps.some((step) => step.state !== "pending");
      if (gateOpen) {
        reached += 1;
        matched += 1;
        return {
          nodeId: node.id,
          state: row.status === "waiting" || row.status === "parked" ? "waiting" : "done",
          keyLines: row.gate ? [row.gate.title] : undefined,
          recorded,
        };
      }
      return {
        nodeId: node.id,
        state: touched ? "skipped" : "pending",
        skippedBecause: touched ? "no decision was needed on this run" : undefined,
        recorded,
      };
    }

    const step = stepFor(row.steps, node);
    if (!step) {
      return inFlight
        ? { nodeId: node.id, state: "pending", skippedBecause: "not reached yet", recorded }
        : { nodeId: node.id, state: "skipped", skippedBecause: "not on this run's path", recorded };
    }
    matched += 1;
    if (step.state !== "pending") reached += 1;
    return {
      nodeId: node.id,
      state: step.state,
      durationSec: step.durationSec,
      attempts: step.attempts,
      keyLines: step.keyLines,
      hasEvidence: step.hasShot,
      recorded,
      childNote:
        node.kind === "delegation" && row.mirroredFrom
          ? `Delegated to ${row.mirroredFrom} — that child's error is mirrored onto this run verbatim.`
          : node.kind === "delegation" && row.linkedGroup
            ? `Delegated — the child keeps its own row in the ${row.linkedGroup.panel} panel.`
            : undefined,
    };
  });

  const stopped = nodes.find((node) => STOPPED_STATES.includes(node.state));

  const provenance: OverlayProvenance = {
    attempt: row.attempt ?? 1,
    replayed: (row.lineage?.diff ?? []).filter((entry) => entry.kind === "checkpoint").map((entry) => entry.label),
    corrected: (row.lineage?.diff ?? []).filter((entry) => entry.kind === "correction").map((entry) => entry.label),
  };

  return {
    runId: row.id,
    traceId: row.trace,
    title: row.displayName ?? row.title,
    nodes,
    reached,
    matched,
    total: graph.nodes.length,
    inFlight,
    stoppedAtNodeId: stopped?.nodeId,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// The run selector
// ---------------------------------------------------------------------------

/**
 * One run offered for overlay, with the two facts the selector needs to be
 * honest about it: how much of THIS graph it covers, and whether it took a
 * shape the graph does not hold at all.
 */
export interface ExplorerRunOption {
  row: DemoRow;
  reached: number;
  total: number;
  /**
   * The run recorded no step this graph draws — a shape this descriptor lost.
   *
   * Keyed on `matched`, not `reached`: a QUEUED run has recorded every step and
   * got to none of them, and calling that "off this shape" would be a much
   * louder claim than the true one, which is that it has not started.
   */
  offGraph: boolean;
}

/**
 * Every run in the corpus that can be laid over this graph, most-covered first.
 *
 * A run is OFFERED even when it covers nothing: a run whose shape the descriptor
 * no longer holds is a real thing that happened, and dropping it from the list
 * would teach the operator the workflow had fewer runs than it did. The selector
 * marks it instead.
 */
export function explorerRunOptions(graph: ExplorerGraph, rows: readonly DemoRow[]): ExplorerRunOption[] {
  return rows
    .filter((row) => row.workflow.id === graph.workflowId && row.steps.length > 0)
    .map((row) => {
      const overlay = overlayForRun(graph, row);
      return { row, reached: overlay.reached, total: overlay.total, offGraph: overlay.matched === 0 };
    })
    .sort((a, b) => b.reached - a.reached || a.row.id.localeCompare(b.row.id));
}
