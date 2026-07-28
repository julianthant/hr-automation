import {
  DEMO_WORKFLOWS,
  type CapabilityAbsenceWire,
  type CapabilityKey,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type StartMethodKind,
} from "./demo-wire";
import { dryRunPosture, graphFor } from "./demo-explorer-wire";

export type { CapabilityAbsenceWire, CapabilityKey } from "./demo-wire";

/**
 * DEV-ONLY — WHAT EACH WORKFLOW CAN DO, derived from the descriptors that are
 * already served, and from nothing else.
 *
 * The operator's question was *"is there a way to see what the different
 * workflows are capable of? like which ones have dry run, roster, workers,
 * presets…"* — and the honest answer is that the product already knows: every
 * one of those facts is a field on the start descriptor or a node on the
 * Explorer graph. What was missing was a page that reads them.
 *
 * TWO RULES HOLD THIS FILE TOGETHER, and they are the reason it is derivation
 * rather than a table.
 *
 *   1. NO SECOND SOURCE OF TRUTH. Every cell is computed from
 *      `DEMO_WORKFLOWS[id]` or `EXPLORER_GRAPHS`. A hand-authored matrix would
 *      be right on the day it was written and wrong on the day a descriptor
 *      changed — and, being a matrix, it would be wrong *silently*, which is
 *      the worst kind of wrong for a page whose entire job is to say what is
 *      true.
 *
 *   2. NO WORKFLOW-ID BRANCHING. Nothing here says `if (id === "onbase")`. If
 *      a capability cannot be derived, the descriptor grows a field — that is
 *      what `capabilityAbsences` is for. A page that special-cases one workflow
 *      teaches the operator that the list is arbitrary.
 *
 * ABSENCE IS AN ANSWER, and there are two of them. `not-applicable` means the
 * capability makes no sense here (a read-only workflow has no dry run to
 * offer, because every run of it is already a rehearsal); `not-built` means it
 * would make sense and is not wired yet. Collapsing them into one grey dash is
 * how "we chose not to" and "we have not got to it" become indistinguishable —
 * and the operator plans differently depending on which it is. The REASON is
 * served per workflow, never inferred here.
 */

// ---------------------------------------------------------------------------
// The capability vocabulary
// ---------------------------------------------------------------------------

export interface CapabilitySpec {
  key: CapabilityKey;
  label: string;
  /** what the column means, in the operator's words — lives behind the ⓘ */
  meaning: string;
}

/**
 * In the order the page reads them: how you start it, what the start offers,
 * then what the run does to the world. The last two are the two that matter
 * most on a page about risk, so they are last where the eye stops.
 */
export const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    key: "startable",
    label: "Startable",
    meaning: "Whether you can start this yourself, and by which methods — typed values, an uploaded file, a phone capture, a spreadsheet, or a bare start with no subject.",
  },
  {
    key: "dryRun",
    label: "Dry run",
    meaning: "Offers a rehearsal that reads everything for real and writes nothing. A workflow that changes no system of record has nothing to rehearse.",
  },
  {
    key: "roster",
    label: "Roster",
    meaning: "Can resolve names to employee IDs off a roster file instead of a lookup per person.",
  },
  {
    key: "workers",
    label: "Workers",
    meaning: "Lets you choose how many browsers work the start in parallel. Every worker needs its own authenticated session.",
  },
  {
    key: "presets",
    label: "Presets",
    meaning: "Offers a run mode that SKIPS steps. A preset never changes what the remaining steps do.",
  },
  {
    key: "capture",
    label: "Phone capture",
    meaning: "Pages can be photographed on a phone instead of picked off disk.",
  },
  {
    key: "duplicateCheck",
    label: "Duplicate check",
    meaning: "Can refuse the start when this document has already been filed for this person, instead of filing it twice.",
  },
  {
    key: "multiFile",
    label: "Multi-file",
    meaning: "More than one file may be picked in a single start.",
  },
  {
    key: "merge",
    label: "Merge",
    meaning: "Several picked files become ONE document rather than several independent runs.",
  },
  {
    key: "subSelections",
    label: "Sub-selections",
    meaning: "The choices the start modal asks before it enqueues anything — form type, document type, run mode, roster, workers.",
  },
  {
    key: "memberOutcomes",
    label: "Member outcomes",
    meaning: "Its member rows answer with a fixed outcome vocabulary, so a fan-out of fifty can be read by outcome rather than by prose.",
  },
  {
    key: "delegation",
    label: "Delegates",
    meaning: "Hands part of its work to another workflow, which runs as its own row in its own panel.",
  },
  {
    key: "systemWrite",
    label: "Writes to a system of record",
    meaning: "Changes something in UCPath, Kuali, Kronos, OnBase or the I-9 portal. A downloaded file is an output, not a write — nothing about it needs undoing.",
  },
];

// ---------------------------------------------------------------------------
// A cell
// ---------------------------------------------------------------------------

export type CapabilityState = "available" | CapabilityAbsenceWire["state"];

export interface CapabilityCell {
  key: CapabilityKey;
  state: CapabilityState;
  /**
   * WHAT it is, when it is available — the method kinds, the choice labels, the
   * systems written. A column of thirteen identical ticks says a workflow has
   * capabilities; it does not say what they are.
   */
  detail?: string;
  /** why it is absent. Served by the descriptor, never composed here. */
  reason?: string;
}

export interface CapabilityRow {
  workflowId: DemoWorkflowId;
  label: string;
  cells: CapabilityCell[];
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const METHOD_LABEL: Record<StartMethodKind, string> = {
  typed: "typed",
  upload: "upload",
  capture: "phone capture",
  spreadsheet: "spreadsheet",
  bare: "bare",
};

/**
 * The capabilities that are facts about the START. A workflow with no start has
 * none of them, and all of them for the SAME reason — the one it already
 * serves. Making each descriptor repeat "delegated only" nine times would be
 * nine chances to drift.
 */
const START_DERIVED: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "startable",
  "dryRun",
  "roster",
  "workers",
  "presets",
  "capture",
  "duplicateCheck",
  "multiFile",
  "merge",
  "subSelections",
]);

/** the `no` a workflow serves for a capability, or the loud absence of one */
function absence(ref: DemoWorkflowRef, key: CapabilityKey): CapabilityCell {
  if (!ref.start && START_DERIVED.has(key) && ref.notStartable) {
    return { key, state: "not-applicable", reason: ref.notStartable };
  }
  const served = ref.absences?.[key];
  if (served) return { key, state: served.state, reason: served.reason };
  // NOT a fabricated default. A descriptor that declines a capability without
  // saying why is a gap in the descriptor, and the page says exactly that
  // rather than guessing on its behalf. A test asserts this never ships.
  return { key, state: "not-built", reason: "No reason served — the descriptor declares neither the capability nor why it is absent." };
}

function available(key: CapabilityKey, detail: string): CapabilityCell {
  return { key, state: "available", detail };
}

/**
 * `delegation` and `systemWrite` are read off the Explorer GRAPH, not off the
 * start descriptor — so a workflow with no graph has not declined them, it has
 * simply not published them. Rendering that as a flat "no" would be the page
 * asserting a fact it does not have.
 */
function NO_GRAPH(key: CapabilityKey): CapabilityCell {
  return {
    key,
    state: "not-built",
    reason: "No Explorer graph is served for this workflow, so what it writes and what it delegates to are not published.",
  };
}

/**
 * ONE workflow's row. Every branch reads a descriptor field; none reads an id.
 */
export function capabilityRow(workflowId: DemoWorkflowId): CapabilityRow {
  const ref = DEMO_WORKFLOWS[workflowId];
  const start = ref.start;
  const graph = graphFor(workflowId);
  const choices = start?.choices ?? [];
  const methods = start?.methods ?? [];
  const flags = start?.flags ?? [];

  const choice = (key: string) => choices.find((c) => c.key === key);
  const upload = methods.find((m) => m.kind === "upload");
  const dryRun = flags.find((f) => f.key === "dryRun");

  const writes = graph
    ? [...new Set(graph.nodes.filter((n) => n.kind === "write").flatMap((n) => (n.system ? [n.system] : [])))]
    : [];
  const delegates = graph ? [...new Set(graph.nodes.flatMap((n) => (n.delegatesTo ? [n.delegatesTo] : [])))] : [];
  const linkedPanels = methods.flatMap((m) => (m.kind === "upload" && m.linkedPanel ? [m.linkedPanel] : []));
  const delegationTargets = [...new Set([...delegates, ...linkedPanels])];

  const cell = (key: CapabilityKey): CapabilityCell => {
    switch (key) {
      case "startable":
        return start
          ? available(key, methods.map((m) => METHOD_LABEL[m.kind]).join(" · "))
          : { key, state: "not-applicable", reason: ref.notStartable ?? absence(ref, key).reason };
      case "dryRun":
        return dryRun
          ? available(key, dryRun.methods ? `${dryRun.methods.map((m) => METHOD_LABEL[m]).join(" · ")} only` : "every start method")
          : absence(ref, key);
      case "roster":
        return choice("rosterSource") ? available(key, "roster file or per-person lookup") : absence(ref, key);
      case "workers":
        return choice("workers") ? available(key, "1 – 8, or auto") : absence(ref, key);
      case "presets": {
        const preset = choice("preset");
        return preset
          ? available(key, preset.options.map((o) => o.label).join(" · "))
          : absence(ref, key);
      }
      case "capture": {
        const c = methods.find((m) => m.kind === "capture");
        return c ? available(key, c.documentNoun) : absence(ref, key);
      }
      case "duplicateCheck":
        return flags.some((f) => f.key === "duplicateCheck") ? available(key, "refuses a second filing") : absence(ref, key);
      case "multiFile":
        return upload?.multiFile ? available(key, `several ${upload.documentNoun}s at once`) : absence(ref, key);
      case "merge":
        return upload?.merge ? available(key, `N files → one ${upload.documentNoun}`) : absence(ref, key);
      case "subSelections":
        return choices.length > 0
          ? available(key, choices.map((c) => c.label).join(" · "))
          : absence(ref, key);
      case "memberOutcomes":
        return ref.memberOutcomes
          ? available(key, ref.memberOutcomes.map((o) => o.label).join(" · "))
          : absence(ref, key);
      case "delegation":
        if (delegationTargets.length > 0) return available(key, delegationTargets.map((t) => DEMO_WORKFLOWS[t].label).join(" · "));
        return graph ? absence(ref, key) : NO_GRAPH(key);
      case "systemWrite":
        if (writes.length > 0) return available(key, writes.map((s) => s.toUpperCase()).join(" · "));
        return graph ? absence(ref, key) : NO_GRAPH(key);
    }
  };

  return { workflowId, label: ref.label, cells: CAPABILITY_SPECS.map((s) => cell(s.key)) };
}

/** every workflow's row, in the descriptor's own order */
export function capabilityMatrix(): CapabilityRow[] {
  return (Object.keys(DEMO_WORKFLOWS) as DemoWorkflowId[]).map(capabilityRow);
}

/**
 * The dry-run posture the EXPLORER draws for the same workflow, so the matrix
 * and the graph cannot disagree about the one fact both of them print. A
 * workflow with no graph has no posture to report and says so.
 */
export function capabilityDryRunPosture(workflowId: DemoWorkflowId): string | undefined {
  const graph = graphFor(workflowId);
  if (!graph) return undefined;
  const posture = dryRunPosture(graph);
  if (posture === "boundary") return `stops before ${graph.dryRunBoundaryNodeId}`;
  if (posture === "no-system-write") return "writes nothing — every run is already a rehearsal";
  return "changes a system of record and honours no rehearsal";
}

export const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  available: "Yes",
  "not-applicable": "N/A",
  "not-built": "Not built",
};
