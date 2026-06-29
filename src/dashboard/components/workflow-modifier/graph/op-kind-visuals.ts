// Shared icon + token accent per Data Bank operation kind. Token classes only
// (no raw color — architecture-guarded); reused by the action node + the palette
// so a kind reads identically wherever it appears.

import {
  Compass,
  MousePointerClick,
  PenLine,
  ListChecks,
  Upload,
  ScanLine,
  Clock,
  ShieldCheck,
  GitBranch,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DataBankOpKind } from "../../../../domain/workflow-design/data-bank.js";

export interface OpKindVisual {
  icon: LucideIcon;
  /** Token text class for the glyph. */
  accent: string;
  /** Token background class for the lane op-row stripe (same hue as `accent`). */
  bgClass: string;
  /** Tinted pill classes (house tint: `bg-<token>/15` + solid `text-<token>`) for
   *  the kind TAG shown beside a palette op label. */
  chip: string;
  /** Short verb for the node/palette label prefix. */
  verb: string;
}

const VISUALS: Record<DataBankOpKind, OpKindVisual> = {
  navigate: { icon: Compass, accent: "text-info", bgClass: "bg-info", chip: "bg-info/15 text-info", verb: "Navigate" },
  click: { icon: MousePointerClick, accent: "text-foreground", bgClass: "bg-muted-foreground", chip: "bg-accent text-foreground", verb: "Click" },
  fill: { icon: PenLine, accent: "text-log-teal", bgClass: "bg-log-teal", chip: "bg-log-teal/15 text-log-teal", verb: "Fill" },
  select: { icon: ListChecks, accent: "text-log-teal", bgClass: "bg-log-teal", chip: "bg-log-teal/15 text-log-teal", verb: "Select" },
  upload: { icon: Upload, accent: "text-log-violet", bgClass: "bg-log-violet", chip: "bg-log-violet/15 text-log-violet", verb: "Upload" },
  scrape: { icon: ScanLine, accent: "text-log-cyan", bgClass: "bg-log-cyan", chip: "bg-log-cyan/15 text-log-cyan", verb: "Scrape" },
  wait: { icon: Clock, accent: "text-muted-foreground", bgClass: "bg-muted-foreground", chip: "bg-secondary text-muted-foreground", verb: "Wait" },
  assert: { icon: ShieldCheck, accent: "text-success", bgClass: "bg-success", chip: "bg-success/15 text-success", verb: "Assert" },
  control: { icon: GitBranch, accent: "text-log-violet", bgClass: "bg-log-violet", chip: "bg-log-violet/15 text-log-violet", verb: "Control" },
};

export function opKindVisual(kind: DataBankOpKind): OpKindVisual {
  return VISUALS[kind] ?? VISUALS.control;
}
