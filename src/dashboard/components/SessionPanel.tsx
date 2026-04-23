import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";
import { SelectorWarningsPanel } from "./SelectorWarningsPanel";
import type { WorkflowInstanceState } from "./types";

/**
 * Right rail of the dashboard. The "SESSIONS" header label + Monitor icon
 * live in the TopBar's SESSION zone now (combined with Live + Clock), so
 * this panel renders content only — no internal header divider.
 *
 * Layout:
 *   1. Active sessions (top) — workflows whose process is alive AND whose
 *      current batch hasn't ended (active === true OR crashedOnLaunch).
 *   2. "Previous sessions (N)" collapsed summary — workflows whose process
 *      is still alive (daemon, or CLI run with lingering browsers) but
 *      whose batch has ended (finalStatus set). Added 2026-04-22 so the
 *      panel doesn't get cluttered by old DONE daemon sessions from
 *      earlier in the day. Click to expand.
 */
export function SessionPanel() {
  const { state } = useSessions();
  // A workflow's session (its Playwright browsers) ends when the spawning Node process
  // dies. We keep the workflow visible through the DONE/FAILED pill until then, and
  // drop it automatically once pidAlive flips to false (i.e., user closed the browser
  // / Ctrl+C'd the run / dry-run process naturally exited).
  // Include crashed-on-launch workflows even after pidAlive flips false — the
  // placeholder is how the user learns that an instance failed before any
  // browser could launch.
  const visible = state.workflows.filter((w) => w.pidAlive || w.crashedOnLaunch);

  // A session is "active" if its process is alive AND either the batch is
  // still running OR it crashed during launch (the latter gets a placeholder
  // so the user can see the failure). Everything else (pidAlive, but
  // finalStatus is set) goes into the collapsed "Previous sessions" group.
  const active: WorkflowInstanceState[] = [];
  const previous: WorkflowInstanceState[] = [];
  for (const w of visible) {
    if (w.active || w.crashedOnLaunch) active.push(w);
    else previous.push(w);
  }

  const isEmpty = active.length === 0 && previous.length === 0;

  return (
    <div className="w-[240px] min-[1440px]:w-[280px] 2xl:w-[320px] flex-shrink-0 flex flex-col bg-card overflow-hidden">
      <div className="flex-1 overflow-y-auto p-2 border-b border-border">
        {isEmpty ? (
          <div className="text-[11px] text-muted-foreground px-1.5 py-2">No active workflows</div>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((wf) => (
              <WorkflowBox key={wf.instance} workflow={wf} />
            ))}
            {previous.length > 0 && <PreviousSessionsGroup previous={previous} />}
          </div>
        )}
      </div>
      <SelectorWarningsPanel />
    </div>
  );
}

/**
 * Collapsed summary row for workflow instances whose batch has ended but
 * whose process is still alive. Click to expand and see the individual
 * WorkflowBox rows. Starts collapsed — the ended rows aren't the user's
 * primary attention anchor.
 */
function PreviousSessionsGroup({ previous }: { previous: WorkflowInstanceState[] }) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = previous.filter((w) => w.finalStatus === "done").length;
  const failedCount = previous.filter((w) => w.finalStatus === "failed").length;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors rounded"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" aria-hidden />
        ) : (
          <ChevronRight className="w-3 h-3" aria-hidden />
        )}
        <span>Previous sessions ({previous.length})</span>
        <span className="flex-1" />
        {doneCount > 0 && (
          <span className="text-[9px] text-[#4ade80]">{doneCount} done</span>
        )}
        {failedCount > 0 && (
          <span className="text-[9px] text-destructive">{failedCount} failed</span>
        )}
      </button>
      {expanded && (
        <div className="flex flex-col gap-2">
          {previous.map((wf) => (
            <WorkflowBox key={wf.instance} workflow={wf} />
          ))}
        </div>
      )}
    </div>
  );
}
