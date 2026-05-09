import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { RetryButton } from "@/components/shared/RetryButton";
import { EmptyState } from "@/components/shared/EmptyState";
import { ScreenshotsPanel } from "./ScreenshotsPanel";
import { EditDataTab } from "./EditDataTab";
import { useLogs } from "@/components/hooks/useLogs";
import { useRunEvents } from "@/components/hooks/useRunEvents";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import { cn } from "@/lib/utils";
import type { TrackerEntry, RunInfo } from "@/components/shared/types";
import { formatTrackerValue, isMonospaceKey } from "@/components/shared/types";
import { deriveTrackerFallbackLog } from "./log-fallback";
import { useWorkflow } from "@/lib/workflows-context";
import { resolveEntryName } from "@/components/shared/entry-display";
import { statusBadgeClass } from "@/components/shared/status-styles";

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
  /** Cross-workflow entries for child-run detection. Optional — if absent, child section is hidden. */
  allEntries?: TrackerEntry[];
  /** Per-entry "<base> <ordinal>" labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  /**
   * Other entries merged into this entry (same person, different input
   * shapes — e.g. EID + name checks). Their runs are pooled with `entry`'s
   * runs and presented as one combined history. Each pooled run keeps its
   * true `itemId` so log fetching addresses the right JSONL key.
   */
  siblings?: TrackerEntry[];
  /** Default-active LogStream tab (e.g. "preview" when opening from an OcrQueueRow click). */
  defaultTab?: string;
  /** Optional preview content for the LogStream's Preview tab (e.g. OcrReviewPane body). */
  previewSlot?: ReactNode;
  /** Whether the Preview tab is shown. */
  previewAvailable?: boolean;
  /** Called when the operator triggers a hard-delete from the RunSelector toolbar. */
  onDeleteEntry?: () => void;
}

// Special virtual keys the generic detail renderer recognizes. These come
// from the entry's timestamp metadata rather than tracker data, so the
// type-aware formatter can't handle them — we branch on the key.
const COMPUTED_KEYS = new Set(["__started", "__elapsed"]);

export function LogPanel({ entry, workflow, date, allEntries, displayNames, siblings, defaultTab, previewSlot, previewAvailable, onDeleteEntry }: LogPanelProps) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(entry?.runId || null);
  const registered = useWorkflow(workflow);
  const [maximized, setMaximized] = useState(false);
  // Reset maximized whenever we switch to a different entry — operator's
  // intent for "fullscreen the tab" is per-row, not session-wide.
  useEffect(() => { setMaximized(false); }, [entry?.id, entry?.runId]);

  // Compute child entries (other entries where parentRunId === this run's runId).
  const childEntries: TrackerEntry[] = entry?.runId && allEntries
    ? allEntries.filter((e) => e.parentRunId === entry.runId && e.id !== entry.id)
    : [];
  const steps = registered?.steps ?? [];
  const detailFields = registered?.detailFields ?? [];

  // Stable key for the sibling list so we don't refetch on every parent
  // re-render — the siblings array reference may differ each tick even
  // when its contents are identical.
  const siblingIdsKey = (siblings ?? []).map((s) => s.id).sort().join("|");

  // Fetch runs when entry changes or a new run appears. When siblings are
  // present (merged-entry group), fetch each member's runs and pool them
  // into a single, globally-renumbered history. The merge ordering rule
  // is "concat by entry first-seen, then renumber 1..N globally" — so the
  // older entry keeps the low ordinals (1..k), siblings get k+1..N.
  useEffect(() => {
    if (!entry) {
      setRuns([]);
      setActiveRunId(null);
      return;
    }
    setActiveRunId((prev) => prev || entry.runId || null);

    const runsWorkflow = entry.workflow ?? workflow;
    const members: { id: string; firstSeen: string }[] = [
      { id: entry.id, firstSeen: entry.startTimestamp || entry.firstLogTs || entry.timestamp || "" },
      ...((siblings ?? []).map((s) => ({
        id: s.id,
        firstSeen: s.startTimestamp || s.firstLogTs || s.timestamp || "",
      }))),
    ];
    // Oldest-first so the older entry's ordinals come before the newer's
    // (matches "Langley, Leo keeps 1-5, 10874572 becomes 6-7").
    members.sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || ""));

    const fetchRuns = () => {
      Promise.all(
        members.map((m) =>
          fetch(`/api/runs?workflow=${encodeURIComponent(runsWorkflow)}&id=${encodeURIComponent(m.id)}&date=${encodeURIComponent(date)}`)
            .then((r) => r.json())
            .then((data: RunInfo[]) => data.map((run) => ({ ...run, itemId: m.id })))
            .catch(() => [] as RunInfo[]),
        ),
      ).then((perMember) => {
        // Concatenate in member order; within each member preserve the
        // backend's ordinal order (chronological within an itemId).
        const pooled = perMember.flat();
        // Globally renumber so the dropdown reads 1..N continuously.
        const renumbered = pooled.map((run, i) => ({ ...run, runOrdinal: i + 1 }));

        setRuns((prev) => {
          if (
            prev.length === renumbered.length &&
            prev.every((r, i) =>
              r.runId === renumbered[i].runId &&
              r.status === renumbered[i].status &&
              r.step === renumbered[i].step &&
              r.lastLogTs === renumbered[i].lastLogTs &&
              r.itemId === renumbered[i].itemId,
            )
          ) return prev;
          return renumbered;
        });

        setActiveRunId((prev) => {
          if (!prev) return renumbered.length > 0 ? renumbered[renumbered.length - 1].runId : entry.runId || null;
          const latestRunId = renumbered.length > 0 ? renumbered[renumbered.length - 1].runId : null;
          if (latestRunId && latestRunId !== prev && !renumbered.slice(0, -1).some((r) => r.runId === latestRunId)) {
            return latestRunId;
          }
          if (renumbered.some((r) => r.runId === prev)) return prev;
          return renumbered.length > 0 ? renumbered[renumbered.length - 1].runId : entry.runId || null;
        });
      });
    };

    fetchRuns();
    // Poll for new runs while ANY member of the group is running/pending —
    // a sibling can transition while this primary is terminal, and the
    // pooled run list needs to reflect that.
    const anyLive =
      entry.status === "running" || entry.status === "pending" ||
      (siblings ?? []).some((s) => s.status === "running" || s.status === "pending");
    const interval = anyLive ? setInterval(fetchRuns, 2_000) : undefined;
    return () => { if (interval) clearInterval(interval); };
  }, [entry?.id, entry?.runId, entry?.status, entry?.workflow, workflow, date, siblingIdsKey]);

  // Use the entry's own workflow when present (cross-workflow rows: OCR
  // prep rows surface in oath-signature/emergency-contact queues, but
  // their logs live in ocr-logs.jsonl). Falls back to the topbar workflow
  // when no entry is selected (skeleton state).
  const logSourceWorkflow = entry?.workflow ?? workflow;
  // When the active run came from a merged sibling, fetch logs against
  // the run's TRUE itemId rather than the primary's id — JSONL keys logs
  // per (workflow, itemId, runId) and the sibling's logs live under its
  // own itemId.
  const activeRunForLog = runs.find((r) => r.runId === activeRunId);
  const activeItemId = activeRunForLog?.itemId || entry?.id || null;
  const { logs, loading: logsLoading } = useLogs(logSourceWorkflow, activeItemId, activeRunId, date);
  const { events } = useRunEvents(logSourceWorkflow, activeItemId, activeRunId, date);
  // Count screenshot events for the screenshots tab; ScreenshotsPanel uses
  // this to refetch /api/screenshots without opening its own SSE.
  const screenshotEventCount = events.reduce(
    (n, e) => (e.type === "screenshot" ? n + 1 : n),
    0,
  );
  const trackerFallbackLog = deriveTrackerFallbackLog(entry, activeRunId);
  const displayedLogs = !logsLoading && logs.length === 0 && trackerFallbackLog
    ? [trackerFallbackLog]
    : logs;

  // Derive step/status from active run when viewing a HISTORICAL run via the
  // RunSelector. For the LIVE run (activeRun matches the SSE-delivered entry's
  // runId) prefer the SSE entry — `/api/runs` is polled every 2s only while
  // entry.status is running/pending, so the moment SSE flips status to done
  // the polling stops and `activeRun.step` freezes at whatever step the LAST
  // poll captured. For fast workflows (e.g. OCR with 0 records) that's the
  // first step, leaving the timeline stuck even though the entry is terminal.
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const isViewingLiveRun = !activeRunId || activeRunId === entry?.runId;
  const runStatus = isViewingLiveRun
    ? (entry?.status || activeRun?.status || "pending")
    : (activeRun?.status || entry?.status || "pending");
  const runStep = isViewingLiveRun
    ? (entry?.step || activeRun?.step || null)
    : (activeRun?.step || null);

  // Prefer the per-run timestamps on the selected RunInfo; fall back to the
  // deduped entry's fields so the live (latest) run keeps working even
  // before /api/runs has returned. Using the run-scoped values means
  // "Started" + "Elapsed" actually switch when the operator picks an older
  // run in the RunSelector, instead of always mirroring the latest run.
  const firstTs =
    activeRun?.firstLogTs ||
    entry?.firstLogTs ||
    entry?.startTimestamp ||
    entry?.timestamp ||
    null;
  const lastTs =
    activeRun?.lastLogTs || entry?.lastLogTs || entry?.timestamp || null;
  const elapsed = useElapsed(runStatus === "running" ? firstTs : null);
  const duration = runStatus !== "running" && firstTs && lastTs && firstTs !== lastTs
    ? formatDuration(firstTs, lastTs)
    : null;

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col bg-card">
        <EmptyState
          icon={TerminalSquare}
          title="Select an entry"
          description="Click an entry in the queue to view its logs"
        />
      </div>
    );
  }

  const name = resolveEntryName(entry, displayNames);
  const displayTs = firstTs || entry.timestamp;
  const startTime = displayTs
    ? new Date(displayTs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "";

  // Compose the full detail-field list: registered workflow fields whose
  // `displayInGrid` isn't explicitly false + the two synthesized
  // (Started/Elapsed) cells. Edit-only fields (e.g. separations'
  // separationDate) stay declared on the workflow but are hidden here —
  // they only render in the Edit Data tab.
  const allDetailFields: Array<{ key: string; label: string }> = [
    ...detailFields.filter((f) => f.displayInGrid !== false),
    { key: "__started", label: "Started" },
    { key: "__elapsed", label: "Elapsed" },
  ];

  // The detail grid renders fields off `formatTrackerValue(entry, key)`,
  // which reads `entry.data[key]`. When the operator is viewing a HISTORICAL
  // run via the RunSelector, the deduped entry's data is the LATEST run's
  // data (often null/empty for cancelled rows) \u2014 not the data captured by
  // the run they actually selected. Use the per-run `data` carried on
  // `RunInfo` (server-side `runs.latest_data_json` via `/api/runs`) so
  // switching the run pill repaints the grid with that run's own values.
  // When swapping in a historical run's data, ALSO clear typedData — it's
  // the typed-shape mirror of the deduped entry's `data` and `formatTrackerValue`
  // checks it first. Leaving the primary's typedData in place would mask the
  // per-run `data` we just substituted (e.g. showing "Not found" from
  // 10874572's last run while the operator is viewing Langley's earlier
  // successful run).
  const detailEntry: TrackerEntry = !isViewingLiveRun && activeRun?.data
    ? { ...entry, data: activeRun.data as TrackerEntry["data"], typedData: undefined }
    : entry;

  const renderDetailValue = (key: string): string => {
    if (key === "__started") return startTime;
    if (key === "__elapsed") return elapsed || duration || "\u2014";
    return formatTrackerValue(detailEntry, key);
  };

  const Skeleton = ({ className }: { className?: string }) => (
    <div className={cn("rounded bg-muted animate-pulse", className)} />
  );

  // Show skeleton while logs are loading and we have no data yet
  const showSkeleton = logsLoading && displayedLogs.length === 0;

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0 min-h-0 overflow-hidden">
      {/* Header + detail grid + step pipeline are hidden when the operator
          maximizes a tab so the tab content takes the full LogPanel height. */}
      {!maximized && (<>
      {/* Header — height matches QueuePanel search + DuoPanel title */}
      <div className="h-[69.5px] flex items-center justify-between px-6 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3.5">
          {showSkeleton ? (
            <>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-16 rounded-xl" />
            </>
          ) : (
            <>
              <span className="font-bold text-lg">{name || entry.id}</span>
              <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", statusBadgeClass(runStatus))}>
                {runStatus}
              </span>
              {name && <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} onDeleteEntry={onDeleteEntry} />
          {runStatus === "failed" && entry && (
            <RetryButton workflow={entry.workflow} id={entry.id} size="md" />
          )}
        </div>
      </div>

      {/* Detail grid — rendered from registry metadata via formatTrackerValue;
          auto-adapts to any workflow's detailFields declaration. Wraps to
          rows of 4. Special __started / __elapsed keys are synthesized from
          entry timestamps. */}
      <div className="grid grid-cols-4 flex-shrink-0">
        {allDetailFields.map((f) => {
          const value = renderDetailValue(f.key);
          const isComputed = COMPUTED_KEYS.has(f.key);
          // Monospace treatment for id-like fields + computed timestamps
          const mono = isComputed || isMonospaceKey(f.key);
          const isRunningElapsed = f.key === "__elapsed" && runStatus === "running";
          return (
            <div
              key={f.key}
              style={{ height: "69.5px" }}
              className="px-6 flex flex-col justify-center gap-1 overflow-hidden border-b border-r border-border"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium leading-none">
                {f.label}
              </div>
              {showSkeleton ? (
                <Skeleton className="h-4 w-20" />
              ) : (
                <div className={cn(
                  "text-sm truncate leading-tight",
                  mono ? "font-mono" : "font-medium",
                  isRunningElapsed && "text-primary",
                )} title={value}>
                  {value}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Step pipeline */}
      {showSkeleton ? (
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center">
              {i > 0 && <Skeleton className="w-8 h-0.5 mx-1.5" />}
              <Skeleton className="w-6 h-6 rounded-full" />
              <Skeleton className="h-3 w-16 ml-1.5" />
            </div>
          ))}
        </div>
      ) : (
        <StepPipeline
          steps={steps}
          currentStep={runStep}
          status={runStatus}
          stepDurations={activeRun?.stepDurations ?? entry?.stepDurations}
          entry={entry ?? undefined}
        />
      )}

      </>)}

      {!maximized && childEntries.length > 0 && (
        <section className="mb-3 rounded-md border border-border p-3 mx-0">
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Delegated runs ({childEntries.length})
          </h3>
          <ul className="space-y-1">
            {childEntries.map((c) => (
              <li
                key={`${c.workflow}#${c.id}#${c.runId}`}
                className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground"
              >
                <span className="font-medium text-foreground/80">{c.workflow}</span>
                <span className="truncate">{c.id}</span>
                <span className={cn(
                  "ml-auto px-1.5 py-px rounded text-[10px]",
                  c.status === "done" && "bg-success/10 text-success",
                  c.status === "failed" && "bg-destructive/10 text-destructive",
                  c.status === "running" && "bg-primary/10 text-primary",
                  c.status === "pending" && "bg-warning/10 text-warning",
                )}>
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <LogStream
        logs={displayedLogs}
        events={events}
        loading={logsLoading}
        screenshotsSlot={
          <ScreenshotsPanel
            workflow={workflow}
            itemId={activeItemId}
            screenshotEventCount={screenshotEventCount}
          />
        }
        editDataAvailable={detailFields.some((f) => f.editable)}
        editDataSlot={
          <EditDataTab
            workflow={workflow}
            entry={entry ?? null}
            runId={activeRunId}
            date={date}
          />
        }
        previewSlot={previewSlot}
        previewAvailable={previewAvailable}
        initialTab={defaultTab}
        maximized={maximized}
        onToggleMaximize={() => setMaximized((v) => !v)}
      />
    </div>
  );
}
