// The two pure graph↔config projections (the spec's testable seam — there is no
// component harness). They mirror the blueprint plates' derivations exactly, so
// the canvas edits the SAME effective values the blueprint did:
//   • overrideToGraph(base, draft) → nodes/edges: per-part `draft ?? base ?? default`
//     for display + the sparse override slice each node owns for the inverse.
//   • graphToOverride(model, baseSteps) → the sparse WorkflowOverride, routed
//     through `prune` so it stays sparse (defaults collapse to undefined).
//
//   row ──seq──▶ step0 ──seq──▶ step1 ──▶ …            (the pipeline)
//    └──delegation──▶ coordinator ──▶ prep              (the fan-out, if delegating)
//                                  └──▶ member

import type { WorkflowMetadata } from "../../../lib/workflows-context.js";
import type {
  WorkflowOverride,
  NamingConfig,
  StepDisplayConfig,
  StepDisplayRule,
  DelegationDisplayConfig,
} from "../../../../domain/workflow-presentation/types.js";
import { formatStepName } from "../../shared/types.js";
import {
  buildSampleVars,
  isDelegatingWorkflow,
  countDelegation,
  prune,
  DEFAULT_TITLE_SCHEME,
  DEFAULT_SUBTITLE_SCHEME,
  DEFAULT_TRACE_SCHEME,
  DEFAULT_MEMBER_TITLE_SCHEME,
  DEFAULT_MEMBER_SUBTITLE_SCHEME,
  DEFAULT_PREP_TITLE_SCHEME,
} from "../blueprint-helpers.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  EDGE_SEQUENCE,
  EDGE_DELEGATION,
  EDGE_FOLD,
  type GraphModel,
  type GraphNode,
  type GraphEdge,
  type RowGraphNode,
  type StepGraphNode,
  type DelegationCoordinatorGraphNode,
  type PrepGraphNode,
  type MemberGraphNode,
} from "./graph-types.js";

// ── Deterministic layout (px). Horizontal pipeline of LANES (wide + tall, they
//    nest their ops), delegation drops below the lane band. ─────────────────────
const ROW_POS = { x: 0, y: 40 };
export const STEP_X0 = 360;
export const STEP_DX = 384;
export const STEP_Y = 40;
const COORD_POS = { x: 360, y: 660 };
const PREP_POS = { x: 744, y: 600 };
const MEMBER_POS = { x: 744, y: 760 };

/** Stable node ids — the projections key on these, so keep them deterministic. */
export const ROW_NODE_ID = "row";
export const COORDINATOR_NODE_ID = "coordinator";
export const PREP_NODE_ID = "prep";
export const MEMBER_NODE_ID = "member";
export const stepNodeId = (step: string): string => `step:${step}`;
const stepFromNodeId = (id: string): string => id.slice("step:".length);
/** Parse a step node id (`step:<step>`) back to the bare step, or null if `id`
 *  isn't a step node — the drop-target + scaffold-routing test for "is this a
 *  step lane?" (a row/coordinator/opslane id returns null). */
export function parseStepNodeId(id: string): string | null {
  return id.startsWith("step:") ? id.slice("step:".length) : null;
}
/** Display-only lane id for a mined step with no presentation step. */
export const opsLaneNodeId = (step: string): string => `opslane:${step}`;

function seqEdge(source: string, target: string): GraphEdge {
  return { id: `seq:${source}->${target}`, source, target, sourceHandle: "out", targetHandle: "in", type: EDGE_SEQUENCE };
}
function delegationEdge(source: string, target: string): GraphEdge {
  return { id: `del:${source}->${target}`, source, target, sourceHandle: "out", targetHandle: "in", type: EDGE_DELEGATION };
}
function foldEdge(host: string, folded: string): GraphEdge {
  return { id: `fold:${host}->${folded}`, source: host, target: folded, sourceHandle: "out", targetHandle: "in", type: EDGE_FOLD };
}

/**
 * Project a workflow's base metadata + the current sparse draft override into
 * the React Flow graph. Per-part fallback (`draft ?? base ?? default`) mirrors
 * the blueprint plates so the canvas previews byte-identically.
 */
export function overrideToGraph(
  base: WorkflowMetadata,
  draft: WorkflowOverride,
  workflowName: string,
): GraphModel {
  const label = base.label ?? workflowName;
  const sampleVars = buildSampleVars(label);

  const draftNaming = draft.presentation?.naming ?? {};
  const baseNaming = base.presentation?.naming ?? {};

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ── Row (queue-row naming) ────────────────────────────────────────────────
  const rowNode: RowGraphNode = {
    id: ROW_NODE_ID,
    type: NODE_ROW,
    position: { ...ROW_POS },
    data: {
      workflowLabel: label,
      title: draftNaming.title ?? baseNaming.title ?? { scheme: DEFAULT_TITLE_SCHEME },
      subtitle:
        draftNaming.subtitle ?? baseNaming.subtitle ?? { scheme: DEFAULT_SUBTITLE_SCHEME },
      trace: draftNaming.trace ?? baseNaming.trace ?? { scheme: DEFAULT_TRACE_SCHEME },
      titleOverride: draftNaming.title,
      subtitleOverride: draftNaming.subtitle,
      traceOverride: draftNaming.trace,
      sampleVars,
    },
  };
  nodes.push(rowNode);

  // ── Steps (order + rules mirror StepPipelinePlate) ────────────────────────
  const order = draft.presentation?.steps?.order ?? [...base.steps];
  const draftRules = draft.presentation?.steps?.rules ?? [];
  const baseRules = base.presentation?.steps?.rules ?? [];
  const ruleFor = (step: string): StepDisplayRule =>
    draftRules.find((r) => r.step === step) ?? baseRules.find((r) => r.step === step) ?? { step };
  const labelFor = (step: string): string => ruleFor(step).label ?? formatStepName(step);
  const foldedInto = (host: string): string[] =>
    order.filter((s) => ruleFor(s).foldInto === host);

  order.forEach((step, i) => {
    const rule = ruleFor(step);
    const node: StepGraphNode = {
      id: stepNodeId(step),
      type: NODE_STEP,
      position: { x: STEP_X0 + i * STEP_DX, y: STEP_Y },
      data: {
        step,
        stepIndex: i,
        label: labelFor(step),
        hidden: rule.hidden ?? false,
        foldInto: rule.foldInto,
        foldedSteps: foldedInto(step),
        overrideRule: draftRules.find((r) => r.step === step),
      },
    };
    nodes.push(node);
  });

  // ── Sequence wiring: row → step0 → step1 → … ──────────────────────────────
  if (order.length) {
    edges.push(seqEdge(ROW_NODE_ID, stepNodeId(order[0])));
    for (let i = 0; i < order.length - 1; i++) {
      edges.push(seqEdge(stepNodeId(order[i]), stepNodeId(order[i + 1])));
    }
  }

  // ── Fold wiring: host ⇢ folded step (dashed warning, on top of the chain) ──
  for (const step of order) {
    const host = ruleFor(step).foldInto;
    if (host && order.includes(host)) {
      edges.push(foldEdge(stepNodeId(host), stepNodeId(step)));
    }
  }

  // ── Delegation branch (coordinator → prep + member) ───────────────────────
  if (isDelegatingWorkflow(workflowName) || countDelegation(draft) > 0) {
    const del = draft.presentation?.delegation ?? {};
    const baseDel = base.presentation?.delegation ?? {};

    const coordinator: DelegationCoordinatorGraphNode = {
      id: COORDINATOR_NODE_ID,
      type: NODE_DELEGATION_COORDINATOR,
      position: { ...COORD_POS },
      data: {
        workflowLabel: label,
        coordinatorLabelSuffix: del.coordinatorLabelSuffix ?? baseDel.coordinatorLabelSuffix,
        suffixOverridden: del.coordinatorLabelSuffix !== undefined,
      },
    };
    const prep: PrepGraphNode = {
      id: PREP_NODE_ID,
      type: NODE_PREP,
      position: { ...PREP_POS },
      data: {
        prepTitle: del.prepTitle ?? baseDel.prepTitle ?? { scheme: DEFAULT_PREP_TITLE_SCHEME },
        prepTitleOverride: del.prepTitle,
        sampleVars,
      },
    };
    const member: MemberGraphNode = {
      id: MEMBER_NODE_ID,
      type: NODE_MEMBER,
      position: { ...MEMBER_POS },
      data: {
        memberTitle:
          del.memberTitle ?? baseDel.memberTitle ?? { scheme: DEFAULT_MEMBER_TITLE_SCHEME },
        memberSubtitle:
          del.memberSubtitle ??
          baseDel.memberSubtitle ?? { scheme: DEFAULT_MEMBER_SUBTITLE_SCHEME },
        memberTitleOverride: del.memberTitle,
        memberSubtitleOverride: del.memberSubtitle,
        sampleVars,
      },
    };
    nodes.push(coordinator, prep, member);
    edges.push(delegationEdge(ROW_NODE_ID, COORDINATOR_NODE_ID));
    edges.push(delegationEdge(COORDINATOR_NODE_ID, PREP_NODE_ID));
    edges.push(delegationEdge(COORDINATOR_NODE_ID, MEMBER_NODE_ID));
  }

  return { nodes, edges };
}

/**
 * Inverse projection: the graph's config-backed nodes → the sparse override.
 * Collects each node's owned override slice + reconstructs step order from the
 * node sequence (vs `baseSteps`), then routes through `prune` so the result is
 * byte-identical to what the blueprint setters would have produced.
 */
export function graphToOverride(
  model: GraphModel,
  workflowName: string,
  baseSteps: string[],
): WorkflowOverride {
  const naming: NamingConfig = {};
  const steps: StepDisplayConfig = {};
  const delegation: DelegationDisplayConfig = {};

  const stepOrder: string[] = [];
  const stepRules: StepDisplayRule[] = [];

  for (const node of model.nodes) {
    switch (node.type) {
      case NODE_ROW: {
        if (node.data.titleOverride !== undefined) naming.title = node.data.titleOverride;
        if (node.data.subtitleOverride !== undefined) naming.subtitle = node.data.subtitleOverride;
        if (node.data.traceOverride !== undefined) naming.trace = node.data.traceOverride;
        break;
      }
      case NODE_STEP: {
        stepOrder.push(stepFromNodeId(node.id));
        if (node.data.overrideRule !== undefined) stepRules.push(node.data.overrideRule);
        break;
      }
      case NODE_DELEGATION_COORDINATOR: {
        if (node.data.suffixOverridden) {
          delegation.coordinatorLabelSuffix = node.data.coordinatorLabelSuffix;
        }
        break;
      }
      case NODE_PREP: {
        if (node.data.prepTitleOverride !== undefined) delegation.prepTitle = node.data.prepTitleOverride;
        break;
      }
      case NODE_MEMBER: {
        if (node.data.memberTitleOverride !== undefined) delegation.memberTitle = node.data.memberTitleOverride;
        if (node.data.memberSubtitleOverride !== undefined)
          delegation.memberSubtitle = node.data.memberSubtitleOverride;
        break;
      }
      default:
        break; // design-intent nodes carry no override
    }
  }

  // Step order is an override only when it diverges from the declared base order.
  if (stepOrder.length !== baseSteps.length) {
    console.warn(
      `graphToOverride: step count mismatch (${stepOrder.length} vs ${baseSteps.length}); dropping order override`,
    );
  }
  const orderDiverges =
    stepOrder.length === baseSteps.length && stepOrder.some((s, i) => s !== baseSteps[i]);
  if (orderDiverges) steps.order = stepOrder;
  if (stepRules.length) steps.rules = stepRules;

  return prune({ presentation: { naming, steps, delegation } });
}
