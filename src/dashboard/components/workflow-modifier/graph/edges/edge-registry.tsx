// Custom edges + the module-constant edgeTypes registry. Edge `type` drives both
// semantics and styling: sequence = pipeline order, delegation = fan-out,
// fold = a step folded into a host, custom = an operator-drawn intent link.
// Strokes are token vars (no raw color — architecture-guarded). Like nodeTypes,
// edgeTypes MUST be a stable module-scope reference.

import type { JSX } from "react";
import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import { EDGE_SEQUENCE, EDGE_DELEGATION, EDGE_FOLD, EDGE_CUSTOM, EDGE_DATAFLOW } from "../graph-types.js";

function bezierEdge(props: EdgeProps, style: React.CSSProperties): JSX.Element {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  });
  return <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={style} />;
}

const SEQUENCE_STYLE: React.CSSProperties = { stroke: "var(--muted-foreground)", strokeWidth: 1.5 };
const DELEGATION_STYLE: React.CSSProperties = { stroke: "var(--info)", strokeWidth: 1.5 };
const FOLD_STYLE: React.CSSProperties = {
  stroke: "var(--warning)",
  strokeWidth: 1.5,
  strokeDasharray: "4 4",
};
const CUSTOM_STYLE: React.CSSProperties = {
  stroke: "var(--log-violet)",
  strokeWidth: 1.5,
  strokeDasharray: "4 4",
};
const DATAFLOW_STYLE: React.CSSProperties = {
  stroke: "var(--log-cyan)",
  strokeWidth: 1.5,
  strokeDasharray: "2 4",
};

const SequenceEdge = memo((props: EdgeProps) => bezierEdge(props, SEQUENCE_STYLE));
const DelegationEdge = memo((props: EdgeProps) => bezierEdge(props, DELEGATION_STYLE));
const FoldEdge = memo((props: EdgeProps) => bezierEdge(props, FOLD_STYLE));
const CustomEdge = memo((props: EdgeProps) => bezierEdge(props, CUSTOM_STYLE));

/** A data-flow link carries the `{var}` as a small pill at its midpoint. */
const DataFlowEdge = memo((props: EdgeProps) => {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  });
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={DATAFLOW_STYLE} />
      {typeof props.label === "string" ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full border border-log-cyan/40 bg-popover/90 px-1.5 py-0.5 font-mono text-[10px] text-log-cyan shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

SequenceEdge.displayName = "SequenceEdge";
DelegationEdge.displayName = "DelegationEdge";
FoldEdge.displayName = "FoldEdge";
CustomEdge.displayName = "CustomEdge";
DataFlowEdge.displayName = "DataFlowEdge";

export const edgeTypes: EdgeTypes = {
  [EDGE_SEQUENCE]: SequenceEdge,
  [EDGE_DELEGATION]: DelegationEdge,
  [EDGE_FOLD]: FoldEdge,
  [EDGE_CUSTOM]: CustomEdge,
  [EDGE_DATAFLOW]: DataFlowEdge,
};
