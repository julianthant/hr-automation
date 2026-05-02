import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "../workflows-context";
import { useQueueDepth } from "./hooks/useQueueDepth";

interface WorkflowRailProps {
  workflow: string;
  /** Workflow names seen via SSE (file-on-disk discovery). */
  workflows: string[];
  entryCounts: Record<string, number>;
  onWorkflowChange: (wf: string) => void;
}

interface Group {
  label: string;
  members: string[];
}

/**
 * Display groups + ordering for the rail. Source of truth for what shows
 * in the panel and in what order — both within a group (member order) and
 * between groups (array order). New workflows that aren't in any `members`
 * list automatically fall into a final "Other" group so a missing entry
 * here doesn't hide a workflow.
 */
const GROUPS: Group[] = [
  {
    label: "Onboarding",
    members: ["onboarding", "emergency-contact", "oath-signature"],
  },
  { label: "Separations", members: ["separations"] },
  { label: "Work Study", members: ["work-study"] },
  { label: "Timekeeping", members: ["kronos-reports"] },
  { label: "Utils", members: ["ocr", "eid-lookup", "sharepoint-download"] },
];

/**
 * Vertical workflow selector — Variant C ("Status") with category groupings.
 * Replaces the workflow dropdown that previously lived in TopBar's left zone.
 *
 * Each row: 3px primary left bar (visible on active/hover), label, optional
 * queue-depth pill (yellow), and entry count badge (primary when active).
 * Group headers are short uppercase labels with the same tracking as TopBar's
 * SESSIONS label so the rail reads as part of the same chrome.
 */
export function WorkflowRail({
  workflow,
  workflows,
  entryCounts,
  onWorkflowChange,
}: WorkflowRailProps) {
  const registered = useWorkflows();
  const queueDepth = useQueueDepth();

  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const displayGroups = useMemo<Group[]>(() => {
    const knownMembers = new Set(GROUPS.flatMap((g) => g.members));
    const seen = new Set<string>();
    for (const r of registered) seen.add(r.name);
    for (const w of workflows) seen.add(w);
    const extras: string[] = [];
    for (const wf of seen) if (!knownMembers.has(wf)) extras.push(wf);
    if (extras.length === 0) return GROUPS;
    return [...GROUPS, { label: "Other", members: extras }];
  }, [registered, workflows]);

  return (
    <nav
      aria-label="Workflows"
      className="w-[200px] flex-shrink-0 bg-card flex flex-col"
    >
      <div className="flex-1 overflow-y-auto py-3">
        {displayGroups.map((group, idx) => (
          <div
            key={group.label}
            className={cn(idx > 0 && "mt-4")}
          >
            <div className="px-3 mb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group.label}
              </span>
            </div>
            <ul className="px-1.5 flex flex-col gap-px">
              {group.members.map((wf) => {
                const active = wf === workflow;
                const count = entryCounts[wf] || 0;
                const queued = queueDepth[wf] || 0;
                return (
                  <li key={wf}>
                    <button
                      type="button"
                      onClick={() => onWorkflowChange(wf)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group w-full h-10 pl-1 pr-2.5 flex items-stretch gap-2 rounded-md text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer",
                        active ? "bg-accent/40" : "hover:bg-secondary",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "w-[3px] my-1.5 rounded-r-full transition-colors",
                          active
                            ? "bg-primary"
                            : "bg-transparent group-hover:bg-border",
                        )}
                      />
                      <span className="flex-1 min-w-0 flex items-center">
                        <span
                          className={cn(
                            "text-[13px] truncate",
                            active
                              ? "font-semibold text-foreground"
                              : "font-medium text-foreground/90",
                          )}
                        >
                          {labelFor(wf)}
                        </span>
                      </span>
                      <span className="flex-shrink-0 flex items-center gap-1.5">
                        {queued > 0 && (
                          <span
                            className="px-1 py-0.5 rounded-sm bg-[#fbbf24]/15 text-[#fbbf24] text-[9px] font-mono font-semibold tabular-nums leading-none"
                            title={`${queued} queued`}
                          >
                            {queued}
                          </span>
                        )}
                        <span
                          className={cn(
                            "font-mono text-[11px] tabular-nums leading-none",
                            count === 0
                              ? "text-muted-foreground/50"
                              : active
                                ? "text-primary font-semibold"
                                : "text-foreground",
                          )}
                        >
                          {count}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
