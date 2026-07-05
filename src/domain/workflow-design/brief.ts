// Pure, deterministic markdown renderer for the design-intent scaffold. The
// `.md` is the artifact a future Claude session reads first (prose intent); the
// `.json` is the precise graph. Re-generating after a graph edit must produce a
// clean diff, so this is a total function of the spec — no clocks, no ordering
// surprises (nodes/edges iterate in array order).

import {
  isIntentNodeType,
  type WorkflowDesignSpec,
  type DesignNode,
} from "./types.js";

const TYPE_LABEL: Record<string, string> = {
  row: "Queue row",
  step: "Step",
  delegationCoordinator: "Coordinator",
  prep: "OCR prep",
  member: "Member template",
  action: "Automation op",
  custom: "Custom element",
  note: "Note",
  group: "Group",
};

function nodeLabel(node: DesignNode): string {
  const intentLabel = node.intent?.label?.trim();
  if (intentLabel) return intentLabel;
  if (node.type === "step" && typeof node.config?.step === "string") {
    return `Step "${node.config.step}"`;
  }
  return TYPE_LABEL[node.type] ?? node.type;
}

function schemeText(v: unknown): string | undefined {
  if (v && typeof v === "object" && "scheme" in v) {
    const s = (v as { scheme?: unknown }).scheme;
    const t = (v as { template?: unknown }).template;
    return typeof s === "string" ? (typeof t === "string" ? `${s} — \`${t}\`` : s) : undefined;
  }
  return undefined;
}

function describeConfig(node: DesignNode): string[] {
  const c = node.config;
  if (!c) return [];
  const out: string[] = [];
  switch (node.type) {
    case "row": {
      const t = schemeText(c.title);
      const s = schemeText(c.subtitle);
      const tr = schemeText(c.trace);
      if (t) out.push(`title → ${t}`);
      if (s) out.push(`subtitle → ${s}`);
      if (tr) out.push(`trace → ${tr}`);
      break;
    }
    case "step": {
      if (c.hidden === true) out.push("hidden");
      if (typeof c.label === "string") out.push(`label → "${c.label}"`);
      if (typeof c.foldInto === "string") out.push(`folded into \`${c.foldInto}\``);
      break;
    }
    case "delegationCoordinator": {
      if (typeof c.coordinatorLabelSuffix === "string") {
        out.push(`label suffix → "${c.coordinatorLabelSuffix}"`);
      }
      break;
    }
    case "prep": {
      const t = schemeText(c.prepTitle);
      if (t) out.push(`prep title → ${t}`);
      break;
    }
    case "member": {
      const t = schemeText(c.memberTitle);
      const s = schemeText(c.memberSubtitle);
      if (t) out.push(`member title → ${t}`);
      if (s) out.push(`member subtitle → ${s}`);
      break;
    }
    default:
      break;
  }
  return out;
}

function connectionsFor(node: DesignNode, spec: WorkflowDesignSpec): string[] {
  const labelById = new Map(spec.nodes.map((n) => [n.id, nodeLabel(n)]));
  const out: string[] = [];
  for (const e of spec.edges) {
    if (e.source === node.id && labelById.has(e.target)) {
      out.push(`→ ${labelById.get(e.target)}${e.label ? ` (${e.label})` : ""}`);
    } else if (e.target === node.id && labelById.has(e.source)) {
      out.push(`← ${labelById.get(e.source)}${e.label ? ` (${e.label})` : ""}`);
    }
  }
  return out;
}

function renderIntentNode(node: DesignNode, spec: WorkflowDesignSpec): string[] {
  const lines: string[] = [];
  lines.push(`### ${nodeLabel(node)} _(${node.type})_`);
  const intent = node.intent;
  if (intent?.description) lines.push(intent.description);
  if (intent?.look) lines.push(`- **Look:** ${intent.look}`);
  if (intent?.behavior) lines.push(`- **Behavior:** ${intent.behavior}`);
  if (intent?.references?.length) lines.push(`- **References:** ${intent.references.join(", ")}`);
  if (intent?.exampleData && Object.keys(intent.exampleData).length) {
    const pairs = Object.entries(intent.exampleData).map(([k, v]) => `${k}=${v}`);
    lines.push(`- **Example data:** ${pairs.join(", ")}`);
  }
  const conns = connectionsFor(node, spec);
  if (conns.length) lines.push(`- **Connections:** ${conns.join("; ")}`);
  lines.push("");
  return lines;
}

const CONSTRAINTS_BLOCK = [
  "## Constraints (inherit these even without the rest of this repo's docs)",
  "",
  "- **Color = design tokens only** in `.tsx` (no Tailwind palette classes, no raw hex/rgb/hsl). New color → add a design token in `index.css`.",
  "- **No `@keyframes` / `animate-[...]` / inline `animation:`** anywhere (`.ts`/`.tsx`/`.css`). Motion via Tailwind utilities with `motion-safe:` / `motion-reduce:animate-none`.",
  "- **Icons = lucide-react only** (never emoji/unicode). Icon-only buttons need an `aria-label`.",
  "- **Interactive = real `<button>`/`<a>`**; non-submit buttons get an explicit button type. Focus-visible rings; `aria-live` on async/status; a label on every control.",
  "- `shrink-0` not `flex-shrink-0`; z-index on the `z-*` scale. No default exports in `src/`.",
  "- Verify green: `typecheck:all`, `test:architecture`, `build:dashboard`, `lint`, `test`.",
  "",
];

/** Render the human/Claude markdown brief. Deterministic in `spec`. */
export function renderDesignBrief(spec: WorkflowDesignSpec): string {
  const lines: string[] = [];

  // 1. Header
  lines.push(`# Workflow design intent — ${spec.workflow}`);
  lines.push("");
  lines.push(`> Generated ${spec.generatedAt} · schema v${spec.schemaVersion}`);
  lines.push(
    "> **Generated file — do not hand-edit.** Edit the workflow graph in the dashboard's Workflow Editor page and re-generate the scaffold.",
  );
  lines.push("");
  if (spec.summary?.trim()) {
    lines.push(spec.summary.trim());
    lines.push("");
  }

  // 2. Live config applied
  lines.push("## Live config applied");
  lines.push("");
  lines.push(
    "These display changes already took effect via the runtime override — do **not** re-implement them:",
  );
  lines.push("");
  // Action nodes are structured automation — they are NOT config-backed overrides.
  const configNodes = spec.nodes.filter((n) => !isIntentNodeType(n.type) && n.type !== "action");
  const appliedLines: string[] = [];
  for (const node of configNodes) {
    const desc = describeConfig(node);
    if (desc.length) appliedLines.push(`- **${nodeLabel(node)}:** ${desc.join(" · ")}`);
  }
  if (appliedLines.length) lines.push(...appliedLines);
  else lines.push("- _No overrides — the workflow uses its built-in naming, steps, and delegation defaults._");
  lines.push("");

  // 3. Design intent to build
  lines.push("## Design intent to build");
  lines.push("");
  const intentNodes = spec.nodes.filter((n) => isIntentNodeType(n.type));
  const groups = intentNodes.filter((n) => n.type === "group");
  const grouped = new Set<string>();

  if (!intentNodes.length) {
    lines.push("_No design-intent nodes drawn yet._");
    lines.push("");
  } else {
    for (const group of groups) {
      lines.push(`## Section: ${nodeLabel(group)}`);
      if (group.intent?.description) lines.push(group.intent.description);
      lines.push("");
      const members = intentNodes.filter((n) => n.parentGroup === group.id && n.id !== group.id);
      for (const m of members) {
        grouped.add(m.id);
        lines.push(...renderIntentNode(m, spec));
      }
    }
    for (const node of intentNodes) {
      if (node.type === "group" || grouped.has(node.id)) continue;
      lines.push(...renderIntentNode(node, spec));
    }
  }

  // 4. Automation — real operations from the Data Bank
  const actionNodes = spec.nodes.filter((n) => n.type === "action");
  if (actionNodes.length) {
    lines.push("## Automation (real operations)");
    lines.push("");
    lines.push(
      "These are real automation primitives placed from the Data Bank — what the implementation must actually click, locate, fill, or scrape:",
    );
    lines.push("");
    for (const n of actionNodes) {
      const op = n.action;
      if (!op) continue;
      lines.push(`### ${op.label} _(${op.kind})_`);
      // Locator
      if (op.selectorFqn) {
        lines.push(`- **Selector:** \`${op.selectorFqn}\``);
      } else if (op.role && op.accessibleName) {
        lines.push(`- **Locator:** role \`${op.role}\` · name "${op.accessibleName}"`);
      } else if (op.role) {
        lines.push(`- **Locator:** role \`${op.role}\``);
      } else if (op.accessibleName) {
        lines.push(`- **Locator:** accessible name "${op.accessibleName}"`);
      }
      if (op.url) lines.push(`- **URL:** ${op.url}`);
      // Data flow
      if (op.inputVar) lines.push(`- **Fills from:** \`{${op.inputVar}}\``);
      if (op.outputVar) lines.push(`- **Scrapes into:** \`{${op.outputVar}}\``);
      if (op.note) lines.push(`- **Note:** ${op.note}`);
      lines.push(`- **System:** ${op.system} · **Op id:** \`${op.opId}\``);
      lines.push("");
    }
  }

  if (spec.style) {
    const s = spec.style;
    const bits: string[] = [];
    if (s.density) bits.push(`density: ${s.density}`);
    if (s.accent) bits.push(`accent token \`${s.accent}\``);
    if (s.notes) bits.push(s.notes);
    if (bits.length) {
      lines.push("### Style intent");
      lines.push(bits.join(" · "));
      lines.push("");
    }
  }

  if (spec.notes?.length) {
    lines.push("### Notes");
    for (const n of spec.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  // 5. Constraints reminder
  lines.push(...CONSTRAINTS_BLOCK);

  // 6. Open questions — under-specified intent nodes flagged for the operator.
  const open = intentNodes.filter((n) => n.type !== "note" && !n.intent?.description?.trim());
  lines.push("## Open questions");
  lines.push("");
  if (open.length) {
    for (const n of open) lines.push(`- **${nodeLabel(n)}** has no description yet — needs a spec before building.`);
  } else {
    lines.push("_None flagged._");
  }
  lines.push("");

  return lines.join("\n");
}
