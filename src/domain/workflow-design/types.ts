// The design-intent scaffold — the novel core of the Workflow Graph Editor.
//
// Editing the graph produces TWO artifacts (option "c"): the live config (the
// existing `WorkflowOverride`, naming/steps/delegation the runtime understands)
// AND this scaffold, which captures design intent BEYOND today's schema — new
// node kinds, layout, freeform behavior/look notes — so a future session can
// implement exactly what was drawn instead of parsing a chat description.
//
// Persisted as `config/workflow-design/<workflow>.json` (this machine spec) plus
// a generated `config/workflow-design/<workflow>.md` (the human/Claude brief,
// rendered deterministically by `renderDesignBrief`). Client-safe + pure.

export type DesignNodeType =
  // config-backed (round-trip to the runtime override)
  | "row"
  | "step"
  | "delegationCoordinator"
  | "prep"
  | "member"
  // structured automation (Data Bank op — feeds the scaffold; no runtime override)
  | "action"
  // intent-only (no runtime meaning — they feed the scaffold)
  | "custom"
  | "note"
  | "group";

export interface DesignNodePosition {
  x: number;
  y: number;
}

/** Design intent beyond the schema — what makes the scaffold actionable. */
export interface DesignNodeIntent {
  /** Operator's name for this element. */
  label?: string;
  /** What it should do / look like, in plain words. */
  description?: string;
  /** Visual direction ("compact card, status dot left, mono id"). */
  look?: string;
  /** Interactions ("click expands members", "hover shows trace"). */
  behavior?: string;
  /** File paths / component names / URLs to mimic. */
  references?: string[];
  /** Sample values to render against. */
  exampleData?: Record<string, string>;
}

/** A structured automation primitive from the Data Bank (mirrors `ActionNodeData`). */
export interface DesignActionOp {
  /** The data-bank op id, e.g. "kuali.separationForm.eid#fill". */
  opId: string;
  /** The kind of automation primitive (navigate/click/fill/scrape/…). */
  kind: string;
  system: string;
  label: string;
  /** What it locates — at least one of selectorFqn, role+accessibleName, or url. */
  selectorFqn?: string;
  role?: string;
  accessibleName?: string;
  /** Data flow: fills from `{inputVar}`, scrapes into `{outputVar}`. */
  inputVar?: string;
  outputVar?: string;
  url?: string;
  note?: string;
}

export interface DesignNode {
  id: string;
  type: DesignNodeType;
  position: DesignNodePosition;
  /**
   * Config-backed nodes mirror the override slice they own (round-trips to the
   * runtime). e.g. `{ title: { scheme, template } }` for a row, or
   * `{ step, hidden, label, foldInto }` for a step.
   */
  config?: Record<string, unknown>;
  /** Intent-only fields — present on custom/note/group (and annotated config nodes). */
  intent?: DesignNodeIntent;
  /** Structured automation op — present when type === "action". */
  action?: DesignActionOp;
  /** Id of a group node, for sectioning. */
  parentGroup?: string;
}

export interface DesignEdge {
  id: string;
  source: string;
  target: string;
  type: "sequence" | "delegation" | "fold" | "custom";
  label?: string;
}

/** Theme / style intent the operator expressed (optional, beyond-schema look). */
export interface DesignStyleIntent {
  density?: "compact" | "comfortable";
  /** A token NAME (e.g. "info"), never a hex. */
  accent?: string;
  notes?: string;
}

export interface WorkflowDesignSpec {
  schemaVersion: 1;
  /** e.g. "oath-signature". */
  workflow: string;
  /** ISO; stamped server-side at write time. */
  generatedAt: string;
  /** Operator's one-line intent for the whole screen. */
  summary?: string;
  canvas?: { zoom: number; x: number; y: number };
  nodes: DesignNode[];
  edges: DesignEdge[];
  style?: DesignStyleIntent;
  /** Free-floating design notes. */
  notes?: string[];
}

export const DESIGN_SCHEMA_VERSION = 1 as const;

/** The intent-only node kinds — they never touch the runtime override. */
export const INTENT_NODE_TYPES: ReadonlySet<DesignNodeType> = new Set<DesignNodeType>([
  "custom",
  "note",
  "group",
]);

export function isIntentNodeType(type: DesignNodeType): boolean {
  return INTENT_NODE_TYPES.has(type);
}
