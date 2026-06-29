// Pure filtering + grouping for the Data Bank palette (the component's testable
// seam). A query is tokenized and AND-matched across each op's label / summary /
// selector / role / accessible name / kind / tags / system; an optional kind set
// narrows further. The surviving ops group two ways — by SYSTEM (catalog order) or
// by ACTION (kind order) — dropping empty groups.

import type { DataBank, DataBankOperation, DataBankOpKind, SystemCatalog } from "../../../../domain/workflow-design/data-bank.js";
import { DATA_BANK_OP_KINDS } from "../../../../domain/workflow-design/data-bank.js";
import { opKindVisual } from "./op-kind-visuals.js";

/** Group ops by their owning SYSTEM or by their op KIND ("action"). */
export type PaletteView = "system" | "action";

export interface PaletteGroup {
  /** Stable key — the system code (system view) or the op kind (action view). */
  id: string;
  /** Header label — the system label or the kind verb. */
  label: string;
  ops: DataBankOperation[];
}

export interface PaletteFilter {
  view: PaletteView;
  query: string;
  /** Selected kinds; empty means "all kinds". */
  kinds: readonly DataBankOpKind[];
}

function opHaystack(op: DataBankOperation): string {
  return [op.label, op.summary, op.selectorFqn, op.role, op.accessibleName, op.kind, op.system, ...(op.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesQuery(op: DataBankOperation, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = opHaystack(op);
  return tokens.every((t) => hay.includes(t));
}

/**
 * Filter the catalog ops by a free-text query AND (when non-empty) a kind set,
 * then group by the active view: per-system in catalog order, or per-action in the
 * canonical kind order. Empty groups are dropped. Pure + deterministic.
 */
export function buildPaletteGroups(systems: SystemCatalog[], filter: PaletteFilter): PaletteGroup[] {
  const tokens = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kindSet = new Set(filter.kinds);
  const keep = (op: DataBankOperation): boolean =>
    matchesQuery(op, tokens) && (kindSet.size === 0 || kindSet.has(op.kind));

  if (filter.view === "system") {
    const out: PaletteGroup[] = [];
    for (const cat of systems) {
      const ops = cat.operations.filter(keep);
      if (ops.length) out.push({ id: cat.system, label: cat.label, ops });
    }
    return out;
  }

  // Action view: bucket the surviving ops by kind, emit in canonical kind order.
  const byKind = new Map<DataBankOpKind, DataBankOperation[]>();
  for (const cat of systems) {
    for (const op of cat.operations) {
      if (!keep(op)) continue;
      const list = byKind.get(op.kind) ?? [];
      list.push(op);
      byKind.set(op.kind, list);
    }
  }
  const out: PaletteGroup[] = [];
  for (const kind of DATA_BANK_OP_KINDS) {
    const ops = byKind.get(kind);
    if (ops?.length) {
      out.push({ id: kind, label: opKindVisual(kind).verb, ops: ops.sort((a, b) => a.id.localeCompare(b.id)) });
    }
  }
  return out;
}

/** Total op count across a bank's palette (for the panel header). */
export function paletteOpCount(bank: DataBank | null): number {
  return bank ? bank.systems.reduce((n, s) => n + s.operations.length, 0) : 0;
}

/** Which op kinds actually appear in the catalog, in canonical order — drives the
 *  kind-filter chip row (never show a chip that can match nothing). */
export function availableKinds(systems: SystemCatalog[]): DataBankOpKind[] {
  const present = new Set<DataBankOpKind>();
  for (const cat of systems) for (const op of cat.operations) present.add(op.kind);
  return DATA_BANK_OP_KINDS.filter((k) => present.has(k));
}

/** Resolve recently-used op ids to ops (most-recent first; unknown ids dropped). */
export function resolveRecentOps(systems: SystemCatalog[], recentIds: readonly string[]): DataBankOperation[] {
  const byId = new Map<string, DataBankOperation>();
  for (const cat of systems) for (const op of cat.operations) byId.set(op.id, op);
  const out: DataBankOperation[] = [];
  for (const id of recentIds) {
    const op = byId.get(id);
    if (op) out.push(op);
  }
  return out;
}
