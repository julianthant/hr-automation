import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel, type WorkflowMetadata } from "../workflows-context";
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
 * Preferred display order for category groups in the rail. Categories not
 * listed here are appended in the order they're first seen. Members within
 * each group preserve their order of registration in `useWorkflows()`.
 *
 * Workflows that omit `category` in `defineWorkflow` fall into the trailing
 * "Other" group automatically, so a missing declaration never hides a
 * workflow — just downgrades its placement.
 */
const PREFERRED_CATEGORY_ORDER: readonly string[] = [
  "Onboarding",
  "Separations",
  "Work Study",
  "Timekeeping",
  "Utils",
];

const OTHER_GROUP = "Other";

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
    return computeDisplayGroups({ registered, seen: workflows });
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

/**
 * Build the rendered group list from the registry + the SSE-discovered set.
 * Pure helper, exported indirectly via tests if ever needed.
 *
 * - Each registered workflow's `category` (declared in `defineWorkflow`) bins
 *   it into a group; missing categories bin into "Other".
 * - SSE-discovered workflows that aren't in the registry yet (race during
 *   first paint) also bin into "Other" so they never disappear.
 * - Group order: every entry in `PREFERRED_CATEGORY_ORDER` (including those
 *   with zero members today, dropped at render), followed by any newly-seen
 *   categories in first-seen order, with "Other" always last.
 * - Member order within a group: registration order from `useWorkflows()`,
 *   then any SSE-only names appended at the end.
 */
function computeDisplayGroups(args: {
  registered: WorkflowMetadata[];
  seen: string[];
}): Group[] {
  const { registered, seen } = args;
  const byCategory = new Map<string, string[]>();
  const sawOrder: string[] = [];

  const ensure = (cat: string): string[] => {
    let arr = byCategory.get(cat);
    if (!arr) {
      arr = [];
      byCategory.set(cat, arr);
      sawOrder.push(cat);
    }
    return arr;
  };

  for (const r of registered) {
    const cat = r.category ?? OTHER_GROUP;
    ensure(cat).push(r.name);
  }

  const inRegistry = new Set(registered.map((r) => r.name));
  for (const name of seen) {
    if (inRegistry.has(name)) continue;
    ensure(OTHER_GROUP).push(name);
  }

  const orderedCats: string[] = [];
  for (const cat of PREFERRED_CATEGORY_ORDER) {
    if (byCategory.has(cat)) orderedCats.push(cat);
  }
  for (const cat of sawOrder) {
    if (cat === OTHER_GROUP) continue;
    if (PREFERRED_CATEGORY_ORDER.includes(cat)) continue;
    orderedCats.push(cat);
  }
  if (byCategory.has(OTHER_GROUP)) orderedCats.push(OTHER_GROUP);

  return orderedCats.map((label) => ({
    label,
    members: byCategory.get(label) ?? [],
  }));
}
