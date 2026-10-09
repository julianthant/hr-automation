// Pure projection of a workflow's REAL mined automation (the Data Bank) into the
// step-lane model. Replaces the old `workflow-ops-build.ts` free-floating-node
// wall: instead of one React Flow node per op, a step's ops are NESTED inside its
// lane (the `stepNode`), and cross-step DATA FLOW (a scrape's `{var}` feeding a
// later step's fill/select) is surfaced as lane→lane edges.
//
// Two outputs, both deterministic (no clocks/random — the testable seam; the
// canvas owns React/IO):
//   • groupLaneOps(bank, baseStepOrder) → ops grouped by presentation step, plus
//     any mined step that maps to NO presentation step (rendered as a read-only
//     ops lane to the right so "show every op" stays honest).
//   • buildDataFlowEdges(orderedLanes) → the producer→consumer var links.

import type { WorkflowDataBank, DataBankOperation } from "../../../../domain/workflow-design/data-bank.js";
import { stepNodeId, opsLaneNodeId } from "./graph-build.js";
import { EDGE_DATAFLOW, type ActionNodeData, type GraphEdge } from "./graph-types.js";

/** A mined op carried into a lane row (the action-node data shape, sans node id). */
function toLaneOp(op: DataBankOperation): ActionNodeData {
  return {
    opId: op.id,
    kind: op.kind,
    system: op.system,
    label: op.label,
    selectorFqn: op.selectorFqn,
    role: op.role,
    accessibleName: op.accessibleName,
    inputVar: op.inputVar,
    outputVar: op.outputVar,
    url: op.url,
    note: op.note,
  };
}

/** One unmapped mined step → a read-only ops lane. */
export interface ExtraLane {
  /** Node id (`opslane:<step>`). */
  id: string;
  step: string;
  label: string;
  ops: ActionNodeData[];
  note?: string;
  sourceRef?: string;
}

export interface LaneOpsModel {
  /** Ops nested into each presentation step lane, keyed by step id. */
  byStep: Record<string, ActionNodeData[]>;
  /** Mined steps with no presentation step (rendered as their own lanes). */
  extraLanes: ExtraLane[];
}

/**
 * Group a workflow's mined ops under their presentation step. A mined step whose
 * id matches a presentation step nests its ops into that step's lane; a mined step
 * that matches nothing becomes a read-only `ExtraLane` (kept, never dropped). An
 * empty/undefined bank → empty model.
 */
export function groupLaneOps(
  bank: WorkflowDataBank | undefined,
  baseStepOrder: string[],
): LaneOpsModel {
  const byStep: Record<string, ActionNodeData[]> = {};
  const extraLanes: ExtraLane[] = [];
  if (!bank) return { byStep, extraLanes };

  const known = new Set(baseStepOrder);
  for (const step of bank.steps) {
    const ops = step.operations.map(toLaneOp);
    if (known.has(step.step)) {
      // Concatenate in case the same step appears twice in the mining.
      byStep[step.step] = [...(byStep[step.step] ?? []), ...ops];
    } else {
      extraLanes.push({
        id: opsLaneNodeId(step.step),
        step: step.step,
        label: step.label,
        ops,
        note: step.note,
        sourceRef: step.sourceRef,
      });
    }
  }
  return { byStep, extraLanes };
}

/** A lane in left→right order, with its node id + ops — the input to data-flow
 *  wiring. Only the data-flow vars are read, so any op-like shape works. */
export interface OrderedLane {
  nodeId: string;
  ops: ReadonlyArray<{ inputVar?: string; outputVar?: string }>;
}

/** Normalize a template var for matching: strip braces + surrounding space, lowercase.
 *  `{employeeName}` and `employeeName` and `{ contact.cellPhone|homePhone }` all
 *  reduce to a comparable key (the first pipe-alternative wins). */
function varKey(v: string | undefined): string | null {
  if (!v) return null;
  const inner = v.replace(/[{}]/g, "").trim().split("|")[0].trim().toLowerCase();
  return inner || null;
}

/**
 * Derive lane→lane data-flow edges: a `scrape`/`assert` op that writes `{var}` in
 * one lane, linked to EVERY later lane whose op READS that same `{var}` (a
 * fill/select/click input). One edge per producer→consumer lane pair + var (deduped),
 * labeled with the var. Within-lane flow is shown by the op rows' own in/out pills,
 * so a producer and consumer in the SAME lane emit no edge.
 */
export function buildDataFlowEdges(lanes: OrderedLane[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lanes.length; i++) {
    const producer = lanes[i];
    const produced = new Set<string>();
    for (const op of producer.ops) {
      const k = varKey(op.outputVar);
      if (k) produced.add(k);
    }
    if (produced.size === 0) continue;

    for (let j = i + 1; j < lanes.length; j++) {
      const consumer = lanes[j];
      const consumedHere = new Set<string>();
      for (const op of consumer.ops) {
        const k = varKey(op.inputVar);
        if (k && produced.has(k)) consumedHere.add(k);
      }
      for (const k of consumedHere) {
        const id = `flow:${producer.nodeId}->${consumer.nodeId}:${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({
          id,
          source: producer.nodeId,
          target: consumer.nodeId,
          sourceHandle: "out",
          targetHandle: "in",
          type: EDGE_DATAFLOW,
          label: `{${k}}`,
        });
      }
    }
  }
  return edges;
}

export { stepNodeId };
