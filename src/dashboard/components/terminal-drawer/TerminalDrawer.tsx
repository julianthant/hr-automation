import { useLayoutEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowInstanceState } from "@/components/shared/types";
import { useClock } from "@/components/hooks/useClock";
import { useSessions } from "@/components/hooks/useSessions";
import { useTerminalDrawer } from "@/components/hooks/useTerminalDrawer";
import { LiveIndicator } from "./LiveIndicator";
import { WorkflowBox } from "./WorkflowBox";

const BAR_HEIGHT = 36;
const MAX_DRAWER_HEIGHT = 320;
const MIN_BODY_HEIGHT = 32;

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
  let running = 0;
  let idle = 0;
  let failed = 0;
  for (const w of active) {
    if (w.crashedOnLaunch || w.finalStatus === "failed") failed += 1;
    else if (w.itemInFlight) running += 1;
    else idle += 1;
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
      {/* Bar — clickable surface, full width. Chevron flips on toggle.
           A top border in the accent colour visually separates the bar from
           the main dashboard content above, and a subtle bg tint distinguishes
           it from the drawer body below. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="terminal-drawer-body"
        className={cn(
          "h-9 w-full flex items-center justify-between pl-4 pr-6",
          "border-accent-foreground/40",
          open ? "border-b" : "border-t",
          "text-[12px] text-muted-foreground",
          "hover:bg-foreground/5 transition-colors",
          "outline-none focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
          "select-none cursor-pointer",
          "shrink-0",
        )}
      >
        <span className="flex items-center gap-3 min-w-0">
          <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={2} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">session</span>
          <SessionSummary count={count} running={running} idle={idle} failed={failed} />
        </span>
        {/* Right edge: Live pill, then the clock. Live sits before the
            clock so the operator's eye lands on connection state first
            when scanning the screen's bottom-right corner — the clock is
            ambient and only checked on demand. */}
        <span className="flex items-center gap-3 shrink-0">
          <LiveIndicator connected={connected} viewingHistory={viewingHistory} />
          <span className="font-mono text-[12px] text-muted-foreground font-medium tabular-nums leading-none">
            {clock}
          </span>
        </span>
      </button>

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
 * "0 active" badge; otherwise it breaks the active count into running / idle /
 * failed status dots (failed first, in destructive) so the operator reads
 * session health without expanding the drawer.
 */
function SessionSummary({
  count,
  running,
  idle,
  failed,
}: {
  count: number;
  running: number;
  idle: number;
  failed: number;
}) {
  if (count === 0) return <CountBadge count={0} />;
  return (
    <span
      className="inline-flex items-center gap-2.5"
      aria-label={`${running} running, ${idle} idle, ${failed} failed`}
    >
      {failed > 0 && <DotGroup tone="failed" n={failed} label="failed" />}
      {running > 0 && <DotGroup tone="running" n={running} label="running" />}
      {idle > 0 && <DotGroup tone="idle" n={idle} label="idle" />}
    </span>
  );
}

function DotGroup({
  tone,
  n,
  label,
}: {
  tone: "running" | "idle" | "failed";
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
          tone === "idle" && "bg-muted-foreground",
        )}
      />
      <span className="font-mono tabular-nums">{n}</span>
      <span>{label}</span>
    </span>
  );
}
