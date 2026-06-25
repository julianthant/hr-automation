// Pure projection: a workflow's presentation config → the React Flow graph.
//
// This is one of the four graph↔config↔spec projections the spec calls out as
// the testable seam (there is no component harness). It reads the SAME effective
// metadata + sparse override the blueprint used, and lays out config-backed nodes
// deterministically so the canvas seeds identically every load.
//
//   row ──seq──▶ step0 ──seq──▶ step1 ──▶ …            (the pipeline)
//    └──delegation──▶ coordinator ──▶ prep              (the fan-out, if delegating)
//                                  └──▶ member

import { applyStepDisplay } from "../../../../domain/workflow-presentation/step-display.js";
import type { WorkflowPresentationDetail } from "../useWorkflowPresentation.js";
import { buildSampleVars, isDelegatingWorkflow } from "../blueprint-helpers.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  EDGE_SEQUENCE,
  EDGE_DELEGATION,
  type GraphModel,
  type GraphNode,
  type GraphEdge,
} from "./graph-types.js";

// ── Deterministic layout (px). Horizontal pipeline, delegation drops below. ─────
const ROW_POS = { x: 0, y: 40 };
const STEP_X0 = 340;
const STEP_DX = 240;
const STEP_Y = 40;
const COORD_POS = { x: 340, y: 320 };
const PREP_POS = { x: 660, y: 280 };
const MEMBER_POS = { x: 660, y: 400 };

/** Stable node ids — the projections key on these, so keep them deterministic. */
export const ROW_NODE_ID = "row";
export const COORDINATOR_NODE_ID = "coordinator";
export const PREP_NODE_ID = "prep";
export const MEMBER_NODE_ID = "member";
export const stepNodeId = (step: string): string => `step:${step}`;

function seqEdge(source: string, target: string): GraphEdge {
  return {
    id: `seq:${source}->${target}`,
    source,
    target,
    sourceHandle: "out",
    targetHandle: "in",
    type: EDGE_SEQUENCE,
  };
}

function delegationEdge(source: string, target: string): GraphEdge {
  return {
    id: `del:${source}->${target}`,
    source,
    target,
    sourceHandle: "out",
    targetHandle: "in",
    type: EDGE_DELEGATION,
  };
}

export function overrideToGraph(
  data: WorkflowPresentationDetail,
  workflowName: string,
): GraphModel {
  const { effective, override } = data;
  const label = effective.label;
  const sampleVars = buildSampleVars(label);

  const naming = effective.presentation?.naming;
  const ovNaming = override?.presentation?.naming;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ── Row (queue-row naming) ────────────────────────────────────────────────
  nodes.push({
    id: ROW_NODE_ID,
    type: NODE_ROW,
    position: { ...ROW_POS },
    data: {
      workflowLabel: label,
      title: naming?.title,
      subtitle: naming?.subtitle,
      trace: naming?.trace,
      titleModified: ovNaming?.title !== undefined,
      subtitleModified: ovNaming?.subtitle !== undefined,
      traceModified: ovNaming?.trace !== undefined,
      sampleVars,
    },
  });

  // ── Steps (display order from applyStepDisplay) ───────────────────────────
  const displaySteps = applyStepDisplay([...effective.steps], effective.presentation?.steps);
  const ovSteps = override?.presentation?.steps;
  const ruledSteps = new Set((ovSteps?.rules ?? []).map((r) => r.step));
  displaySteps.forEach((ds, i) => {
    nodes.push({
      id: stepNodeId(ds.step),
      type: NODE_STEP,
      position: { x: STEP_X0 + i * STEP_DX, y: STEP_Y },
      data: {
        step: ds.step,
        label: ds.label,
        foldedSteps: ds.foldedSteps,
        modified:
          ruledSteps.has(ds.step) || ds.foldedSteps.some((f) => ruledSteps.has(f)),
      },
    });
  });

  // ── Sequence wiring: row → step0 → step1 → … ──────────────────────────────
  if (displaySteps.length) {
    edges.push(seqEdge(ROW_NODE_ID, stepNodeId(displaySteps[0].step)));
    for (let i = 0; i < displaySteps.length - 1; i++) {
      edges.push(seqEdge(stepNodeId(displaySteps[i].step), stepNodeId(displaySteps[i + 1].step)));
    }
  }

  // ── Delegation branch (coordinator → prep + member) ───────────────────────
  if (isDelegatingWorkflow(workflowName)) {
    const del = effective.presentation?.delegation;
    const ovDel = override?.presentation?.delegation;
    nodes.push({
      id: COORDINATOR_NODE_ID,
      type: NODE_DELEGATION_COORDINATOR,
      position: { ...COORD_POS },
      data: {
        workflowLabel: label,
        coordinatorLabelSuffix: del?.coordinatorLabelSuffix,
        modified: ovDel?.coordinatorLabelSuffix !== undefined,
      },
    });
    nodes.push({
      id: PREP_NODE_ID,
      type: NODE_PREP,
      position: { ...PREP_POS },
      data: {
        prepTitle: del?.prepTitle,
        modified: ovDel?.prepTitle !== undefined,
        sampleVars,
      },
    });
    nodes.push({
      id: MEMBER_NODE_ID,
      type: NODE_MEMBER,
      position: { ...MEMBER_POS },
      data: {
        memberTitle: del?.memberTitle,
        memberSubtitle: del?.memberSubtitle,
        titleModified: ovDel?.memberTitle !== undefined,
        subtitleModified: ovDel?.memberSubtitle !== undefined,
        sampleVars,
      },
    });
    edges.push(delegationEdge(ROW_NODE_ID, COORDINATOR_NODE_ID));
    edges.push(delegationEdge(COORDINATOR_NODE_ID, PREP_NODE_ID));
    edges.push(delegationEdge(COORDINATOR_NODE_ID, MEMBER_NODE_ID));
  }

  return { nodes, edges };
}
