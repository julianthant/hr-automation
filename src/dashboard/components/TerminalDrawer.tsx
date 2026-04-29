import { Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClock } from "./hooks/useClock";
import { useSessions } from "./hooks/useSessions";
import { useTerminalDrawer } from "./hooks/useTerminalDrawer";
import { LiveIndicator } from "./LiveIndicator";
import { WorkflowBox } from "./WorkflowBox";

interface TerminalDrawerProps {
  /** SSE-backend connection state, surfaced as the right-edge Live pill. */
  connected: boolean;
}

/**
 * Bottom-docked drawer that replaces the right-rail SessionPanel. The bar
 * itself is the toggle (clicking it flips state). `Cmd+J` / `Ctrl+J` also
 * toggles, registered globally in `useTerminalDrawer`.
 *
 * Closed: 36px-tall status bar showing chevron + "session" label + active-
 * instance count. Open: 260px tall — the bar plus a horizontal scroller of
 * `WorkflowBox` cards (one per active workflow instance).
 *
 * Right edge of the bar tiles with LogPanel + LogStream's `pr-6` so the
 * Live pill / clock land at the same X as the date nav and Auto-scroll
 * button on the right side of the dashboard.
 *
 * Filter logic mirrors the legacy SessionPanel: only workflows whose process
 * is alive (or crashed-on-launch) AND whose batch hasn't ended.
 */
export function TerminalDrawer({ connected }: TerminalDrawerProps) {
  const { open, toggle } = useTerminalDrawer();
  const clock = useClock();
  const { state } = useSessions();

  // Mirrors SessionPanel filter: keep crashed-on-launch instances even
  // after pidAlive flips false so the operator learns about the failure.
  const visible = state.workflows.filter((w) => w.pidAlive || w.crashedOnLaunch);
  const active = visible.filter((w) => w.active || w.crashedOnLaunch);
  const count = active.length;

  return (
    <div
      id="terminal-drawer"
      role="region"
      aria-label="Active sessions drawer"
      className={cn(
        "terminal-drawer",
        "flex-shrink-0 bg-background overflow-hidden flex flex-col",
        // Height transition uses ease-out-expo for a snappy open. Closing
        // uses standard ease-out via the inverse transition. `prefers-
        // reduced-motion` zeroes both via the .terminal-drawer class.
        open ? "h-[260px]" : "h-9",
      )}
      style={{
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
          "hover:bg-white/5 transition-colors",
          "outline-none focus-visible:bg-white/5",
          "select-none cursor-pointer",
          "flex-shrink-0",
        )}
      >
        <span className="flex items-center gap-3 min-w-0">
          <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" strokeWidth={2} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">session</span>
          <CountBadge count={count} />
        </span>
        {/* Right edge: Live pill, then the clock. Live sits before the
            clock so the operator's eye lands on connection state first
            when scanning the screen's bottom-right corner — the clock is
            ambient and only checked on demand. */}
        <span className="flex items-center gap-3 flex-shrink-0">
          <LiveIndicator connected={connected} />
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
        {active.length === 0 ? (
          <div className="h-full flex items-center px-4 font-mono text-[11px] text-muted-foreground">
            No active workflows
          </div>
        ) : (
          <div
            className={cn(
              "h-full flex gap-2.5 px-3.5 py-3",
              "overflow-x-auto overflow-y-hidden items-stretch",
              "[scrollbar-width:thin]",
            )}
          >
            {active.map((wf) => (
              <WorkflowBox key={wf.instance} workflow={wf} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  const tone = count > 0 ? "active" : "zero";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[11px] leading-none",
        tone === "active"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground",
      )}
      aria-label={`${count} active workflow${count === 1 ? "" : "s"}`}
    >
      <span
        aria-hidden
        className={cn(
          "w-1.5 h-1.5 rounded-full bg-current",
          tone === "active" ? "animate-pulse" : "opacity-40",
        )}
      />
      <span className="font-mono tabular-nums">{count} active</span>
    </span>
  );
}
