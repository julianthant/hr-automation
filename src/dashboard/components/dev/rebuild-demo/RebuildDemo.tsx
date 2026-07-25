import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { DemoLogPanel, type DemoTab } from "./DemoLogPanel";
import { computeVisibleIds, DemoQueue, type DemoFilter, type DemoQueueState, type DemoView } from "./DemoQueue";
import { DEMO_ROWS, LIVE_SEQUENCE, memberAttentionIds, ATTENTION_STATUSES } from "./demo-data";

/**
 * DEV-ONLY — `?view=rebuild-demo`. The rebuild's target frontend as a living
 * demo: the full queue (3 ratified row types × 8 ratified statuses, 50-member
 * group, triage drill-in) wired to a per-row log panel where every surface —
 * outcome bar, strip, waterfall, filmstrip, all 5 tabs — derives from THAT
 * row's own data. Synthetic data; interactions that matter (selection,
 * drill-in, conveyor, mark-checked, filters, search, keyboard) are real.
 *
 * Keyboard: j/k move · n next attention · Enter open group / drill-in ·
 * Esc back · c mark member checked · 1–5 switch tabs.
 */

const TAB_KEYS: DemoTab[] = ["logs", "data", "review", "receipt", "shots"];

export function RebuildDemo() {
  const [selectedId, setSelectedId] = useState("sep-maria");
  const [view, setView] = useState<DemoView>({ kind: "queue" });
  const [filter, setFilter] = useState<DemoFilter>("all");
  const [oathExpanded, setOathExpanded] = useState(false);
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

  const state: DemoQueueState = useMemo(
    () => ({ view, filter, selectedId, checkedIds, oathExpanded, tick }),
    [view, filter, selectedId, checkedIds, oathExpanded, tick],
  );

  const handlers = useMemo(
    () => ({
      onSelect: select,
      onFilter: setFilter,
      onDrillIn: (groupId: string) => setView({ kind: "drill", groupId }),
      onBack: () => setView({ kind: "queue" }),
      onToggleOath: () => setOathExpanded((v) => !v),
    }),
    [select],
  );

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- keyboard flow -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const visible = computeVisibleIds({ view, filter, oathExpanded });
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
          const attention = visible.filter((id) => ATTENTION_STATUSES.includes(DEMO_ROWS[id].status) && !DEMO_ROWS[id].displayOnly);
          const next = attention.find((id) => visible.indexOf(id) > idx) ?? attention[0];
          if (next) select(next);
        }
      } else if (e.key === "Enter") {
        const row = DEMO_ROWS[selectedId];
        if (row?.rowType === "group") {
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
        if (row?.rowType === "member" && !row.displayOnly) {
          e.preventDefault();
          toggleChecked(selectedId);
        }
      } else if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setTab(TAB_KEYS[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, filter, oathExpanded, selectedId, select, toggleChecked]);

  // keep the selected row visible when keyboard-navigating
  useEffect(() => {
    const el = document.querySelector(`[data-demo-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const row = DEMO_ROWS[selectedId] ?? DEMO_ROWS["sep-maria"];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* demo banner */}
      <header className="flex items-center gap-3 border-b border-border/60 px-4 py-2">
        <span className="text-[13px] font-semibold">Rebuild demo</span>
        <span className="rounded-full border border-info/40 bg-info/10 px-2 py-px text-[9.5px] font-semibold uppercase tracking-wider text-info">
          target design · synthetic data
        </span>
        <span className="ml-auto hidden items-center gap-2 font-mono text-[10px] text-muted-foreground min-[900px]:flex">
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
            <kbd className="rounded border border-border bg-card px-1">Esc</kbd> back
          </span>
          <span>
            <kbd className="rounded border border-border bg-card px-1">c</kbd> check
          </span>
          <span>
            <kbd className="rounded border border-border bg-card px-1">1</kbd>–<kbd className="rounded border border-border bg-card px-1">5</kbd> tabs
          </span>
        </span>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 min-[1080px]:grid-cols-[470px_minmax(0,1fr)]">
        <DemoQueue state={state} handlers={handlers} />
        <DemoLogPanel
          row={row}
          tab={tab}
          onTab={setTab}
          onSelect={select}
          checkedIds={checkedIds}
          onToggleChecked={toggleChecked}
          tick={tick}
          liveCount={liveCount}
        />
      </main>
    </div>
  );
}
