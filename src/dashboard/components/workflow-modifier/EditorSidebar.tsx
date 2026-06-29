import { Database } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowListEntry } from "./useWorkflowPresentation.js";
import { NODE_ROW } from "./graph/graph-types.js";
import type { OutlineModel, OutlineEntry } from "./graph/outline-build.js";

interface EditorSidebarProps {
  // Workflow picker
  list: WorkflowListEntry[];
  selected: string | null;
  /** Live override count for the selected workflow (from the draft). */
  selectedCount: number;
  onSelect: (name: string) => void;

  // Data bank trigger (opens the floating palette over the canvas)
  paletteOpen: boolean;
  onTogglePalette: () => void;

  // Outline of the selected workflow (drops down from its row)
  outline: OutlineModel | null;
  focusedId: string | null;
  onFocus: (id: string) => void;

  // Canvas view controls
  allCollapsed: boolean;
  onToggleAll: () => void;
  dataFlowOn: boolean;
  onToggleDataFlow: () => void;
  dryRunOn: boolean;
  onToggleDryRun: () => void;
  onFit: () => void;
}

/**
 * The merged editor sidebar — workflow picker + outline in one panel. Picking a
 * workflow expands its outline inline (the presentation spine: queue row →
 * pipeline steps with op counts → delegation), so the whole workflow is reachable
 * without leaving the list. The "Data bank" button at the right of the header
 * opens the floating op palette over the canvas; clicking an outline entry FOCUSES
 * that lane on the canvas. The footer carries the three canvas view controls.
 */
export function EditorSidebar({
  list,
  selected,
  selectedCount,
  onSelect,
  paletteOpen,
  onTogglePalette,
  outline,
  focusedId,
  onFocus,
  allCollapsed,
  onToggleAll,
  dataFlowOn,
  onToggleDataFlow,
  dryRunOn,
  onToggleDryRun,
  onFit,
}: EditorSidebarProps): JSX.Element {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar" aria-label="Workflows and outline">
      <div className="flex items-center gap-2 px-3.5 py-3.5">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Workflows
        </span>
        <button
          type="button"
          aria-label="Open data bank"
          aria-pressed={paletteOpen}
          title="Data bank — every system's clicks, fills & scrapers"
          onClick={onTogglePalette}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            paletteOpen
              ? "border-ring/60 bg-accent text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Database aria-hidden className="h-4 w-4" />
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {list.map((w) => {
          const active = selected === w.name;
          return (
            <div key={w.name}>
              <button
                type="button"
                aria-label={`Configure ${w.label}`}
                aria-expanded={active}
                onClick={() => onSelect(w.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent font-semibold text-foreground shadow-[inset_2px_0_0_var(--primary)]"
                    : "text-foreground/90 hover:bg-accent hover:text-foreground",
                )}
              >
                <span className="flex-1 truncate">{w.label}</span>
                {active && selectedCount > 0 ? (
                  <span
                    className="inline-flex items-center rounded-full bg-secondary px-1.5 py-px text-[11px] font-semibold leading-none text-muted-foreground"
                    aria-label={`${selectedCount} override${selectedCount !== 1 ? "s" : ""}`}
                  >
                    {selectedCount}
                  </span>
                ) : !active && w.hasOverride ? (
                  <span aria-label="has saved overrides" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                ) : null}
              </button>

              {active && outline ? (
                <OutlineDropdown outline={outline} focusedId={focusedId} onFocus={onFocus} />
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="grid grid-cols-2 gap-1.5 border-t border-border p-2.5">
        <ControlButton label={allCollapsed ? "Expand all" : "Collapse all"} onClick={onToggleAll} />
        <ControlButton label="Fit" onClick={onFit} />
        <ControlButton label="Data flow" active={dataFlowOn} onClick={onToggleDataFlow} />
        <ControlButton label="Dry run" active={dryRunOn} onClick={onToggleDryRun} />
      </div>
    </aside>
  );
}

function OutlineDropdown({
  outline,
  focusedId,
  onFocus,
}: {
  outline: OutlineModel;
  focusedId: string | null;
  onFocus: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mb-1 ml-3 mt-1 border-l border-border pl-3">
      <p className="px-1.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">
        {outline.stepCount} {outline.stepCount === 1 ? "step" : "steps"} · {outline.totalOps} ops · {outline.systemCount}{" "}
        {outline.systemCount === 1 ? "system" : "systems"}
      </p>

      <OutlineRow
        entry={{ id: NODE_ROW, label: "Queue row" }}
        tag="naming"
        focused={focusedId === NODE_ROW}
        onFocus={onFocus}
      />

      <Eyebrow>Pipeline</Eyebrow>
      {outline.steps.map((s) => (
        <OutlineRow key={s.id} entry={s} focused={focusedId === s.id} onFocus={onFocus} />
      ))}

      {outline.delegation.length ? (
        <>
          <Eyebrow>Delegation</Eyebrow>
          {outline.delegation.map((d) => (
            <OutlineRow key={d.id} entry={d} focused={focusedId === d.id} onFocus={onFocus} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function OutlineRow({
  entry,
  tag,
  focused,
  onFocus,
}: {
  entry: OutlineEntry;
  tag?: string;
  focused: boolean;
  onFocus: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onFocus(entry.id)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        focused
          ? "bg-accent text-foreground shadow-[inset_2px_0_0_var(--primary)]"
          : "text-foreground/90 hover:bg-accent hover:text-foreground",
      )}
    >
      {entry.num !== undefined ? (
        <span className="flex h-[1.3rem] w-[1.3rem] shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-[11px] tabular-nums text-muted-foreground">
          {entry.num}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium">{entry.label}</span>
      {tag ? (
        <span className="shrink-0 rounded border border-border px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
          {tag}
        </span>
      ) : null}
      {entry.meta ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{entry.meta}</span> : null}
    </button>
  );
}

function Eyebrow({ children }: { children: string }): JSX.Element {
  return <p className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wide text-muted-foreground">{children}</p>;
}

function ControlButton({
  label,
  active = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "w-full rounded-lg border px-2 py-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-ring/60 bg-accent text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
