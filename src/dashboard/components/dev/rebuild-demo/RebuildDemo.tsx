import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { DemoLogPanel, tabsFor, type DemoTab } from "./DemoLogPanel";
import { computeVisibleIds, DemoQueue, type DemoFilter, type DemoQueueState, type DemoView } from "./DemoQueue";
import { DemoCatalogView } from "./DemoCatalogView";
import { DemoUiKit } from "./DemoUiKit";
import { CommandResultFeed, ConfirmCommandDialog, type PendingCommand } from "./DemoActions";
/* Tier 3a: the run-START surfaces (Run Modal · Input Run Panel · spreadsheet
   intake). Self-contained — everything it needs lives in DemoRunStart*.tsx,
   demo-runstart-wire.ts and demo-data-intake.ts. */
import { DemoRunStartBar } from "./DemoRunStart";
import { RenameRunDialog, type PendingRename } from "./DemoRunIdentity";
import { submitDemoCommand, type DemoCommandResult } from "./demo-commands";
import type { ActionDescriptorWire } from "./demo-wire";
import { DemoQueueToolbar, runBulkCommand, type BulkOutcome } from "./DemoBulkBar";
import {
  ALL_WORKFLOWS,
  countRows,
  DemoSessionPanel,
  DemoStatusBar,
  DemoTopBar,
  DemoWorkflowPanel,
  type DemoShellView,
  rowInBucket,
  rowsForWorkflow,
  topLevelRows,
} from "./DemoShell";
import {
  ATTENTION_STATUSES,
  DEMO_ROWS,
  type DemoRow,
  type DemoSortKey,
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
  const [shellView, setShellView] = useState<DemoShellView>("queue");
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

  // ---- sort + bulk selection --------------------------------------------
  const [sort, setSort] = useState<DemoSortKey>("attention");
  const [selectMode, setSelectMode] = useState(false);
  const [bulkIds, setBulkIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null);

  /**
   * Operator-given names. The demo's mock server would persist `displayName`
   * on the row; here the projection is a module constant, so the rename is
   * applied as an OVERLAY at read time — which is also why the overlay patches
   * the rename descriptor's own label. The client still renders only what the
   * (mock) server sent; this function IS that server.
   */
  const [renames, setRenames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const withIdentity = useCallback(
    (r: DemoRow): DemoRow => {
      const named = renames.get(r.id);
      if (!named) return r;
      return {
        ...r,
        displayName: named,
        actions: r.actions.map((a) => (a.command === "rename" ? { ...a, label: "Rename run…" } : a)),
      };
    },
    [renames],
  );

  // ---- command state -----------------------------------------------------
  // Results are kept, never collapsed: a conflict and a rejection are outcomes
  // the operator has to SEE, and a partial vector may never read as "Done".
  const [results, setResults] = useState<DemoCommandResult[]>([]);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  // rows the operator force-refreshed after a conflict — the new CAS token
  const [refreshedVersions, setRefreshedVersions] = useState<ReadonlyMap<string, number>>(() => new Map());

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

  const dispatchCommand = useCallback(
    (row: DemoRow, action: ActionDescriptorWire) => {
      const result = submitDemoCommand(row, action, { knownVersion: refreshedVersions.get(row.id) ?? action.expectedVersion, tick });
      setResults((prev) => [result, ...prev].slice(0, 4));
    },
    [refreshedVersions, tick],
  );

  /**
   * The ONE entry point for every control in the demo. Navigation moves the
   * view; a command with server-authored confirm copy asks first; everything
   * else goes straight to the mock service. Note what is NOT here: no status
   * check, no per-button special case. The descriptor decides.
   */
  const runAction = useCallback(
    (row: DemoRow, action: ActionDescriptorWire) => {
      if (action.kind === "navigation") {
        if (action.navigate?.kind === "drill") setView({ kind: "drill", groupId: row.id });
        else if (action.navigate?.kind === "panel" && action.navigate.workflow && action.navigate.runId) {
          setActiveWorkflow(action.navigate.workflow);
          setFilter("all");
          setView({ kind: "queue" });
          select(action.navigate.runId);
        } else select(row.id);
        return;
      }
      // Rename is the one command that asks for a VALUE rather than a
      // confirmation, so it opens its own dialog before it is submitted.
      if (action.command === "rename") {
        setPendingRename({ row, action });
        return;
      }
      // D16 keeps group cancel exempt from confirmation by construction: the
      // cancel-tree descriptor carries no `confirm`, so it lands here directly.
      if (action.confirm) {
        setPending({ row, action });
        return;
      }
      dispatchCommand(row, action);
    },
    [dispatchCommand, select],
  );

  // ONE scoped row set. The rail badge, the Status Bar and the queue are all
  // computed from this, through `countRows`.
  const scopedRows = useMemo(
    () => rowsForWorkflow(topLevelRows(), activeWorkflow).map(withIdentity),
    [activeWorkflow, withIdentity],
  );
  const counts = useMemo(() => countRows(scopedRows), [scopedRows]);

  const state: DemoQueueState = useMemo(
    () => ({ view, filter, selectedId, checkedIds, expandedGroups, sort, selectMode, bulkIds, tick }),
    [view, filter, selectedId, checkedIds, expandedGroups, sort, selectMode, bulkIds, tick],
  );

  /** the top-level rows on screen right now — all Select all may ever take */
  const bulkCandidates = useMemo(() => scopedRows.filter((r) => rowInBucket(r, filter)), [scopedRows, filter]);

  // A selection you cannot see is a bulk command you cannot predict, so the
  // target set is dropped whenever the view it was made in changes.
  useEffect(() => {
    setBulkIds(new Set());
  }, [activeWorkflow, filter]);

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
      onAction: runAction,
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
      onToggleBulk: (id: string) =>
        setBulkIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
    }),
    [select, openPanel, runAction],
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

      const visible = computeVisibleIds(scopedRows, { view, filter, expandedGroups, sort });
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
  }, [view, filter, expandedGroups, sort, selectedId, select, toggleChecked, scopedRows]);

  // keep the selected row visible when keyboard-navigating
  useEffect(() => {
    const el = document.querySelector(`[data-demo-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const row = withIdentity(DEMO_ROWS[selectedId] ?? DEMO_ROWS["sep-maria"]);
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

      {shellView === "kit" ? (
        /* every primitive in every state — the thing a builder skims BEFORE
           choosing a component, so no surface hand-rolls one that exists */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DemoUiKit />
        </div>
      ) : shellView === "catalog" ? (
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

            {/* the run-START half of the product: Run Modal · Input Run Panel ·
                spreadsheet intake */}
            <DemoRunStartBar />

            {/* sort · select · bulk commands, with the full partial-result
                vector. Selection reorders and acts; it never filters, so no
                count can move because of it. */}
            <DemoQueueToolbar
              sort={sort}
              onSort={setSort}
              selectMode={selectMode}
              onSelectMode={(on) => {
                setSelectMode(on);
                if (!on) setBulkIds(new Set());
              }}
              selectedIds={bulkIds}
              visibleIds={bulkCandidates.map((r) => r.id)}
              onSelectAll={() => setBulkIds(new Set(bulkCandidates.map((r) => r.id)))}
              onClearSelection={() => setBulkIds(new Set())}
              onBulk={(command, label) =>
                setBulkOutcome(runBulkCommand(bulkCandidates.filter((r) => bulkIds.has(r.id)), command, label, tick))
              }
              outcome={bulkOutcome}
              onDismissOutcome={() => setBulkOutcome(null)}
              onSelectRow={select}
            />

            {/* applied · conflict · rejected — all three, side by side, never
                collapsed into a single "Done" */}
            <CommandResultFeed
              results={results}
              onDismiss={(id) => setResults((prev) => prev.filter((r) => r.id !== id))}
              onRefreshRow={(rowId, serverVersion) => {
                setRefreshedVersions((prev) => new Map(prev).set(rowId, serverVersion));
                setResults((prev) => prev.filter((r) => r.rowId !== rowId));
                select(rowId);
              }}
            />

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 min-[1180px]:grid-cols-[470px_minmax(0,1fr)]">
              <DemoQueue
                rows={scopedRows}
                state={state}
                handlers={handlers}
                workflowLabel={activeWorkflow === ALL_WORKFLOWS ? "" : activeWorkflow}
              />
              <DemoLogPanel
                row={row}
                tab={tab}
                onTab={setTab}
                onSelect={select}
                onOpenPanel={openPanel}
                checkedIds={checkedIds}
                onToggleChecked={toggleChecked}
                onAction={runAction}
                tick={tick}
                liveCount={liveCount}
              />
            </div>
          </main>
        </div>
      )}

      <DemoSessionPanel tick={tick} />

      {/* Destructive commands ask first — with the SERVER's own description of
          the blast radius. Group cancel is deliberately not in this flow. */}
      <ConfirmCommandDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={(p) => {
          setPending(null);
          dispatchCommand(p.row, p.action);
        }}
      />

      {/* Rename asks for a value, then goes through the SAME command service as
          everything else — so a stale view renaming a row still comes back a
          conflict, exactly like a retry would. */}
      <RenameRunDialog
        pending={pendingRename}
        onCancel={() => setPendingRename(null)}
        onConfirm={(p, name) => {
          setPendingRename(null);
          setRenames((prev) => new Map(prev).set(p.row.id, name));
          dispatchCommand({ ...p.row, displayName: name }, p.action);
          select(p.row.id);
        }}
      />
    </div>
  );
}
