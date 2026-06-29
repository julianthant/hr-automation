import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Frame,
  Layers,
  Search,
  Shapes,
  StickyNote,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DataBank, DataBankOperation, DataBankOpKind } from "../../../../domain/workflow-design/data-bank.js";
import { NODE_NOTE, NODE_GROUP } from "./graph-types.js";
import { opKindVisual } from "./op-kind-visuals.js";
import {
  availableKinds,
  buildPaletteGroups,
  paletteOpCount,
  resolveRecentOps,
  type PaletteView,
} from "./data-bank-palette.js";
import { useRecentOpIds } from "./useRecentOps.js";

export type AnnotateKind = typeof NODE_NOTE | typeof NODE_GROUP;

interface DataBankPaletteProps {
  bank: DataBank | null;
  /** Add a real automation primitive (places an action node). */
  onAddOp: (op: DataBankOperation) => void;
  /** Add an annotation node (note / group). */
  onAddAnnotation: (kind: AnnotateKind) => void;
  /** Dismiss the palette (renders an × in the header when provided). */
  onClose?: () => void;
}

const ANNOTATIONS: { kind: AnnotateKind; label: string; icon: LucideIcon }[] = [
  { kind: NODE_NOTE, label: "Note", icon: StickyNote },
  { kind: NODE_GROUP, label: "Group / section", icon: Frame },
];

/**
 * The n8n-style Data Bank palette — a floating, searchable catalog of every real
 * automation primitive in the codebase (clicks, fills, scrapers, navigations,
 * uploads). Group it by SYSTEM or by ACTION, narrow it with the kind-filter chips
 * or free text, and jump to the ops you placed recently. Each row shows the op's
 * human summary, the variables it reads/writes, and its source selector; click one
 * to drop it on the canvas. Note / Group annotations live in the footer.
 */
export function DataBankPalette({ bank, onAddOp, onAddAnnotation, onClose }: DataBankPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<PaletteView>("system");
  const [kinds, setKinds] = useState<DataBankOpKind[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { recentIds, pushRecent } = useRecentOpIds();

  const systems = bank?.systems ?? [];
  const groups = useMemo(() => buildPaletteGroups(systems, { view, query, kinds }), [systems, view, query, kinds]);
  const kindChips = useMemo(() => availableKinds(systems), [systems]);
  const total = paletteOpCount(bank);

  const filtering = query.trim().length > 0 || kinds.length > 0;
  const recentOps = useMemo(
    () => (filtering ? [] : resolveRecentOps(systems, recentIds).slice(0, 4)),
    [systems, recentIds, filtering],
  );

  const addOp = (op: DataBankOperation): void => {
    pushRecent(op.id);
    onAddOp(op);
  };
  const toggleKind = (kind: DataBankOpKind): void =>
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  const toggleGroup = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex max-h-[78vh] w-[27rem] flex-col rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
          <Database aria-hidden className="h-3.5 w-3.5 text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">Data bank</p>
          <p className="text-[11px] text-muted-foreground">
            {total} {total === 1 ? "operation" : "operations"} · {systems.length}{" "}
            {systems.length === 1 ? "system" : "systems"}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            aria-label="Close data bank"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2.5 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clicks, fills, scrapers…"
            aria-label="Search the data bank"
            className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="inline-flex w-fit gap-0.5 rounded-lg border border-border bg-secondary p-0.5">
          <ViewTab icon={Layers} label="By system" active={view === "system"} onClick={() => setView("system")} />
          <ViewTab icon={Shapes} label="By action" active={view === "action"} onClick={() => setView("action")} />
        </div>

        {kindChips.length ? (
          <div className="flex flex-wrap gap-1.5">
            {kindChips.map((kind) => {
              const v = opKindVisual(kind);
              const on = kinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "border-ring/60 bg-accent text-foreground"
                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <v.icon aria-hidden className={cn("h-3 w-3 shrink-0", v.accent)} />
                  {v.verb}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-live="polite">
        {!bank ? (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">
            No data bank yet — run <span className="font-mono">npm run data-bank:build</span>.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">No ops match your search.</p>
        ) : (
          <>
            {recentOps.length ? (
              <section className="mb-1">
                <SectionEyebrow icon={Clock} label="Recently used" />
                <ul className="space-y-0.5">
                  {recentOps.map((op) => (
                    <li key={`recent-${op.id}`}>
                      <OpRow op={op} onAdd={() => addOp(op)} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {groups.map((g) => {
              const open = filtering || !collapsed.has(g.id);
              return (
                <div key={g.id} className="mb-0.5">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.id)}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {open ? (
                      <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground">{g.label}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{g.ops.length}</span>
                  </button>
                  {open ? (
                    <ul className="space-y-0.5">
                      {g.ops.map((op) => (
                        <li key={op.id}>
                          <OpRow op={op} onAdd={() => addOp(op)} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Annotate footer */}
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Annotate</span>
        {ANNOTATIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            onClick={() => onAddAnnotation(a.kind)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <a.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ViewTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

function SectionEyebrow({ icon: Icon, label }: { icon: LucideIcon; label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      {label}
    </div>
  );
}

function OpRow({ op, onAdd }: { op: DataBankOperation; onAdd: () => void }): JSX.Element {
  const v = opKindVisual(op.kind);
  const description = op.summary ?? op.accessibleName ?? op.role ?? op.selectorFqn ?? "";
  const selectorHint =
    op.selectorFqn ?? (op.role ? `${op.role}${op.accessibleName ? ` · ${op.accessibleName}` : ""}` : "");
  return (
    <button
      type="button"
      onClick={onAdd}
      title={op.selectorFqn ?? op.summary ?? op.label}
      aria-label={`Add ${v.verb} — ${op.label}`}
      className="group flex w-full gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left outline-none transition-colors hover:border-border hover:bg-card focus-visible:border-border focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
        <v.icon aria-hidden className={cn("h-3.5 w-3.5", v.accent)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{op.label}</span>
          <span className={cn("shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide", v.chip)}>
            {v.verb}
          </span>
        </span>
        {description ? (
          <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-muted-foreground">{description}</span>
        ) : null}
        {op.inputVar || op.outputVar || selectorHint ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {op.inputVar ? <VarPill icon={ArrowDownToLine} value={op.inputVar} accent="text-log-cyan" /> : null}
            {op.outputVar ? <VarPill icon={ArrowUpFromLine} value={op.outputVar} accent="text-log-teal" /> : null}
            {selectorHint ? (
              <span className="truncate font-mono text-[10px] text-muted-foreground">{selectorHint}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function VarPill({ icon: Icon, value, accent }: { icon: LucideIcon; value: string; accent: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-px">
      <Icon aria-hidden className={cn("h-3 w-3 shrink-0", accent)} />
      <span className="font-mono text-[10px] text-foreground">{value}</span>
    </span>
  );
}
