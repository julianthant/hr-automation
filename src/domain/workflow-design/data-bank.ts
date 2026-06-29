// The Data Bank — the structured catalog of every real automation primitive the
// Workflow Graph Editor can place. It is the n8n-style "node palette" source:
// every click, locator, scraper, input, and fill the codebase actually performs,
// mined from `src/systems/<sys>/selectors.ts` (the locators) + `src/workflows/
// <wf>/steps/*.ts` (the ordered use of those locators), so the graph can describe
// a workflow's automation in full detail and the design scaffold becomes precise.
//
// TWO shapes ride this bank:
//   • SystemCatalog — the per-system palette of available operations, reusable
//     across ALL workflows (drag any system's click/fill/scrape onto any graph).
//   • WorkflowDataBank — one workflow's REAL ordered automation, pre-placed into
//     its graph (mined from its steps/ + the systems it drives).
//
// Pure + client-safe (no node imports) — the dashboard palette, the per-workflow
// agents, and the scaffold generator all consume it.

/** The kind of automation primitive a data-bank operation represents. */
export type DataBankOpKind =
  | "navigate" // open a URL / page
  | "click" // click an element (button / link / tab / checkbox / radio)
  | "fill" // type a value into a text input
  | "select" // choose an option in a combobox / dropdown / listbox
  | "upload" // attach a file to a file input
  | "scrape" // read / extract a value from the page (no mutation)
  | "wait" // wait for a selector / condition / navigation
  | "assert" // verify a condition (throws on mismatch)
  | "control"; // non-browser control flow (branch / parallel / delegate / loop)

export const DATA_BANK_OP_KINDS: readonly DataBankOpKind[] = [
  "navigate",
  "click",
  "fill",
  "select",
  "upload",
  "scrape",
  "wait",
  "assert",
  "control",
] as const;

/** One placeable automation primitive — a palette node or a step operation. */
export interface DataBankOperation {
  /** Stable, unique id. Convention: `<system>.<selectorPath>#<kind>` or
   *  `<system>.<slug>#<kind>` for control/navigate ops. e.g.
   *  `kuali.separationForm.eid#fill`. */
  id: string;
  kind: DataBankOpKind;
  /** Owning system: "kuali" | "ucpath" | "crm" | … | "control" (control flow). */
  system: string;
  /** Human label for the palette + node, e.g. "Fill EID". */
  label: string;
  /** One-line description of what the op does. */
  summary?: string;

  // ── Target (what it locates) ──────────────────────────────────────────────
  /** Registry path of the selector, e.g. "kualiSelectors.separationForm.eid".
   *  Omitted for navigate / control ops with no element target. */
  selectorFqn?: string;
  /** Accessibility role of the target ("textbox" | "button" | "combobox" | …). */
  role?: string;
  /** Accessible name / label text the selector matches, e.g. "EID*". */
  accessibleName?: string;

  // ── Data flow ─────────────────────────────────────────────────────────────
  /** Template var the value is filled FROM, e.g. "{eid}". */
  inputVar?: string;
  /** Template var the scraped value is read INTO, e.g. "{terminationType}". */
  outputVar?: string;
  /** Destination URL for navigate ops. */
  url?: string;
  /** Fixed/literal value typed or chosen (when not from a var). */
  literalValue?: string;

  // ── Provenance ────────────────────────────────────────────────────────────
  /** Source ref, e.g. "src/systems/kuali/selectors.ts:96" (selector def) or the
   *  step file that performs it. */
  sourceRef?: string;
  /** The `// verified YYYY-MM-DD` date on the selector, if any. */
  verified?: string;
  /** `@tags` from the selector JSDoc. */
  tags?: string[];
  /** A non-obvious gotcha (condensed from CLAUDE.md / LESSONS.md). */
  note?: string;
}

/** One real, ordered step of a workflow's automation (mirrors a presentation step
 *  where one exists, so the graph can attach primitives to the display step). */
export interface DataBankStep {
  /** Presentation step id when it maps to one (e.g. "kuali-extraction"); else a
   *  descriptive slug. */
  step: string;
  label: string;
  /** Which system this step drives ("kuali" | "ucpath" | … ), or "multi". */
  system?: string;
  /** Source file implementing the step, e.g.
   *  "src/workflows/separations/steps/kuali-extract.ts". */
  sourceRef?: string;
  /** Ordered operations performed in this step (inline; each references a system
   *  catalog op by id where applicable). */
  operations: DataBankOperation[];
  /** Notes — branches, gates, dry-run boundaries, fan-out. */
  note?: string;
}

/** The data-bank fragment one workflow contributes. */
export interface WorkflowDataBank {
  workflow: string;
  /** Systems this workflow drives, in auth/launch order. */
  systems: string[];
  /** Ordered real automation steps. */
  steps: DataBankStep[];
  /** Free design notes about the flow (gates, fan-out, dry-run boundary). */
  notes?: string[];
}

/** A per-system palette of available operations (reusable across all workflows). */
export interface SystemCatalog {
  system: string;
  label: string;
  operations: DataBankOperation[];
}

/** The aggregated data bank consumed by the editor palette + per-workflow graphs. */
export interface DataBank {
  schemaVersion: 1;
  /** ISO; stamped server-side at write time. */
  generatedAt: string;
  /** Per-system palette of available operations (the n8n "node" catalog). */
  systems: SystemCatalog[];
  /** Per-workflow real automation sequences (pre-placed into each graph). */
  workflows: WorkflowDataBank[];
}

export const DATA_BANK_SCHEMA_VERSION = 1 as const;

/** Build a stable op id from its parts. Lowercase system, keep the selector path. */
export function dataBankOpId(system: string, target: string, kind: DataBankOpKind): string {
  return `${system.toLowerCase()}.${target}#${kind}`;
}

/** Human label for a system code (falls back to a title-cased code). */
export function systemLabel(system: string, overrides?: Record<string, string>): string {
  if (overrides?.[system]) return overrides[system];
  return system
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Merge a flat pool of operations (collected from every workflow's mining) into
 * deduped per-system catalogs. Last write wins on a duplicate id, but a later
 * entry never erases a field the earlier one had (field-level merge) so partial
 * contributions from different workflows accumulate. Pure + deterministic:
 * systems sort by `systemOrder` then alpha; ops sort by id.
 */
export function mergeSystemOperations(
  operations: DataBankOperation[],
  opts?: { systemOrder?: string[]; labelOverrides?: Record<string, string> },
): SystemCatalog[] {
  const order = opts?.systemOrder ?? [];
  const byId = new Map<string, DataBankOperation>();
  for (const op of operations) {
    const prev = byId.get(op.id);
    byId.set(op.id, prev ? mergeOp(prev, op) : op);
  }

  const bySystem = new Map<string, DataBankOperation[]>();
  for (const op of byId.values()) {
    const list = bySystem.get(op.system) ?? [];
    list.push(op);
    bySystem.set(op.system, list);
  }

  const rank = (s: string): number => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };

  return [...bySystem.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([system, ops]) => ({
      system,
      label: systemLabel(system, opts?.labelOverrides),
      operations: ops.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

/** Field-level merge: keep `prev`, fill any field `next` newly provides; union tags. */
function mergeOp(prev: DataBankOperation, next: DataBankOperation): DataBankOperation {
  const tags = prev.tags || next.tags ? [...new Set([...(prev.tags ?? []), ...(next.tags ?? [])])] : undefined;
  return {
    ...prev,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== "")),
    ...(tags ? { tags } : {}),
  };
}

/** Strip a workflow-specific operation down to a generic, reusable palette entry —
 *  the per-run data flow (`inputVar`/`outputVar`/`literalValue`) is meaningful only
 *  inside a workflow's graph, not in the shared palette. `url` stays (a navigate
 *  target is canonical). */
export function genericizeOperation(op: DataBankOperation): DataBankOperation {
  const { inputVar: _i, outputVar: _o, literalValue: _l, ...generic } = op;
  return generic;
}

/**
 * Assemble the full data bank from the mined fragments: every system's palette
 * ops PLUS every workflow's (genericized) ops merged + deduped into per-system
 * catalogs, and the per-workflow sequences carried through verbatim. System ops
 * come FIRST so their richer palette metadata (role / accessibleName / verified /
 * tags) wins over a workflow op that only references the same id. Pure +
 * deterministic (sorted) — the I/O lives in the build script.
 */
export function assembleDataBank(opts: {
  generatedAt: string;
  systemOps: DataBankOperation[];
  workflows: WorkflowDataBank[];
  systemOrder?: string[];
  labelOverrides?: Record<string, string>;
}): DataBank {
  const workflowOps = opts.workflows
    .flatMap((w) => w.steps.flatMap((s) => s.operations))
    .map(genericizeOperation);
  const systems = mergeSystemOperations([...opts.systemOps, ...workflowOps], {
    systemOrder: opts.systemOrder,
    labelOverrides: opts.labelOverrides,
  });
  const workflows = [...opts.workflows].sort((a, b) => a.workflow.localeCompare(b.workflow));
  return { schemaVersion: DATA_BANK_SCHEMA_VERSION, generatedAt: opts.generatedAt, systems, workflows };
}

/** Ids referenced by a workflow that no system catalog defines — a coverage gap
 *  worth surfacing in the build (a selector used but not in any palette). */
export function findOrphanOperationIds(bank: DataBank): string[] {
  const known = new Set(bank.systems.flatMap((s) => s.operations.map((o) => o.id)));
  const referenced = new Set(bank.workflows.flatMap((w) => w.steps.flatMap((s) => s.operations.map((o) => o.id))));
  return [...referenced].filter((id) => !known.has(id)).sort();
}
