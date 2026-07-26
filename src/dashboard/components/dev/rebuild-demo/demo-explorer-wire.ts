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
 * The honesty rule this file follows: **the graph is authored, the overlay is
 * DERIVED.** Node ids are the separations descriptor's own step labels, so the
 * overlay is matched from a real `DemoRow.steps` array — the run's recorded
 * durations, attempts and outcomes — instead of being a second hand-authored
 * story about the same run. A node the descriptor has and the run never
 * reached renders `pending`; a node the run skipped says which branch condition
 * skipped it.
 */

import type { DemoRow, DemoStep } from "./demo-data";
import type { DemoWorkflowId, SystemKey } from "./demo-wire";

// ---------------------------------------------------------------------------
// The descriptor graph
// ---------------------------------------------------------------------------

export type ExplorerNodeKind = "task" | "gate" | "write" | "delegation";

export const NODE_KIND_LABEL: Record<ExplorerNodeKind, string> = {
  task: "Task",
  gate: "Gate",
  write: "Write",
  delegation: "Delegation",
};

export interface ExplorerContract {
  /** what the task reads out of a system — the values the Data tab shows */
  reads: { field: string; system: SystemKey }[];
  /** what it writes INTO a system, and how the write is proved */
  writes: { field: string; system: SystemKey; proof: string }[];
  /**
   * Semantic UI ids, never raw selectors. A descriptor that named selectors
   * would break every time a page moved a div; a semantic id survives.
   */
  uiIds: string[];
  /** descriptor-allowlisted editable checkpoint paths (06 §6) */
  editableFields: string[];
}

export interface ExplorerNode {
  /** the descriptor's step label — the join key with a run's recorded steps */
  id: string;
  kind: ExplorerNodeKind;
  system?: SystemKey;
  purpose: string;
  /** true from the first node that can change a real HR system onwards */
  afterDryRunBoundary: boolean;
  /** a conditional node states its condition in the descriptor's own words */
  when?: string;
  /** a node that hands work to another workflow */
  delegatesTo?: DemoWorkflowId;
  contract: ExplorerContract;
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
  version: number;
  /** the node the dry-run boundary sits in front of */
  dryRunBoundaryNodeId: string;
  summary: string;
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
}

/**
 * Separations v7. Node ids are exactly the step labels the separations fixtures
 * record, which is what lets a real run be laid over this graph rather than
 * described beside it.
 */
export const SEPARATIONS_GRAPH: ExplorerGraph = {
  workflowId: "separations",
  label: "Separations",
  version: 7,
  dryRunBoundaryNodeId: "UCPath transaction",
  summary:
    "Reads the separation out of Kuali, proves who the person is in UCPath, checks their timekeeping, files the UCPath transaction, then finalizes the Kuali document. Everything before the UCPath transaction is read-only; a dry run stops exactly there.",
  nodes: [
    {
      id: "Kuali extraction",
      kind: "task",
      system: "kuali",
      purpose: "Pull the separation facts off the Kuali document — the run's entire input beyond the person.",
      afterDryRunBoundary: false,
      contract: {
        reads: [
          { field: "lastDayWorked", system: "kuali" },
          { field: "terminationType", system: "kuali" },
          { field: "department", system: "kuali" },
          { field: "documentNumber", system: "kuali" },
        ],
        writes: [],
        uiIds: ["kuali.document.header", "kuali.document.separationPanel"],
        editableFields: ["lastDayWorked", "terminationType"],
      },
    },
    {
      id: "Identity check",
      kind: "delegation",
      system: "ucpath",
      delegatesTo: "person-lookup",
      purpose:
        "Resolve the Kuali name to exactly one UCPath EID. Delegates to Person Lookup when the inline search does not settle it — the child keeps its own row in its own panel.",
      afterDryRunBoundary: false,
      contract: {
        reads: [
          { field: "eid", system: "ucpath" },
          { field: "personName", system: "ucpath" },
          { field: "jobRecord", system: "ucpath" },
        ],
        writes: [],
        uiIds: ["ucpath.personSearch.form", "ucpath.personSearch.results"],
        editableFields: ["eid"],
      },
    },
    {
      id: "Identity approval",
      kind: "gate",
      purpose:
        "Opens only when the resolved person differs from the typed input, or when more than one candidate matches. Nothing is written while it is open — this is a decision, not a breakage, so its status is Waiting on you.",
      afterDryRunBoundary: false,
      when: "resolved person ≠ typed input, or candidates > 1",
      contract: {
        reads: [],
        writes: [],
        uiIds: [],
        editableFields: ["eid"],
      },
    },
    {
      id: "Job summary",
      kind: "task",
      system: "ucpath",
      purpose: "Read the active job record the transaction will be filed against — department, job code, comp rate.",
      afterDryRunBoundary: false,
      contract: {
        reads: [
          { field: "jobRecord", system: "ucpath" },
          { field: "department", system: "ucpath" },
          { field: "compRate", system: "ucpath" },
        ],
        writes: [],
        uiIds: ["ucpath.jobSummary.grid"],
        editableFields: [],
      },
    },
    {
      id: "Kronos search",
      kind: "task",
      system: "kronos",
      purpose: "Find the last punch and any unposted sick/vacation dates, so the effective date cannot precede real work.",
      afterDryRunBoundary: false,
      when: "the employee has timekeeping in the last 90 days",
      contract: {
        reads: [
          { field: "lastPunch", system: "kronos" },
          { field: "unpostedDates", system: "kronos" },
        ],
        writes: [],
        uiIds: ["kronos.timecard.search", "kronos.timecard.grid"],
        editableFields: [],
      },
    },
    {
      id: "UCPath transaction",
      kind: "write",
      system: "ucpath",
      purpose:
        "File the separation. THE write of this workflow — if its outcome cannot be read back, the run parks rather than retrying, because a blind retry is how somebody gets terminated twice.",
      afterDryRunBoundary: true,
      contract: {
        reads: [{ field: "confirmationNumber", system: "ucpath" }],
        writes: [
          { field: "separationEffectiveDate", system: "ucpath", proof: "confirmation number + post-submit screenshot" },
          { field: "terminationReason", system: "ucpath", proof: "read back from the job row after submit" },
        ],
        uiIds: ["ucpath.smartHr.template", "ucpath.smartHr.submit", "ucpath.smartHr.confirmation"],
        editableFields: [],
      },
    },
    {
      id: "Kuali finalization",
      kind: "write",
      system: "kuali",
      purpose: "Close the Kuali document with the timekeeper name, so the paper trail matches the transaction.",
      afterDryRunBoundary: true,
      contract: {
        reads: [],
        writes: [{ field: "documentStatus", system: "kuali", proof: "document re-read as Final" }],
        uiIds: ["kuali.document.finalizeButton", "kuali.document.timekeeperField"],
        editableFields: [],
      },
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
  ],
};

// ---------------------------------------------------------------------------
// The run overlay — DERIVED from a real row's recorded steps
// ---------------------------------------------------------------------------

export type OverlayState = "done" | "current" | "waiting" | "failed" | "skipped" | "pending" | "cancelled";

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
}

export interface ExplorerOverlay {
  runId: string;
  traceId: string;
  title: string;
  nodes: OverlayNode[];
  /**
   * How much of this run's data was READ LIVE versus replayed. Typed, because
   * replayed data may never be presented as newly observed.
   */
  reuse: { kind: "fresh-live" | "checkpoint" | "correction" | "proof"; label: string; note: string }[];
}

function stepByLabel(steps: DemoStep[], label: string): DemoStep | undefined {
  return steps.find((step) => step.label === label);
}

/**
 * Lay a run over the graph. Every fact here comes off the row: the state, the
 * recorded duration, the attempt count, the key log lines, whether evidence was
 * captured. The only thing this function decides is what to say about a node
 * the run has no step for — and it says "not reached", never "done".
 */
export function overlayForRun(graph: ExplorerGraph, row: DemoRow): ExplorerOverlay {
  const gateOpen = Boolean(row.gate);
  const nodes: OverlayNode[] = graph.nodes.map((node) => {
    if (node.kind === "gate") {
      // The gate is a descriptor node with no recorded step — its state is the
      // run's own gate, which is why a run with no gate shows it skipped rather
      // than pending (the condition was evaluated and came back false).
      const reached = row.steps.some((step) => step.state !== "pending");
      if (gateOpen) {
        return {
          nodeId: node.id,
          state: row.status === "waiting" ? "waiting" : "done",
          keyLines: row.gate ? [row.gate.title] : undefined,
        };
      }
      return {
        nodeId: node.id,
        state: reached ? "skipped" : "pending",
        skippedBecause: reached ? "the resolved person matched the typed input, so no decision was needed" : undefined,
      };
    }

    const step = stepByLabel(row.steps, node.id);
    if (!step) {
      // Two genuinely different facts, and conflating them would be the lie:
      // a run still in flight has NOT REACHED the node; a run that ended never
      // recorded one, so the node was not on its path.
      const live = row.steps.some((s) => s.state === "current" || s.state === "waiting" || s.state === "pending");
      return live
        ? { nodeId: node.id, state: "pending", skippedBecause: "not reached yet" }
        : {
            nodeId: node.id,
            state: "skipped",
            skippedBecause: "no step recorded — this node was not on this run's path",
          };
    }
    return {
      nodeId: node.id,
      state: step.state,
      durationSec: step.durationSec,
      attempts: step.attempts,
      keyLines: step.keyLines,
      hasEvidence: step.hasShot,
      childNote:
        node.kind === "delegation" && row.mirroredFrom
          ? `Delegated to ${row.mirroredFrom} — that child's error is mirrored onto this run verbatim.`
          : node.kind === "delegation" && row.linkedGroup
            ? `Delegated — the child keeps its own row in the ${row.linkedGroup.panel} panel.`
            : undefined,
    };
  });

  const reuse: ExplorerOverlay["reuse"] = row.lineage
    ? row.lineage.diff.map((entry) => ({
        kind: entry.kind === "input" ? "fresh-live" : entry.kind === "checkpoint" ? "checkpoint" : entry.kind,
        label: entry.label,
        note: entry.note ?? `${entry.prior} → ${entry.current}`,
      }))
    : [
        {
          kind: "fresh-live",
          label: "Every value on this run was read live",
          note: "Attempt 1 — nothing was replayed from a checkpoint, so no value here is a replay wearing the label of an observation.",
        },
      ];

  return { runId: row.id, traceId: row.trace, title: row.displayName ?? row.title, nodes, reuse };
}

export function nodeById(graph: ExplorerGraph, id: string): ExplorerNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

export function edgesFrom(graph: ExplorerGraph, id: string): ExplorerEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}
