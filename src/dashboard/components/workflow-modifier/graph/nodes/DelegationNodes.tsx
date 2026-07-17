import type { JSX } from "react";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { CircleDot, FileScan, GitFork, Users } from "lucide-react";
import { NodeFrame } from "./NodeFrame.js";
import type {
  DelegationCoordinatorGraphNode,
  MemberGraphNode,
  PrepGraphNode,
} from "../graph-types.js";
import { previewTitle, previewSubtitle } from "../../blueprint-helpers.js";

function DelegationCoordinatorNodeImpl({
  data,
  selected,
}: NodeProps<DelegationCoordinatorGraphNode>): JSX.Element {
  const suffix = data.coordinatorLabelSuffix?.trim();
  const label = suffix ? `${data.workflowLabel} ${suffix}` : data.workflowLabel;
  return (
    <NodeFrame
      icon={GitFork}
      kind="Coordinator"
      accentClass="text-info"
      selected={selected}
      modified={data.suffixOverridden}
      widthClass="w-60"
      hasTarget
      hasSource
    >
      <p className="truncate text-sm font-medium text-foreground" title={label}>
        {label}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {suffix ? `suffix: ${suffix}` : "no label suffix"}
      </p>
    </NodeFrame>
  );
}

function PrepNodeImpl({ data, selected }: NodeProps<PrepGraphNode>): JSX.Element {
  const title = previewTitle(data.sampleVars, data.prepTitle);
  return (
    <NodeFrame
      icon={FileScan}
      kind="OCR prep"
      accentClass="text-info"
      selected={selected}
      modified={data.prepTitleOverride !== undefined}
      widthClass="w-56"
      hasTarget
    >
      <p className="truncate text-sm font-medium text-foreground" title={title}>
        {title || "(no title)"}
      </p>
    </NodeFrame>
  );
}

function MemberNodeImpl({ data, selected }: NodeProps<MemberGraphNode>): JSX.Element {
  const title = previewTitle(data.sampleVars, data.memberTitle);
  const subtitle = previewSubtitle(data.sampleVars, data.memberSubtitle);
  const titleModified = data.memberTitleOverride !== undefined;
  const subtitleModified = data.memberSubtitleOverride !== undefined;
  return (
    <NodeFrame
      icon={Users}
      kind="Member"
      accentClass="text-info"
      selected={selected}
      modified={titleModified || subtitleModified}
      widthClass="w-56"
      hasTarget
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          {titleModified ? (
            <CircleDot aria-hidden className="h-2.5 w-2.5 shrink-0 text-primary" />
          ) : null}
          <span className="truncate text-sm font-medium text-foreground" title={title}>
            {title || "(no title)"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {subtitleModified ? (
            <CircleDot aria-hidden className="h-2.5 w-2.5 shrink-0 text-primary" />
          ) : null}
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {subtitle || "—"}
          </span>
        </div>
      </div>
    </NodeFrame>
  );
}

export const DelegationCoordinatorNode = memo(DelegationCoordinatorNodeImpl);
export const PrepNode = memo(PrepNodeImpl);
export const MemberNode = memo(MemberNodeImpl);
