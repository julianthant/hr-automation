import { useCallback, useEffect, useMemo, useState } from "react";
import { DemoLogPanel, tabsFor, type DemoTab } from "./DemoLogPanel";
import { computeVisibleIds, DemoQueue, type DemoFilter, type DemoQueueState, type DemoView } from "./DemoQueue";
import { DemoCatalogView } from "./DemoCatalogView";
import { DemoUiKit } from "./DemoUiKit";
import { CommandResultFeed, ConfirmCommandDialog, type PendingCommand } from "./DemoActions";
/* The run-START half: ONE Run Modal for every workflow, plus the spreadsheet
   intake it hands off to. It is mounted at the SHELL ROOT rather than in the
   queue toolbar, because "start any workflow from anywhere" has to hold on the
   Settings / Archive / Explorer / Report takeovers too — none of which draw a
   toolbar. Everything the modal renders comes off the workflow descriptor's own
   `start` capability (`demo-wire.ts`). */
import { DemoRunStartButton, DemoRunStartSurfaces } from "./DemoRunStart";
import { RenameRunDialog, type PendingRename } from "./DemoRunIdentity";
import { submitDemoCommand, type DemoCommandResult } from "./demo-commands";
import type { ActionDescriptorWire } from "./demo-wire";
import { DemoQueueToolbar, runBulkCommand, type BulkOutcome } from "./DemoBulkBar";
/* Tier 4b: the periphery — Settings (provenance · System URLs · budgets ·
   doctor · storage health · version registry), the read-only Archive, the
   Explorer and the activity report. Self-contained: everything they need
   lives in Demo{Settings,VersionBump,Archive,Explorer,ActivityReport}.tsx and
   demo-{settings,archive,explorer,report}-wire.ts. */
import { DemoSettingsPage, DemoStorageBanner, type SettingsSectionKey } from "./DemoSettings";
import { DemoArchivePage } from "./DemoArchive";
import { DemoExplorerPage } from "./DemoExplorer";
import { DemoActivityReportPage } from "./DemoActivityReport";
import type { StorageMode } from "./demo-settings-wire";
import {
  DEFAULT_WORKFLOW,
  countRows,
  DemoSessionPanel,
  DemoStatusFilters,
  DemoTopBar,
  DemoWorkflowPanelToggle,
  DemoWorkflowSidebar,
  DemoWorkflowWindow,
  type DemoShellView,
  rowInBucket,
  rowsForWorkflow,
  topLevelRows,
  useWorkflowPanelMode,
} from "./DemoShell";
// Row lookups go through the ALL-DAYS map: a row selected from a prior day must
// open exactly like a row from today.
import { ALL_DEMO_ROWS as DEMO_ROWS, DEMO_DAY } from "./demo-days";
import { ToastProvider, openContextMenuFor, useDemoTheme, useDsModalOpen } from "./demo-ui";
import {
  ATTENTION_STATUSES,
  type DemoRow,
  type DemoSortKey,
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
  // Graphite Warm / Paper Ink — one product, two compositions. Owned here
  // because the attribute belongs on the demo's root, not on a leaf.
  const { theme, toggleTheme } = useDemoTheme();
  const [selectedId, setSelectedId] = useState("oath-summer");
  const [shellView, setShellView] = useState<DemoShellView>("queue");
  /**
   * Which Settings section the gear opens on. The gear itself always lands on
   * the first one; the Top Bar's keyboard popover has its own route straight to
   * Help → Keyboard, so a control that shows the shortcut list can reach the
   * page that holds the same list.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>("general");
  const [activeWorkflow, setActiveWorkflow] = useState(DEFAULT_WORKFLOW);
  // Floating window · icon · docked sidebar, persisted. The 200px column is a
  // choice now rather than a tax, and the default costs the panels nothing.
  const { mode: panelMode, setMode: setPanelMode, cycleMode: cyclePanelMode, opened: panelOpened } = useWorkflowPanelMode();
  // the day partition every surface reads — the top bar's date IS this value
  const [day, setDay] = useState(DEMO_DAY);
  const [view, setView] = useState<DemoView>({ kind: "queue" });
  const [filter, setFilter] = useState<DemoFilter>("all");
  // Groups default collapsed, but a group auto-expands when a member is stuck
  // on you or has broken — you should never have to open a row to find that
  // out. The seed used to be gated on the member count as well, which is a
  // condition that no longer exists: there is ONE member shape now, so what a
  // group is holding decides whether it opens, never how much of it.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(Object.values(DEMO_ROWS).filter((r) => r.rowType === "group" && groupNeedsExpanding(r)).map((r) => r.id)),
  );
  const [tab, setTab] = useState<DemoTab | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(
    () => new Set(Object.values(DEMO_ROWS).filter((r) => r.checkedByDefault).map((r) => r.id)),
  );
  const [tick, setTick] = useState(0);
  /* Which storage snapshot the mock server is serving. Degraded is a real
     served state, not a UI mood — it drives the app-wide banner AND the
     server's refusal of every settings write. Switched from Settings →
     Storage health. */
  const [storage, setStorage] = useState<StorageMode>("read-write");
  /* The one Run Modal. Shell-owned so `r` reaches it from every view, and so it
     always opens on the panel the operator is standing in. */
  const [runStartOpen, setRunStartOpen] = useState(false);
  /* Radix traps FOCUS while a dialog is open, but a window keydown listener
     still fires — so j/k kept moving the queue selection behind an open modal
     and the operator came back to a different row than the one they left. */
  const modalOpen = useDsModalOpen();

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
    (row: DemoRow, action: ActionDescriptorWire): DemoCommandResult => {
      const result = submitDemoCommand(row, action, { knownVersion: refreshedVersions.get(row.id) ?? action.expectedVersion, tick });
      setResults((prev) => [result, ...prev].slice(0, 4));
      return result;
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
    (row: DemoRow, action: ActionDescriptorWire): DemoCommandResult | void => {
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
      return dispatchCommand(row, action);
    },
    [dispatchCommand, select],
  );

  // ONE scoped row set, for ONE day. The rail badge, the Status Bar and the
  // queue are all computed from this, through `countRows` — so changing the
  // date moves every count with the rows, never one without the other.
  // Operator renames ride along as a read-time overlay.
  const dayRows = useMemo(() => topLevelRows(day).map(withIdentity), [day, withIdentity]);
  const scopedRows = useMemo(() => rowsForWorkflow(dayRows, activeWorkflow), [dayRows, activeWorkflow]);
  const counts = useMemo(() => countRows(scopedRows), [scopedRows]);

  const state: DemoQueueState = useMemo(
    () => ({ view, filter, selectedId, checkedIds, expandedGroups, sort, selectMode, bulkIds, tick, panelWorkflow: activeWorkflow }),
    [view, filter, selectedId, checkedIds, expandedGroups, sort, selectMode, bulkIds, tick, activeWorkflow],
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

  /**
   * A link from search or a notification. It carries the row's DAY as well as
   * its panel, because a row from Wednesday cannot be selected while the app is
   * looking at Friday — the date has to move with the selection or the operator
   * lands on an empty queue.
   */
  const navigateTo = useCallback(
    (workflow: string, id: string, rowDay: string) => {
      setDay(rowDay);
      setShellView("queue");
      openPanel(workflow, id);
    },
    [openPanel],
  );

  /**
   * Moving the date re-anchors the selection inside the new day's corpus.
   * The selection has to stay inside the panel you are looking at, or the
   * detail panel describes a row the queue does not hold — so it lands on this
   * workflow's first row for the new day, and only follows the day elsewhere
   * when this workflow has nothing on it.
   */
  const changeDay = useCallback(
    (next: string) => {
      setDay(next);
      setView({ kind: "queue" });
      const rows = topLevelRows(next);
      if (rows.some((r) => r.id === selectedId)) return;
      const inPanel = rows.find((r) => r.wfLabel === activeWorkflow);
      const landing = inPanel ?? rows[0];
      if (!landing) return;
      if (!inPanel) setActiveWorkflow(landing.wfLabel);
      select(landing.id);
    },
    [select, selectedId, activeWorkflow],
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
      // A dialog owns the keyboard while it is open — including Escape, which
      // Radix answers itself. Nothing behind it may move.
      if (modalOpen) return;

      if (e.key === "r") {
        e.preventDefault();
        setRunStartOpen(true);
        return;
      }

      /**
       * The selected row's full command set, from the keyboard.
       *
       * The `⋯` button is gone and right-click replaced it, which on its own
       * would have made every command that is not in the footer unreachable
       * without a pointer — in a keyboard-first console that is a regression,
       * not a trade. The platform's own context-menu key (Menu / Shift+F10)
       * already works, because the browser dispatches `contextmenu` on the
       * focused element and Radix's trigger answers it; `m` is the documented
       * route that does not depend on the operator having that key, and it
       * works from the selection rather than from focus.
       */
      if (e.key === "m") {
        e.preventDefault();
        openContextMenuFor(document.querySelector(`[data-demo-row-id="${selectedId}"]`));
        return;
      }

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
        // Escape dismisses the INNERMOST thing: back out of a drill-in first,
        // and only once you are at the top level does it minimise the panel.
        // Reversing that would make drill-out unreachable while the panel is
        // showing, which is its default state.
        if (view.kind === "drill") {
          e.preventDefault();
          setView({ kind: "queue" });
        } else if (panelMode === "floating") {
          e.preventDefault();
          setPanelMode("icon");
        }
      } else if (e.key === "w") {
        e.preventDefault();
        cyclePanelMode();
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
  }, [view, filter, expandedGroups, sort, selectedId, select, toggleChecked, scopedRows, panelMode, setPanelMode, cyclePanelMode, modalOpen]);

  // keep the selected row visible when keyboard-navigating
  useEffect(() => {
    const el = document.querySelector(`[data-demo-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const row = withIdentity(DEMO_ROWS[selectedId] ?? DEMO_ROWS["sep-maria"]);

  const openExample = useCallback(
    (id: string) => {
      setShellView("queue");
      // Land in the example's OWN panel. With no all-workflows view there is
      // nowhere neutral to open it, and the row's workflow is the honest one.
      setActiveWorkflow(DEMO_ROWS[id]?.wfLabel ?? DEFAULT_WORKFLOW);
      setFilter("all");
      setView({ kind: "queue" });
      setDay(DEMO_ROWS[id]?.enqueuedAt.slice(0, 10) ?? DEMO_DAY);
      select(id);
    },
    [select],
  );

  return (
    <ToastProvider>
    {/* The theme attribute rides the demo's own root so the DOM says which of
        the pair is showing; `useDemoTheme` has already stamped <html> and
        <body> for the portalled overlays (see `ds/theme.ts`). */}
    <div data-demo-theme={theme} className="flex h-screen flex-col bg-background text-foreground">
      <DemoTopBar
        view={shellView}
        onView={setShellView}
        day={day}
        onDay={changeDay}
        onNavigate={navigateTo}
        tick={tick}
        theme={theme}
        onToggleTheme={toggleTheme}
        storage={storage}
        onStorage={setStorage}
        onOpenHelp={() => {
          setSettingsSection("keyboard");
          setShellView("settings");
        }}
      />

      {/* A degraded dashboard says so on every view, not only on the page that
          explains it — the operator has to know before they click, not after. */}
      <DemoStorageBanner storage={storage} onOpenSettings={() => setShellView("settings")} />

      {shellView === "settings" ? (
        <DemoSettingsPage storage={storage} initialSection={settingsSection} onBack={() => setShellView("queue")} />
      ) : shellView === "archive" ? (
        <DemoArchivePage
          onBack={() => setShellView("queue")}
          onOpenWorkflow={(label) => {
            setShellView("queue");
            changeWorkflow(label);
          }}
        />
      ) : shellView === "explorer" ? (
        <DemoExplorerPage onBack={() => setShellView("queue")} onOpenSettings={() => setShellView("settings")} />
      ) : shellView === "report" ? (
        <DemoActivityReportPage onBack={() => setShellView("queue")} onOpenSettings={() => setShellView("settings")} />
      ) : shellView === "kit" ? (
        /* every primitive in every state — the thing a builder skims BEFORE
           choosing a component, so no surface hand-rolls one that exists */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DemoUiKit />
        </div>
      ) : shellView === "catalog" ? (
        <DemoCatalogView onOpenExample={openExample} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Docked only in `sidebar`. In the other two modes the panel costs
              the queue and the detail panel no width at all. */}
          {panelMode === "sidebar" && (
            <DemoWorkflowSidebar
              mode={panelMode}
              onMode={setPanelMode}
              active={activeWorkflow}
              onActive={changeWorkflow}
              rows={dayRows}
            />
          )}

          <main className="flex min-h-0 flex-1 flex-col">
            {/* ONE bar above the panels now, not two. The Status Bar's ten
                pills were a band of their own directly above a band of
                unrelated controls; they are the middle GROUP of a single
                composed bar — where you are and what you start on the left,
                what you are looking at in the middle, how you are looking at it
                on the right. Select mode adds a second band while it is on. */}
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
              leading={
                <DemoWorkflowPanelToggle mode={panelMode} onMode={setPanelMode} active={activeWorkflow} rows={dayRows} />
              }
              runStart={<DemoRunStartButton onOpen={() => setRunStartOpen(true)} />}
              filters={<DemoStatusFilters counts={counts} active={filter} onSelect={setFilter} />}
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

            {/* The panel REGION. It is the positioning context for the floating
                Workflow Panel, so the window can overlay the panels without
                ever covering the bars above them.
                TWO thresholds, and they are deliberately different. THIS one
                (1180) splits queue | detail. The DETAIL cell splits itself
                again into shape · detail · context at 1280 (see `PanelRegion`).

                The QUEUE is 400px until 1480 and 470 above it, and 400 is
                measured, not chosen. Below 1480 the detail cell has to seat the
                348px context rail AND a centre column wide enough for the
                review's page-beside-fields layout; at a 470 queue the centre
                came out 414px, the review stacked, and the extracted fields —
                the whole reason that surface exists — went below the fold.
                The review's floor is a 464px centre (a label, a value, its
                provenance and its confidence on one line), and at 1280 the
                centre is 884 minus the queue. So 400 is the LARGEST queue that
                keeps the review side by side, with 20px of headroom: it is the
                least the queue can give up rather than a width picked for its
                own sake, and it is why this number is not 380.
                Stated plainly, because it is a real cost: at 1280 no width
                satisfies both. A queue that renders `Oath_Packet_Summer.pdf`
                whole needs ~475px, which puts the centre back under the review's
                floor. Filenames were already truncating at 470 (164px of the
                169px they want); at 400 they lose more, and the full name stays
                in the row's `title`, the footer's trace id, and the panel header.
                Above 1480 there is room for both and the queue takes it back. */}
            <div className="relative min-h-0 flex-1">
            <div className="grid h-full grid-cols-1 gap-3 p-3 min-[1180px]:grid-cols-[400px_minmax(0,1fr)] min-[1480px]:grid-cols-[470px_minmax(0,1fr)]">
              <DemoQueue
                rows={scopedRows}
                state={state}
                handlers={handlers}
                workflowLabel={activeWorkflow}
                day={day}
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

              {panelMode === "floating" && (
                <DemoWorkflowWindow
                  mode={panelMode}
                  onMode={setPanelMode}
                  active={activeWorkflow}
                  onActive={changeWorkflow}
                  rows={dayRows}
                  opened={panelOpened}
                />
              )}
            </div>
          </main>
        </div>
      )}

      <DemoSessionPanel tick={tick} />

      {/* ONE Run Modal, at the root, defaulting to the panel you are standing
          in. Reachable by the toolbar's primary control and by `r` from every
          view — including the takeovers, which have no toolbar at all. */}
      <DemoRunStartSurfaces open={runStartOpen} onOpenChange={setRunStartOpen} panelWorkflowLabel={activeWorkflow} />

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
    </ToastProvider>
  );
}
