import { useLayoutEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowInstanceState } from "@/components/shared/types";
import { useClock } from "@/components/hooks/useClock";
import { useSessions } from "@/components/hooks/useSessions";
import { useTerminalDrawer } from "@/components/hooks/useTerminalDrawer";
import { AddWorkerButton } from "./AddWorkerButton";
import { LiveIndicator } from "./LiveIndicator";
import { WorkflowBox } from "./WorkflowBox";

const BAR_HEIGHT = 36;
const MAX_DRAWER_HEIGHT = 320;
const MIN_BODY_HEIGHT = 32;

/**
 * Bucket active daemon instances into running / authenticating / idle / failed
 * counts for the collapsed-bar summary. Three-way split:
 *
 *   • itemInFlight → running   (processing a live item)
 *   • daemonPhase set (idle|keepalive) → idle   (reached the claim loop, no item)
 *   • alive but daemonPhase not yet set → authenticating   (mid-auth: serial Duo
 *     prompts, browser launch, login retries — hasn't entered the claim loop yet)
 *   • crashedOnLaunch | finalStatus === "failed" → failed
 *
 * `daemonPhase` is only emitted once the daemon transitions to 'idle' or
 * 'keepalive' (daemon.ts `setPhase`), so its absence reliably signals that auth
 * is still in progress. A daemon that finished auth and is genuinely parked MUST
 * count as idle (daemonPhase is defined), not authenticating.
 */
export function bucketDaemonCounts(workers: WorkflowInstanceState[]): {
  running: number;
  authenticating: number;
  idle: number;
  failed: number;
} {
  let running = 0;
  let authenticating = 0;
  let idle = 0;
  let failed = 0;
  for (const w of workers) {
    if (w.crashedOnLaunch || w.finalStatus === "failed") {
      failed += 1;
    } else if (w.itemInFlight) {
      running += 1;
    } else if (w.daemonPhase === "idle" || w.daemonPhase === "keepalive") {
      idle += 1;
    } else {
      // Alive but hasn't reached the claim loop yet → still authenticating.
      authenticating += 1;
    }
  }
  return { running, authenticating, idle, failed };
}

/**
 * Roll up per-browser HEALTH across every active session's browsers — the
 * at-a-glance "is any browser in trouble?" signal for the collapsed drawer bar.
 * Orthogonal to `bucketDaemonCounts` (which buckets DAEMON lifecycle): a daemon
 * can be "idle" yet have a `failed` UCPath browser. `undefined` health (never
 * probed) counts as healthy. Exported for unit tests.
 */
export function bucketBrowserHealth(workers: WorkflowInstanceState[]): {
  total: number;
  failed: number;
  degraded: number;
  refreshing: number;
  healthy: number;
} {
  let total = 0;
  let failed = 0;
  let degraded = 0;
  let refreshing = 0;
  let healthy = 0;
  for (const w of workers) {
    for (const s of w.sessions) {
      for (const b of s.browsers) {
        total += 1;
        if (b.health === "failed") failed += 1;
        else if (b.health === "unhealthy") degraded += 1;
        else if (b.health === "refreshing") refreshing += 1;
        else healthy += 1;
      }
    }
  }
  return { total, failed, degraded, refreshing, healthy };
}

/**
 * Best-effort "would another daemon absorb this card's in-flight item?" hint,
 * computed from the live session list. A peer counts only when it is a SEPARATE
 * instance of the SAME workflow that is currently alive (`pidAlive`) and active
 * — i.e. a healthy daemon that could pick up a reassigned claim. Crashed-on-
 * launch instances and the card's own instance are excluded.
 *
 * This is the same axis the backend re-derives authoritatively at stop time
 * (`reassignable` in worker-control, which compares `alive.some(d => d.pid !==
 * pid)`), but computing it client-side lets the StopPill decide whether to
 * confirm BEFORE firing the request — so the destructive last-daemon confirm
 * only appears when there really is no peer.
 *
 * Peer identity prefers the OS `pid` when both rows carry it (matching the
 * backend's pid-based check); it falls back to the instance label only when a
 * pid is missing (legacy session events written before pid was stamped).
 */
/**
 * Two session-card states refer to DIFFERENT live daemons. Prefer the OS `pid`
 * (matching the backend's pid-based reassignable check); fall back to the
 * instance label only when a pid is missing (legacy session events written
 * before pid was stamped).
 */
function isDifferentPeer(w: WorkflowInstanceState, self: WorkflowInstanceState): boolean {
  if (w.pid != null && self.pid != null) return w.pid !== self.pid;
  return w.instance !== self.instance;
}

function hasReassignablePeer(
  instances: WorkflowInstanceState[],
  self: WorkflowInstanceState,
): boolean {
  if (!self.workflow) return false;
  return instances.some(
    (w) =>
      isDifferentPeer(w, self) &&
      w.workflow === self.workflow &&
      w.pidAlive &&
      w.active &&
      !w.crashedOnLaunch,
  );
}

interface TerminalDrawerProps {
  /** SSE-backend connection state, surfaced as the right-edge Live pill. */
  connected: boolean;
  /** When viewing a past date, the Live pill downgrades to a muted History pill. */
  viewingHistory?: boolean;
  /**
   * Per-workflow collapsed top-level QUEUED surface count (backend
   * `wfQueuedCounts`) — the same collapse model as the rail total, so the
   * session-card "N queued" chip never shows the inflated raw delegated-member
   * count (ISS-002). Threaded to each `WorkflowBox`.
   */
  queuedCounts: Record<string, number>;
}

/**
 * Bottom-docked drawer for active workflow sessions. The bar
 * itself is the toggle (clicking it flips state). `Cmd+J` / `Ctrl+J` also
 * toggles, registered globally in `useTerminalDrawer`.
 *
 * Closed: 36px-tall status bar showing chevron + "session" label + active-
 * instance count. Open: bar + horizontal scroller of `WorkflowBox` cards,
 * with the body height auto-fitting to the tallest card (capped at
 * `MAX_DRAWER_HEIGHT`) so a single small card doesn't leave dead space.
 *
 * Right edge of the bar tiles with LogPanel + LogStream's `pr-6` so the
 * Live pill / clock land at the same X as the date nav and Auto-scroll
 * button on the right side of the dashboard.
 *
 * Only workflows whose process is alive (or crashed-on-launch) and whose
 * batch has not ended are shown.
 */
export function TerminalDrawer({ connected, viewingHistory = false, queuedCounts }: TerminalDrawerProps) {
  const { open, toggle } = useTerminalDrawer();
  const clock = useClock();
  const { state } = useSessions();

  // Keep crashed-on-launch instances even after pidAlive flips false so the
  // operator learns about the failure.
  const visible = state.workflows.filter((w) => w.pidAlive || w.crashedOnLaunch);
  const active = visible.filter((w) => w.active || w.crashedOnLaunch);
  const count = active.length;

  // Bucket active sessions so the collapsed bar shows health at a glance —
  // a red "failed" dot draws the eye before the operator expands the drawer.
  const { running, authenticating, idle, failed } = bucketDaemonCounts(active);
  const browserHealth = bucketBrowserHealth(active);

  // Alive worker count per workflow, surfaced in the add-worker picker so the
  // operator sees current capacity ("separations: 1 worker") before adding one.
  // An entry in `active` with !crashedOnLaunch is pidAlive && active — a live
  // working daemon.
  const workerCounts: Record<string, number> = {};
  for (const w of active) {
    if (w.workflow && !w.crashedOnLaunch) {
      workerCounts[w.workflow] = (workerCounts[w.workflow] ?? 0) + 1;
    }
  }

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bodyHeight = Math.max(contentHeight, MIN_BODY_HEIGHT);
  const openHeight = Math.min(BAR_HEIGHT + bodyHeight, MAX_DRAWER_HEIGHT);

  return (
    <div
      id="terminal-drawer"
      role="region"
      aria-label="Active sessions drawer"
      className={cn(
        "terminal-drawer",
        "shrink-0 bg-background overflow-hidden flex flex-col",
      )}
      style={{
        // Height transition uses ease-out-expo for a snappy open. Closing
        // uses standard ease-out via the inverse transition. `prefers-
        // reduced-motion` zeroes the transition via the .terminal-drawer class.
        height: open ? `${openHeight}px` : `${BAR_HEIGHT}px`,
        transition: "height 180ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* Bar. A top border in the accent colour visually separates the bar
           from the main dashboard content above. The left/centre is the
           toggle button (clicking it flips the drawer); the right-edge
           cluster (add-worker "+", Live pill, clock) is a SIBLING of the
           toggle — interactive controls must not nest inside a <button>. */}
      <div
        className={cn(
          "h-9 w-full flex items-center justify-between pl-4 pr-6 shrink-0",
          "border-accent-foreground/40",
          open ? "border-b" : "border-t",
          "hover:bg-foreground/5 transition-colors",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="terminal-drawer-body"
          className={cn(
            "flex items-center gap-3 min-w-0 flex-1 h-full rounded-sm",
            "text-[12px] text-muted-foreground",
            "outline-none focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
            "select-none cursor-pointer",
          )}
        >
          <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={2} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">session</span>
          <SessionSummary count={count} running={running} authenticating={authenticating} idle={idle} failed={failed} />
          <BrowserHealthSummary failed={browserHealth.failed} degraded={browserHealth.degraded} refreshing={browserHealth.refreshing} />
        </button>
        {/* Right edge: add-worker "+", then the Live pill, then the clock.
            Live sits before the clock so the operator's eye lands on
            connection state first when scanning the screen's bottom-right
            corner — the clock is ambient and only checked on demand. */}
        <span className="flex items-center gap-3 shrink-0 pl-3">
          <AddWorkerButton workerCounts={workerCounts} queuedCounts={queuedCounts} />
          <LiveIndicator connected={connected} viewingHistory={viewingHistory} />
          <span className="font-mono text-[12px] text-muted-foreground font-medium tabular-nums leading-none">
            {clock}
          </span>
        </span>
      </div>

      {/* Body — horizontal strip of WorkflowBox cards. Border-t intentionally
          omitted to honour the dashboard's border-b/border-r convention; the
          main row above carries border-b which provides the same divider. */}
      <div
        id="terminal-drawer-body"
        className={cn(
          "flex-1 min-h-0",
          "transition-opacity duration-[120ms] delay-[60ms] ease-out",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
      >
        <div ref={contentRef} className="min-w-0 flex">
          {active.length === 0 ? (
            <div className="flex min-w-0 flex-1 items-center px-4 py-3 font-mono text-[11px] text-muted-foreground">
              No active workflows
            </div>
          ) : (
            <div
              className={cn(
                "min-w-0 flex-1 flex gap-2.5 px-3.5 pt-3 pb-5",
                // items-stretch so every session card grows to the tallest in
                // the row — short cards (e.g. OCR) match the others' height.
                // pb-5 (20px) instead of py-3 (12px) lifts the Stop button and
                // elapsed timer off the viewport bottom edge (E2E-104).
                "overflow-x-auto overflow-y-hidden items-stretch",
                "[scrollbar-width:thin]",
              )}
            >
              {active.map((wf) => (
                <WorkflowBox
                  key={wf.instance}
                  workflow={wf}
                  reassignable={hasReassignablePeer(active, wf)}
                  queued={wf.workflow ? queuedCounts[wf.workflow] ?? 0 : 0}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CountBadge({ count, noun = "active" }: { count: number; noun?: string }) {
  const tone = count > 0 ? "active" : "zero";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[11px] leading-none",
        tone === "active"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground",
      )}
      aria-label={`${count} ${noun}`}
    >
      <span
        aria-hidden
        className={cn(
          "w-1.5 h-1.5 rounded-full bg-current",
          tone === "active" ? "motion-safe:animate-pulse" : "opacity-40",
        )}
      />
      <span className="font-mono tabular-nums">{count} {noun}</span>
    </span>
  );
}

/**
 * Collapsed-bar session summary. With nothing active it falls back to the muted
 * "0 active" badge; otherwise it breaks the active count into running /
 * authenticating / idle / failed status dots (failed first, in destructive) so
 * the operator reads session health without expanding the drawer.
 */
function SessionSummary({
  count,
  running,
  authenticating,
  idle,
  failed,
}: {
  count: number;
  running: number;
  authenticating: number;
  idle: number;
  failed: number;
}) {
  if (count === 0) return <CountBadge count={0} />;
  return (
    <span
      className="inline-flex items-center gap-2.5"
      aria-label={`${running} running, ${authenticating} authenticating, ${idle} idle, ${failed} failed`}
    >
      {failed > 0 && <DotGroup tone="failed" n={failed} label="failed" />}
      {running > 0 && <DotGroup tone="running" n={running} label="running" />}
      {authenticating > 0 && <DotGroup tone="authenticating" n={authenticating} label="authenticating" />}
      {idle > 0 && <DotGroup tone="idle" n={idle} label="idle" />}
    </span>
  );
}

/**
 * Compact per-browser health rollup for the bar — shown ONLY when a browser is
 * in trouble (failed / degraded / refreshing), so a healthy fleet adds no
 * clutter. Sits beside the daemon-lifecycle dots.
 */
function BrowserHealthSummary({
  failed,
  degraded,
  refreshing,
}: {
  failed: number;
  degraded: number;
  refreshing: number;
}) {
  if (failed === 0 && degraded === 0 && refreshing === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-2 pl-2.5 ml-0.5 border-l border-border/60"
      aria-label={`${failed} failed, ${degraded} degraded, ${refreshing} refreshing browsers`}
    >
      {failed > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-destructive leading-none" title={`${failed} browser(s) failed`}>
          <AlertTriangle aria-hidden className="w-3 h-3" />
          <span className="font-mono tabular-nums">{failed}</span>
        </span>
      )}
      {degraded > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-warning leading-none" title={`${degraded} browser(s) degraded`}>
          <AlertTriangle aria-hidden className="w-3 h-3" />
          <span className="font-mono tabular-nums">{degraded}</span>
        </span>
      )}
      {refreshing > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-info leading-none" title={`${refreshing} browser(s) recovering`}>
          <Loader2 aria-hidden className="w-3 h-3 animate-spin motion-reduce:animate-none" />
          <span className="font-mono tabular-nums">{refreshing}</span>
        </span>
      )}
    </span>
  );
}

function DotGroup({
  tone,
  n,
  label,
}: {
  tone: "running" | "authenticating" | "idle" | "failed";
  n: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground leading-none">
      <span
        aria-hidden
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          tone === "failed" && "bg-destructive",
          tone === "running" && "bg-info motion-safe:animate-pulse",
          tone === "authenticating" && "bg-warning motion-safe:animate-pulse",
          tone === "idle" && "bg-muted-foreground",
        )}
      />
      <span className="font-mono tabular-nums">{n}</span>
      <span>{label}</span>
    </span>
  );
}
