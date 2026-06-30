// Canvas → node interaction channel. Lane collapse + focus are EPHEMERAL view
// state, deliberately kept OUT of node.data: a draft edit rebuilds the config
// projection (and would otherwise reset a lane's collapsed/focused flag on every
// keystroke). They live in GraphCanvas React state and reach the lane node
// components + outline rail through this context — the standard React Flow pattern
// for node→canvas callbacks (a node type registered module-side can still consume
// context at render).

import { createContext, useContext } from "react";
import type { DryRunStepDiff } from "../../../../domain/workflow-design/dry-run-diff.js";

/** The "Dry run" overlay channel — also EPHEMERAL view state (like collapse), so it
 *  rides this context instead of node.data and toggling it never rebuilds the graph. */
export interface LaneDryRun {
  /** Is the dry-run overlay turned on? */
  on: boolean;
  /** The dry-run diff for a step id (bare step, matching `StepNodeData.step`), or
   *  undefined when that step runs identically in both modes. */
  forStep: (step: string) => DryRunStepDiff | undefined;
}

export interface LaneInteraction {
  /** Is this lane currently collapsed (header only)? */
  isCollapsed: (id: string) => boolean;
  /** Flip a lane between collapsed (header) and expanded (op rows). */
  toggleCollapsed: (id: string) => void;
  /** The lane the operator explicitly focused via the outline rail (drives dim). */
  focusedId: string | null;
  /** Dry-run overlay state (off + empty by default). */
  dryRun: LaneDryRun;
  /** Remove an op the operator dropped into a lane (by bare step + the op's id). */
  removeAddedOp: (step: string, addedId: string) => void;
  /** The bare step currently hovered as a Data Bank drop target (highlights the
   *  lane), or null when nothing is being dragged over a lane. */
  dropTargetStep: string | null;
}

const NOOP: LaneInteraction = {
  isCollapsed: () => false,
  toggleCollapsed: () => {},
  focusedId: null,
  dryRun: { on: false, forStep: () => undefined },
  removeAddedOp: () => {},
  dropTargetStep: null,
};

export const LaneInteractionContext = createContext<LaneInteraction>(NOOP);

export function useLaneInteraction(): LaneInteraction {
  return useContext(LaneInteractionContext);
}
