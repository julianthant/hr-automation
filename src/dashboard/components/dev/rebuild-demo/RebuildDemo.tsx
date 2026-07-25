import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { DemoLogPanel, tabsFor, type DemoTab } from "./DemoLogPanel";
import { computeVisibleIds, DemoQueue, type DemoFilter, type DemoQueueState, type DemoView } from "./DemoQueue";
import { DemoCatalogView } from "./DemoCatalogView";
import {
  ALL_WORKFLOWS,
  countRows,
  DemoSessionPanel,
  DemoStatusBar,
  DemoTopBar,
  DemoWorkflowPanel,
  rowsForWorkflow,
  topLevelRows,
} from "./DemoShell";
import {
  ATTENTION_STATUSES,
  DEMO_ROWS,
  densityRung,
  effectiveStatus,
  groupNeedsExpanding,
  LIVE_SEQUENCE,
  memberAttentionIds,
} from "./demo-data";

/**
 * DEV-ONLY — `?view=rebuild-demo`. The rebuild's target frontend as a living
 * demo: the full shell (Top Bar · Workflow Panel · Status Bar · Queue · Log
 * Panel · Session Panel) over one typed world model, where every surface
 * derives from the row you selected.
 *
 * Selecting a Workflow Panel entry genuinely scopes the view: the Status Bar
 * counts, the queue rows and the rail badge all read the same scoped row set
 * through the same counting path, so no two of them can disagree.
 *
 * Keyboard: j/k move · n next attention · Enter open group / drill-in ·
 * Esc back · c mark member checked · 1–4 switch tabs.
 */

export function RebuildDemo() {
  const [selectedId, setSelectedId] = useState("oath-summer");
  const [shellView, setShellView] = useState<"queue" | "catalog">("queue");
  const [activeWorkflow, setActiveWorkflow] = useState(ALL_WORKFLOWS);
  const [view, setView] = useState<DemoView>({ kind: "queue" });
  const [filter, setFilter] = useState<DemoFilter>("all");
  // Groups default collapsed, but a group auto-expands when a member is stuck
  // on you or has broken — you should never have to open a row to find that
  // out. A 1–3 member group is always expanded by its rung, not by this set.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        Object.values(DEMO_ROWS)
          .filter((r) => r.rowType === "group" && densityRung(r.memberIds?.length ?? 0) === "compact" && groupNeedsExpanding(r))
          .map((r) => r.id),
      ),
  );
  const [tab, setTab] = useState<DemoTab | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(
    () => new Set(Object.values(DEMO_ROWS).filter((r) => r.checkedByDefault).map((r) => r.id)),
  );
  const [tick, setTick] = useState(0);

  // live heartbeat — elapsed timers + the running row's scripted stream
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const liveCount = Math.min(Math.floor(tick / 4), LIVE_SEQUENCE.length);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setTab(null); // state-driven default re-applies per row
  }, []);

  // ONE scoped row set. The rail badge, the Status Bar and the queue are all
  // computed from this, through `countRows`.
  const scopedRows = useMemo(() => rowsForWorkflow(topLevelRows(), activeWorkflow), [activeWorkflow]);
  const counts = useMemo(() => countRows(scopedRows), [scopedRows]);

  const state: DemoQueueState = useMemo(
    () => ({ view, filter, selectedId, checkedIds, expandedGroups, tick }),
    [view, filter, selectedId, checkedIds, expandedGroups, tick],
  );

  /** open another Workflow Panel entry and land on a specific row inside it */
  const openPanel = useCallback(
    (workflow: string, id: string) => {
      setActiveWorkflow(workflow);
      setFilter("all");
      setView({ kind: "queue" });
      select(id);
    },
    [select],
  );

  const handlers = useMemo(
    () => ({
      onSelect: select,
      onFilter: setFilter,
      onDrillIn: (groupId: string) => setView({ kind: "drill", groupId }),
      onBack: () => setView({ kind: "queue" }),
      onOpenPanel: openPanel,
      onToggleGroup: (groupId: string) =>
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          if (next.has(groupId)) next.delete(groupId);
          else next.add(groupId);
          return next;
        }),
    }),
    [select, openPanel],
  );

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const changeWorkflow = useCallback((label: string) => {
    setActiveWorkflow(label);
    setView({ kind: "queue" });
  }, []);

  // ---- keyboard flow -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const visible = computeVisibleIds(scopedRows, { view, filter, expandedGroups });
      const idx = visible.indexOf(selectedId);

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        select(visible[Math.min(idx + 1, visible.length - 1)] ?? visible[0]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        select(visible[Math.max(idx - 1, 0)] ?? visible[0]);
      } else if (e.key === "n") {
        e.preventDefault();
        if (view.kind === "drill") {
          const attention = memberAttentionIds(view.groupId);
          const next = attention.find((id) => visible.indexOf(id) > idx) ?? attention[0];
          if (next) select(next);
        } else {
          const attention = visible.filter(
            (id) => ATTENTION_STATUSES.includes(effectiveStatus(DEMO_ROWS[id])) && DEMO_ROWS[id].containment !== "rejected",
          );
          const next = attention.find((id) => visible.indexOf(id) > idx) ?? attention[0];
          if (next) select(next);
        }
      } else if (e.key === "Enter") {
        const row = DEMO_ROWS[selectedId];
        if (row?.rowType === "group" && (row.memberIds?.length ?? 0) > 0) {
          e.preventDefault();
          setView({ kind: "drill", groupId: row.id });
        }
      } else if (e.key === "Escape") {
        if (view.kind === "drill") {
          e.preventDefault();
          setView({ kind: "queue" });
        }
      } else if (e.key === "c") {
        const row = DEMO_ROWS[selectedId];
        if (row?.rowType === "member" && row.containment !== "rejected") {
          e.preventDefault();
          toggleChecked(selectedId);
        }
      } else if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const keys = tabsFor(DEMO_ROWS[selectedId] ?? DEMO_ROWS["sep-maria"]);
        const next = keys[Number(e.key) - 1];
        if (next) setTab(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, filter, expandedGroups, selectedId, select, toggleChecked, scopedRows]);

  // keep the selected row visible when keyboard-navigating
  useEffect(() => {
    const el = document.querySelector(`[data-demo-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const row = DEMO_ROWS[selectedId] ?? DEMO_ROWS["sep-maria"];
  const allCounts = useMemo(() => countRows(topLevelRows()), []);

  const openExample = useCallback(
    (id: string) => {
      setShellView("queue");
      setActiveWorkflow(ALL_WORKFLOWS);
      setFilter("all");
      setView({ kind: "queue" });
      select(id);
    },
    [select],
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <DemoTopBar view={shellView} onView={setShellView} attention={allCounts.needsYou} />

      {shellView === "catalog" ? (
        <DemoCatalogView onOpenExample={openExample} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <DemoWorkflowPanel active={activeWorkflow} onActive={changeWorkflow} />

          <main className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1">
              <span className="text-[12.5px] font-semibold text-foreground">
                {activeWorkflow === ALL_WORKFLOWS ? "All workflows" : activeWorkflow}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{counts.all} rows</span>
              <span className="ml-auto hidden items-center gap-2 font-mono text-[10px] text-muted-foreground min-[1000px]:flex">
                <Keyboard aria-hidden className="size-3.5" />
                <span>
                  <kbd className="rounded border border-border bg-card px-1">j</kbd>/<kbd className="rounded border border-border bg-card px-1">k</kbd> move
                </span>
                <span>
                  <kbd className="rounded border border-border bg-card px-1">n</kbd> next attention
                </span>
                <span>
                  <kbd className="rounded border border-border bg-card px-1">Enter</kbd> open group
                </span>
                <span>
                  <kbd className="rounded border border-border bg-card px-1">c</kbd> check
                </span>
                <span>
                  <kbd className="rounded border border-border bg-card px-1">1</kbd>–<kbd className="rounded border border-border bg-card px-1">4</kbd> tabs
                </span>
              </span>
            </div>

            <DemoStatusBar counts={counts} active={filter} onSelect={setFilter} />

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 min-[1180px]:grid-cols-[470px_minmax(0,1fr)]">
              <DemoQueue rows={scopedRows} state={state} handlers={handlers} />
              <DemoLogPanel
                row={row}
                tab={tab}
                onTab={setTab}
                onSelect={select}
                onOpenPanel={openPanel}
                checkedIds={checkedIds}
                onToggleChecked={toggleChecked}
                tick={tick}
                liveCount={liveCount}
              />
            </div>
          </main>
        </div>
      )}

      <DemoSessionPanel tick={tick} />
    </div>
  );
}
