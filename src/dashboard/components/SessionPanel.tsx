import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";
import { SelectorWarningsPanel } from "./SelectorWarningsPanel";

/**
 * Right rail of the dashboard. The "SESSIONS" header label + Monitor icon
 * live in the TopBar's SESSION zone now (combined with Live + Clock), so
 * this panel renders content only — no internal header divider.
 *
 * Only active sessions are shown — workflows whose process is alive AND
 * whose current batch hasn't ended (active === true OR crashedOnLaunch).
 * Previous (completed) sessions are filtered out entirely.
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

  // Only show active sessions — completed (finalStatus set) sessions are
  // filtered out completely to keep the panel uncluttered.
  const active = visible.filter((w) => w.active || w.crashedOnLaunch);

  return (
    <div className="w-[240px] min-[1440px]:w-[280px] 2xl:w-[320px] flex-shrink-0 flex flex-col bg-card overflow-hidden">
      <div className="flex-1 overflow-y-auto p-2 border-b border-border">
        {active.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1.5 py-2">No active workflows</div>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((wf) => (
              <WorkflowBox key={wf.instance} workflow={wf} />
            ))}
          </div>
        )}
      </div>
      <SelectorWarningsPanel />
    </div>
  );
}
